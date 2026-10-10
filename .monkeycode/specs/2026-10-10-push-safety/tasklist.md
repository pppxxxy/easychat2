# G 系：推送删除安全修复 + 拉取跳过可见性（P0，spec 2026-10-10-push-safety）

> **状态：G1–G3 全部完成**（2026-10-10，分支 c1009c24；测试 +4，全量 2133 全通过）。
> 触发场景（用户实测截图）：拉取 easychat2 → 1049 文本入库、20 个二进制被跳过 →
> 点「推送」→ diffRemoteLocal 把 20 个从未落地的文件判为删除 → 确认后 GitHub 分支
> 真删 20 个文件。**P0 数据损失风险**。

## 代码事实基线（c1009c23 已逐条核对）

- ✅ `repoPush.js` diffRemoteLocal：`removed = 远程有 ∧ 本地无`——**未考虑「从未物化」
  第三态**，此即本 BUG（已实锤 L115）。
- ✅ `scanRepoZipball` / `extractRepoFiles`：跳过**只计数不留清单**
  （skippedBinary / skippedSlip / skippedOversize / skippedDirs）。
- ✅ 基线已存在：`storage/workspace.js` getRepoSnapshot/setRepoSnapshot 存 `{ paths }`；
  拉取/推送成功后都刷新（GithubPanel 四处接线），paths 含 `repos/<owner>/<repo>/<branch>/` 前缀。
- ✅ 远程条目未改动时沿用远程 sha 传递 → 被跳过文件只要不进 removed 天然原样保留
  （修复点收敛在 diff 一处 + 宿主注入基线）。
- ✅ 拉取弹窗已展示「二进制/超大/可疑路径/目录」四类计数。
- ⚠️ **核对发现（任务书未提，一并修）**：`pushRepoSnapshot` 读本地文件不传 maxChars
  → 默认 1MB 截断 → >1MB 文件会被**静默推成半截**（sha 判 modified → 上传截断内容）。
  G3 放宽文本线后这是必然踩中的雷，读取上限（8MB）与截断记账同批修复。

## G1 推送删除安全（P0）

- [x] `diffRemoteLocal` 加第三参 `knownPaths` + `prefix`（剥离宿主传的前缀）：
      `removed = 远程有 ∧ knownPaths 有 ∧ 本地无`——只有「**曾经物化过而现在没了**」
      才算删除；known 自动并入本次本地文件（防御基线滞后窗口）。
- [x] 无基线（旧会话/手工拷入/基线丢失）→ known 只剩本地并集 → **removed 恒空**。
- [x] `pushRepoSnapshot` 签名加 `baselinePaths`（宿主读基线注入，repoPush 不碰存储层
      ——保持纯逻辑模块的 Node 可测性）；GithubPanel 推送前 getRepoSnapshot 读数注入。
- [x] **读取上限配套修复**：`PUSH_READ_MAX_CHARS = 8MB`；读不全（truncated）的文件
      不参与本次推送（不 added/modified/removed——不动它）+ `skippedTooLarge` 记账
      + 完成提示如实展示。
- [x] 测试：diffRemoteLocal 三态/前缀剥离/无基线 fail-safe；**端到端复现**
      （远程含被跳过的二进制 + 增量新增 → 断言树条目原样沿用远程 sha、
      **绝不出现 sha:null**）；既有集成测试注入基线后语义对齐。

## G2 跳过清单落盘 + 可见（P1）

- [x] `scanRepoZipball` / `extractRepoFiles` 返回 `skipped: [{ path, reason, size? }]`
      （reason: binary / oversize / suspicious；`SKIPPED_LIST_MAX = 1000` 条防爆）。
- [x] `.easychat/pull-skipped.json`（覆盖式）：`buildPullSkippedPayload` 纯函数 +
      read/write 薄壳（绝不抛错）；**成功路径才写**（与 clearPullManifest 之后同段）。
- [x] GithubPanel 拉取区「查看跳过清单（N 个）」入口（挂载时读回，跨会话保留）；
      `formatSkippedList` 纯函数格式化（原因 + 路径 + 大小，超长截断如实报数）。
      agent 同样可用 read_workspace_file 读清单（不再盲猜仓库里有什么）。
- [x] 测试：payload 构造容错（空路径丢弃/未知 reason 收敛/无 size 不写字段）、
      文本格式化、IO round-trip 与旁路不抛错、明细顺序与原因。

## G3 超大文本物化（P2）——**决策：做**（依据如下）

- 现存限制：`MAX_FILE_BYTES = 1MB` 同时拦二进制与超大文本。
- **决策依据**：① store 写入侧**无**长度限制（`writeAsStringAsync` 直写）；
  ② 读取侧 1MB 只是**预览默认值**，offset 分页本就支持任意大文件；
  ③ 推送读取上限已在 G1 配套修复（8MB）；④ 编辑工具 4MB 拒绝线已存在（如实拒绝）。
  结论：**文本线放宽到 5MB**，二进制线维持 1MB 不变（agent 用不了二进制，白占空间）。
- [x] `REPO_IMPORT_LIMITS.MAX_TEXT_FILE_BYTES = 5MB`；scan/extract 两处判定按
      `isTextWorkspaceFile` 分档（声明值 + 解出值双重校验都分档）。
- [x] 测试：1MB+ 文本落盘且**内容完整不截断**；5MB+ 文本仍跳过（reason oversize）；
      二进制 1MB 线不变。

