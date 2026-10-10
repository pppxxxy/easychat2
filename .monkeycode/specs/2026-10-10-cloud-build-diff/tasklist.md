# H 系：云端构建闭环 + Diff 可视化 + 回滚基线（spec 2026-10-10-cloud-build-diff）

> **状态：H1–H3 完成，H4 评估报告就绪**（2026-10-10，分支 c1009c25；测试 +13，
> 全量 2146 全通过）。
>
> **先纠正任务书一处过时信息**：任务书说「G1（推送误删 P0）仍未修，排在一切前面」
> ——G1 已在上一轮修复（`c1009c24` / `f7dda92`：三态 diff + 无基线 removed 恒空 +
> 端到端测试钉死「绝不出现 sha:null」；另发现并修复推送读截断隐患）。本系直接从
> H1 开工。

## 裁决记录落地对照（外部调研的换实现/驳回）

| 提案 | 裁决 | 落地情况 |
|---|---|---|
| JGit/libgit2 嵌库 | ❌ 不做 | 未做；理由登记（SAF 与 java.io.File 不兼容 + 推翻 C 系架构） |
| nodejs-mobile | ❌ 不做 | 未做（与 Chaquopy 重复 + 三天花板） |
| pip_install | ❌ 驳回 | 未做；BUNDLED_PACKAGES 白名单是唯一口径（见 H4 报告） |
| Monaco 完整版 | ⚠️ 降级 | ✅ H2：**轻量 WebView diff**（现有依赖 react-native-webview + 纯函数行模型） |
| L2 云构建 | ✅ 采纳 | ✅ H1 全量落地 |
| 回滚/diff 增量内核 | ✅ 吸收 | ✅ H3 本地基线快照实现 |

## H1 GitHub Actions 云构建（零原生）

- [x] restApi 四个函数（复用 request 的超时/重试/错误映射）：
      `dispatchWorkflow`（POST dispatches，204 成功拿不到 run id → 调列表轮询）、
      `listWorkflowRuns`（分页 + 归一）、`getWorkflowRun`（单 run 状态）、
      `downloadRunLogs`（**302 → 签名 URL → zip**，fetch 默认跟随重定向；fflate
      解包按 job 合并；解包失败按纯文本兜底；大日志头尾截断复用 D2 形状）。
      注：任务书说「302→文本」不准确——logs 端点是 zip（run 级），实现按 zip。
- [x] 双入口：
      面板：工具栏「触发云构建」→ workflow 输入 + 触发 + **手动刷新**状态列表 +
      点条目看日志（刻意不自动轮询：手机端省电省限流额度，写进注释）；
      agent 工具 `run_remote_build`（requiresConfirmation——远端副作用走通用确认链）
      + `get_build_log`（readOnly:true，read 模式也可用——看日志不需要写权限）。
- [x] 仓库解析：参数 `repo: 'owner/repo'` 可选——缺省扫 `repos/` 前缀，恰好一个
      仓库副本时自动用它；多/零仓库返回明确提示（`resolveRepoArg` 纯函数可测）。
- [x] AGENTS.md 记忆模板补云构建循环一行（改完 → run_remote_build → get_build_log
      读报错 → 修 → 再触发）。
- [x] 分层纪律：`ciTools.js`（定义层）零 React/网络 import（走 options.ci 注入，
      与 execTools 同款）；`ci.js`（桥）的 token 读取惰性 require storage
      （不把 AsyncStorage 拖进工具模块图）；native.js 默认注入 ciBridge。
- [x] 测试：URL/归一/zip 合并/非 zip 兜底/端到端截断（workspaceGithubApi）+ 工具
      契约与 execute 走通（workspaceCi：显式优先/单仓库推断/多仓库/无 token/无桥
      六条路径）。
- [ ] 未做（登记）：`run_remote_build` 的 workflow scope 预检（任务书提的
      「读 token scope 失败时明确引导」——现有错误映射已覆盖 403/FORBIDDEN 文案，
      scope 预检属锦上添花）。

