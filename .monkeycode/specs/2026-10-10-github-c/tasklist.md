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

## 待做（下一轮）

- [ ] **C3 批量单提交回推 `push_snapshot`**：`createBlob`（base64，并发 5 带
      jitter，走 C4 退避）→ `createTree`（base_tree = 远程当前 tree）→
      `createCommit` → `updateRef`；本地 vs 远程 tree 求差（需 git blob sha1
      纯函数）→ 一次确认框（新增 X / 修改 Y / 删除 Z）→ 单次原子提交；保留
      现有 `handoffPush` 逐文件精细模式；ref 冲突（409/422）安全失败，绝不
      自动覆盖重试。验收：50 文件 = ≤55 次请求 + 1 次确认 + 1 个 commit。
- [ ] `materialize_repo` 代理工具（agent 跑 shell 前主动物化）+ 提示词一句 +
      capabilities 清单同步（走 registry + riskGate 双保险门控）。

## 明确不做（防后续重复评估）

1. 砍本地副本转纯远程文件系统（全树 grep = 1025 次 API × 限流，agent 跑不起来）；
2. SQLite 替换存储（工作区走 SAF，与 AsyncStorage 6MB 无关）；
3. N+1 优化（不存在 N+1：单次 codeload zip）。