## 明确不做

- 不做二进制文件拉取（文本沙盒定位；agent 用不了，白白占 SAF 空间）。
- 不做断点续传（F4 已裁决：重跑幂等，复杂度不值）。

## 验收（本仓库可复测）

- 拉取 → 不做任何本地改动 → 推送：removed 恒空（无 sha:null 条目）——端到端测试覆盖；
  真机可在 GitHub 面板看推送确认框「删除 0 个」。
- 拉取 → 手动删本地某文件 → 推送：该文件进 removed 且远程被删（既有集成测试覆盖）。
- 拉取后「查看跳过清单」可见具体路径 + 原因 + 大小；`.easychat/pull-skipped.json`
  可用 read_workspace_file 读。

## 补全：可见性与超时语义（2026-10-10，分支 z1010z1）

> 触发：外部审查报告（基于旧同步）报了 P0 + 4 个 P1，经**独立核实**后执行。
> 先记核实结论（避免下一轮重复劳动）。

### 核实结论：报告的前提已过时

- **P0（推送误删）在本轮工作开始时已修复**——就在本 spec 的 G1（`f7dda92`），
  只是报告依据的 main（`d165ba3`）早于它被并入 main（`73cb7be`）。**非未修，是已修**。
- 报告担心的「manifest 很可能是全量清单（含未物化条目），按它说的改仍会误删」：
  **不成立**。本实现根本不用 manifest 做判定——基线快照来自 `store.listWorkspaceFiles()`
  的**实际本地文件列表**（物化口径），未物化的文件天然不在其中。
- 报告建议的另外两条也已在 G1 兑现：无基线 → removed 恒空（fail-safe）、
  读取上限 8MB（`PUSH_READ_MAX_CHARS`，防半截推送）。

### 本轮实际补的三项

- [x] **G1 可见性：diff 第四态**——`diffRemoteLocal` 增报 `remoteOnly`（远程有、
      本地未物化，本次保持原样）与 `knownRemoteCount`（有资格进 removed 的总数，
      作为「删除量异常」的分母）；两者都不进 pending（不产生树改动）。
- [x] **确认弹窗安全网三要素**：①「永久删除、本地无备份」警示（只说「删除 3 个」
      用户意识不到不可逆）；② remoteOnly 保持原样的数量（不给这行，用户会把
      「没看到」误当「它不在了」）；③ **删除量 > 可删总数一半 → 二次确认**
      （误判通常成片出现）。另：无基线时弹窗明说「本次不执行删除」——
      否则用户分不清「没有要删的」与「因为没基线所以不删」。
      `pushRepoSnapshot` 把 `baselineMissing` 一并交给 UI。
- [x] **列表截断告警（G1.7）**：`listTruncationNotice` 纯函数——命中文件数上限
      （2000）或深度上限（12 层）时在工具输出里附一行「本列表可能不完整」；
      工具描述同步写明上限。静默截断的清单会被当成完整事实推理，是误删类事故的放大器。

### G2 工具超时语义

- [x] 超时文案改为**结果未知**口径：「工具 X 执行超过 N 秒，已放弃等待——结果未知：
      操作可能已经生效。先用只读工具确认实际状态，再决定是否重试；不要盲目重跑写操作。」
      **禁止暗示「失败/未执行」**——JS 停不掉在途 promise，写操作可能已生效，
      模型看到「失败」会直接重试 = 重复副作用。
- [x] `TOOL_TIMEOUT_TIERS` 分级表（策略常量，可审计）：纯读 15s / 写副作用 60–120s /
      长任务（子代理）300s；通则「工具层超时 > 执行器自身兜底」（shell/python 看门狗各 30s）。
- [x] 不做 promise 强制取消（JS 做不到）；run_shell/run_python 的进程级兜底不动。

### G3 压缩链路：三条经核实**均不成立**（未改代码）

- **防抖**：`ChatScreen.js` 已是 `compactBusyRef`（ref）守卫，state 只作 UI 显示——
  报告的「state 闭包旧值竞态」是旧同步视角。
- **链路**：压缩走 `sendChatMessage`（`network/api.js` 的网络层），**不是** useChatSend
  的全链路 → 不触发会话统计 / webSearch / hooks 副作用。报告担心的污染不存在。
- **字段**：群聊归属用的是 `speakerId`/`speakerName`（`MessageList.js`），
  消息级没有 `characterId` 这个约定——「摘要缺 characterId」是按错误的字段名提的。

### 未做（保留判断）

- 报告 G1.6「推送前置校验：removed 出现『远程存在 ∧ 从未记录』则中止」：
  **结构上不可能发生**（removed 要求 `known.has(path)`），加一段永远不执行的防御代码
  只会掩盖真实不变量。改为在本 spec 记明这条不变量。
- 报告 G2 的「超时分级表落 AGENTS.md」：分级表落在代码常量 + 本 spec（可审计、可测试）；
  AGENTS.md 是用户/agent 的工作区记忆文件，把实现细节写进用户文件反而混淆。

### 验证

- 测试 +4（repoPush 第四态矩阵、store 截断告警、registry 超时语义与分级表、
  panel 确认弹窗安全网结构守卫）；全量 **2167 通过**、覆盖率 81.29%、五门禁全绿。
- **注入验证 4 处**（均确认变红后还原）：diff 不报第四态 / 截断告警恒空 /
  超时文案退回旧口径 / 二次确认判据写死为 false。