## H2 Diff 可视化（轻量 WebView，非 Monaco）

- [x] 纯函数 `lineDiff.js`：`buildLineDiff`（行级 LCS，**超 800 行退化为整体对比
      并如实标记 truncated**——绝不假装精细）、`parseUnifiedDiff`（E5 的 unified
      文本 → 行模型）、`buildDiffHtml`（HTML 生成，**转义在此收口**，深浅两套主题）。
- [x] `DiffView.js`：WebView 渲染（惰性取 react-native-webview——与 RichHtmlMessage
      同款可选能力，缺失时给一行文字提示）；`javaScriptEnabled={false}`（纯静态
      HTML，无脚本面）。
- [x] 入口①（真实接线）：E5 commit 详情从纯文本升级为 DiffView 行级着色。
- [ ] 入口②（推送确认框展开看 diff）：**二期**。理由：confirm 回调是
      Alert 形态（放不下列表），升级需要自绘面板 + 把 collectRollbackEntries
      时机挪到确认前（会为取消操作白拉远程内容）——独立迭代更稳，不与 H3 的
      「确认后才拉」纪律冲突。
- [ ] 入口③（文件面板任意文件「与远程比对」）：**二期**（同上：需要 manifest sha
      + getBlobRaw + 面板层选择器，组成独立迭代）。
- [x] 明确不做：Monaco assets / IntelliSense / 多标签编辑器 / xterm.js。
- [x] 测试：LCS 边界（空/全删全增/无尾换行/超限退化）、unified 分类与计数、HTML
      转义（无注入）/双主题/统计头。

## H3 推送前基线 + 一键回滚（本地轻量实现）

- [x] `repoPush.js`：`collectRollbackEntries`——**推送前**（确认后、提交前）拉
      diff.modified + diff.removed 的**远程旧内容**（getBlobRaw，Accept: raw）；
      三重限额（50 文件 / 单文件 1MB / 总量 5MB），超限只记 sha + reason——
      回滚入口如实提示「不可自动恢复」；**旁路不重试**（retryDelays: []——失败
      记账即可，别让推送白等 1+2+4s）。
- [x] `rollbackBaseline.js`：`.easychat/rollback/<ts>.json`（自包含 owner/repo/
      branch/commit——恢复时据此重建前缀）；**保留最近 3 份**（写后轮换删最旧）；
      `applyRollbackSnapshot` 带前缀写回 + 单条失败记账不中断。
- [x] GithubPanel：推送成功写快照 + 轮换；「回滚最近一次推送」按钮（快照存在才
      显示）→ 确认（恢复 N 个 + 未存 M 个如实说明）→ 恢复本地 → 提示后由用户
      自行点推送同步远端（**不自动弹推送**，避免连环弹窗）。
- [x] 测试：collectRollbackEntries 三类记账 + 文件数上限；快照构造/解析/挑选/
      轮换（5 份 → 留 3）/IO 往返/恢复（成功+失败+不可恢复三态）/旁路不抛错。

## H4 Python 包白名单渐进扩充（评估报告就绪，未动代码）

- [x] 评估报告：`h4-python-packages.md`（本目录）——各包 APK 增量估算区间 +
      测量方法 + 建议优先级；**增量数字必须构建实测后才可拍板**（诚实标注）。
- [x] 铁律复核：机制已有（BUNDLED_PACKAGES 双清单同步 + 漂移测试）；不动机制。
- [ ] 待用户裁决：加哪些包（按报告表勾选后，走白名单扩充 + 构建实测）。

## 门禁与登记

- 五门禁全绿（全量 2146 通过）；纯函数 Node 直测先行（Actions 参数构造 / LCS /
  unified 解析 / HTML 转义 / 回滚快照全为纯函数）。
- i18n 新词条对账通过（构建区 14 条 + 回滚 7 条 + diff 1 条，中英同步）。
- spec 登记本目录；能力清单（capabilities.js）同步两个 CI 工具；
  AGENTS.md 模板同步云构建循环。
- 真机验收路径见 design.md 末节。
