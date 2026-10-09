# GitHub 集成改造 C 系（清单先行 + 按需物化 + 批量单提交）

> 来源：外部分析建议「砍快照改纯远程文件系统」。审核助手代码核实：**N+1 前提不
> 成立**（拉取是单次 codeload zip，实测 6MB 一包出 1025 文件）、**AsyncStorage
> 前提不成立**（工作区走 SAF，6MB 只影响消息持久化）；本地副本是 run_shell /
> grep / 终端 / 子代理 / 离线工作的地基，**不砍**。采纳其合理内核：懒加载边缘 +
> Trees API 批量提交 + 传输健壮性。
>
> **两处实现修正**（防跑偏）：
> ① `truncated` 时不「逐层拉子树」降级——手机端限流风险大且属极端场景，改为
> 如实提示 + 建议完整拉取（测试钉住「不假装拿全」）；
> ② C1 清单与 F4 pull-manifest **分文件**（语义不同：长期缓存 vs「成功即删」的
> 临时信号；合并会打架），共享同一套 IO 薄壳与 `.easychat/` 域。

## 已完成（分支 c1009c21）

- [x] **C4 传输健壮性**：`request` 统一超时（JSON 15s / zip 90s，AbortController）
      + 可重试错误退避（429 / 403 限流 / 5xx / 网络断流：Retry-After 优先、封顶
      30s、退避 1s/2s/4s、最多 3 次）；`mapGithubError` 加 `retryable` /
      `retryAfterMs`；`downloadZip` 断流整包重试 1 次；拉取链路全部切到 C4 基建。
- [x] **C1 清单先行**：`listTree`（`git/trees?recursive=1`，truncated 如实标记）；
      清单落盘 `.easychat/repos-manifest/{owner}__{repo}__{branch}.json`
      （三段 encodeURIComponent——branch 含 `/` 不造假目录）；面板「快速检出」
      按钮（1 次 API 秒开全树）+ 树合并（本地 ∪ 清单，未物化条目云朵角标）+
      清单设为「已同步」基线（与完整拉取同语义）。
- [x] **C2 按需物化**：`repoMaterialize.js`（纯函数：路径解析 / URL / 手写
      base64→UTF-8 / contents 响应提取；IO 薄壳：单文件拉取写沙盒，复用 C4 的
      request）；面板 `openFile` 点开即拉（仅云朵文件；失败如实报，>1MB 指引
      完整拉取）；`read_workspace_file` 透明物化（宿主注入 `materializer`；
      三道前置：repos 路径 / 有清单 / 在清单里——不满足零网络；没注入 =
      旧行为逐字节一致）。

## 已完成（第二批）

- [x] **C3 批量单提交回推**：`repoPush.js`（手写 SHA-1 纯函数，与 Node crypto
      对拍；git blob sha 判内容改动——本地算、远程比；三态 diff）+ restApi 五个
      写 API（getRef / createBlob / createTree / createCommit / updateRef，全部
      走 C4 基建）；面板「批量推送」按钮 → **一次确认框**（新增/修改/删除 + 清单）
      → **单次原子提交**；blob 只发新增+修改（未改沿用远程 sha、并发 5 带 jitter）；
      删除 = `sha:null` 条目；**truncated 仓库直接拒绝**（完整树会误删看不见的
      文件）；`updateRef` 恒 `force:false`（ref 冲突非快进被 GitHub 拒绝，安全失败）；
      成功刷新基线为本地清单。保留 `handoffPush` 逐文件精细模式（降为备选）。
- [x] **materialize_repo 工具**：批量物化清单内未物化文件（readOnly；单次上限
      25，剩余量如实报告可再调、幂等）；提示词只在 write 模式且工具真注册时注入
      （「跑 shell 搜 repos/ 前先物化」）；capabilities / 工具清单四处断言同步。
      **分层修正**：路径与清单解析规则抽到零依赖 `repoPaths.js`——工具定义层的
      静态链不得拖 fflate（分层测试用加载炸弹钉着，两处 re-export 保持引用面）。

## 验收对照

- C3：50 文件改动 = N 次 blob（并发 5）+ 4 次 API + **1 次确认 + 1 个 commit** ✅
  （测试钉：blob 只发新增+修改、删除为 sha:null、父提交、绝不 force、取消零写）；
- C1/C2：快速检出 <3s 见全树（1 次请求）；合并函数三形态直测；按需物化三条
  前置（repos 路径 / 有清单 / 在清单里）不满足零网络。

## 明确不做（防后续重复评估）

1. 砍本地副本转纯远程文件系统（全树 grep = 1025 次 API × 限流，agent 跑不起来）；
2. SQLite 替换存储（工作区走 SAF，与 AsyncStorage 6MB 无关）；
3. N+1 优化（不存在 N+1：单次 codeload zip）。
