# W 批：工作区图形界面对齐（spec 2026-10-10-workspace-gui-parity）

> 对照对象：开源版 ZCode（`packages/web` Vite + `packages/desktop` Electron + `packages/ui` 共享组件，
> 外加 `packages/rpc` / `packages/services` 分层；本机副本在 `/tmp/zcode-oss`）。
> 本批基于 `z1010z5`。
>
> **前提（决定规划形状，不是免责）**：ZCode 的图形界面是**桌面级 IDE 形态**（Electron 多窗格、
> 拖拽缩放、Cmd+K 命令面板、xterm.js PTY、外接编辑器）。我们是**移动端单屏 RN 应用**。
> 所以差距分三类：① 平台无关、该补的；② 我们自己两处保真度不一致、该收口的；
> ③ 桌面固有形态、**不追**的。规划只做 ① 和 ②。

## 一、结论速览（按性价比排序）

1. **最值钱的一件事：工作区聊天没有「行」的概念。** 工具调用只有一行瞬时状态
   （`ChatPanel.js:1173-1189`），气泡是纯 `Text`（`:1422`）。ZCode 的整个价值感来自
   「按工具族渲染的卡片 + 内联 diff + 可折叠输出」。补这一层能同时解锁：看得见 agent 在干什么、
   本次改了什么、压缩发生在哪一步、子代理跑到哪了——**先做投影，再做卡片**。
2. **四件便宜的内部不一致**（我们自己两处做得好、一处没做）：工作区气泡无 Markdown/代码块、
   工作区 plan 不落盘、上下文占用两处口径不同、工作区 agent 没有 GitHub 工具（而 UI 文案让模型
   去用它们）。
3. **移动端真正缺的便利**：输入区常驻占用条、「本次改了什么」回合小结抽屉、Files 面板内搜索、
   会话重命名/搜索、长任务完成通知。这些在手机上比桌面快捷键更关键。
4. **不追**：多栏拖拽缩放、命令面板、xterm PTY、外接编辑器、VS Code 式顶部标签条、
   整轮 rewind 的桌面审阅队列。终端流式要新原生模块，排在最后（真机才能验）。

## 二、现状基线（z1010z5 已逐条核验）

工作区 = **单 Modal 单屏**：左侧 76px rail（chat/files/github/terminal/settings）+ 单面板，
任一时刻至多一个面板（`WorkspaceScreen.js:31-37`、`:140-165`；`guard-structure.mjs:74-104` 钉住）。

已核验的差距点（file:line）：

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | 工作区气泡纯文本，无 Markdown/代码块/思考 | `workspace/screen/ChatPanel.js:1422` |
| 2 | 工具调用只有瞬时状态行，结果/diff/输出不进聊天 | `ChatPanel.js:1173-1189`、`:1484-1489` |
| 3 | MCP 工具只注册在角色聊天，工作区 agent 没有 | `chat/useChatSend.js:604` vs `workspace/native.js:84-95`、`workspace/tools.js:134` |
| 4 | 工作区 plan 不落盘（没传 `onPlan`） | `ChatPanel.js` 无 onPlan；对照 `useChatSend.js:593` |
| 5 | 终端一次性返回、无流式（原生模块无事件发射） | `screen/TerminalPanel.js:3-10`、`workspace/shell.js:114` |
| 6 | 上下文占用两处口径不同（工作区会话 vs 角色单聊） | `ChatPanel.js:358-379` vs `screen/FilesPanel.js:162-194` |
| 7 | 后台运行登记表存在但工作区未接 | `agent/runtime/sessionRuns.js`；仅角色聊天接 `RunningRunsBar` |
| 8 | 行数棘轮顶格，任何新功能必须先外提 | `architecture-baseline.json`：GithubPanel 1984/1984、ChatPanel 1851/1851、FilesPanel 1579/1580 |
| 9 | 工作区与角色聊天是**两套并行发送路径** | `ChatPanel.handleSend` 内联 `runAgentTurn` vs `chat/useChatSend.js`（1991 行） |

## 三、差距（三条轴）

### 3.1 功能

| 能力 | ZCode | 我们（z1010z5） | 判断 |
| --- | --- | --- | --- |
| 工具调用渲染 | ~60 个按工具族的渲染器，内联 diff、终端输出、可折叠、子调用左轨 | 仅一行状态文字 | **最大缺口**，平台无关 |
| Markdown/代码块/思考 | streamdown + cjk/code/math/mermaid + 折叠思考计时 | 工作区纯文本（角色聊天有） | 内部不一致，便宜 |
| diff 审阅 | 内联 hunk 首帧 + 全量 diff 查看器 + 整轮文件 rewind 预览 | `DiffView`（WebView 行 diff）只用在文件历史与提交 diff 两处 | agent 改动**看不见** |
| 终端 | xterm.js 真 PTY + 后台 bash 输出面板 + 侧栏标签 | 一次性 `sh -c`，无流式，SAF 根下禁用 | 平台硬仗，排最后 |
| 权限审批 | 聊天内联卡片（渲染该工具调用本身）+ 批准/总是批准/拒绝/总是拒绝 + 规则范围展示 | 原生 Alert 三键（含 ask 档）+ 设置页可手写规则 | **我们规则管理更强**，UI 呈现更弱 |
| plan/todo | 卡片 + 右侧状态面板（目标/计划/待办/后台/工作流/子代理分节） | 折叠清单，**不落盘**（切面板即丢） | 落盘一行的事 |
| 会话管理 | 置顶/重命名/归档/分组/拆窗格/fork/整轮 rewind/会话搜索 | 新建/列表/切换/删除/归档/草稿；无重命名、无 fork/rewind | 重命名/搜索便宜 |
| 上下文与压缩 | 输入区工具栏（百分比/token/分段/缓存命中率）+ 时间线压缩分隔行 | 占用条只在设置页；无压缩标记 | 移动端更该常驻 |
| 子代理 | 目录面板 + 只读旁观子会话 + 状态面板可取消 | 只有 `run_subagent` 工具，**零 UI** | 有 `sessionRuns` 可复用 |
| MCP/技能/插件 | 各自设置页 + 插件商店 | 技能/命令/hooks 只读列表；**MCP 无 UI 且工作区不可用** | 功能性空洞（见 3.1 #3） |
| 文件编辑 | 无内置编辑器（只读预览 + 外接编辑器） | 无编辑器，可新建/删除/导入，**不能改名/改内容** | 两边都无编辑器；我们缺改名 |
| 长任务通知 | OS 通知 + 声音 + 应用内后台工作面板（可取消） | **完全没有** | 移动端最该补 |
| GitHub 工作台 | git pane / 分支切换 / git graph / 提交与推送对话框 | 仓库树/检出/ZIP 拉取（带进度 ETA）/分支/批量推送/PR/CI 运行与日志/提交 diff/回滚 | **我们明显更强** |

### 3.2 结构

ZCode：**运行时在宿主进程**（CLI/server），渲染层只持 UI 投影；中间有 `ConversationTransport`
（订阅/重同步/行区间/文件变更/rewind 预览）与命令信封 + ACK（`pendingCommandRegistry`），
~40 个服务的访问器，Zustand 按域拆 store。UI 是**会话流的纯投影**。

我们：单进程；**面板自己持 state 并直接调服务**（ChatPanel 1851 行里内联 `await runAgentTurn`）；
工作区面板与角色聊天是**两套并行发送路径**（`ChatPanel.handleSend` vs `chat/useChatSend.js`）；
存储有后端抽象（`store.js` / `safStore.js`）——这点是对的；`agent/runtime/sessionRuns.js`
（L 系做的登记表）存在但工作区没接。

结构上的真问题只有两条，但都是根：

- **缺「会话投影」这一层。** 没有它，工具卡片/压缩分隔行/回合小结/子代理行/rewind 标记都要
  各自从消息数组里现算，功能越多越乱。
- **两套发送路径。** 与 Z 分支刚做完的去重（两套阈值、两套微压缩、两个队列）是同一类病：
  同一件事两处实现，改一处忘一处。本轮刚在 `sessionCompaction.js` 上收口过一次，
  发送路径是下一个。

### 3.3 图形化操作便利程度

ZCode 强在键盘与多窗格：Cmd+K 命令面板（带搜索历史与中文关键词）、可重绑快捷键（带冲突检测）、
多窗格拖拽缩放 + 窄窗自动收起、拖文件进输入框、拖会话进窗格拆屏、@ 提及（文件/技能/命令/子代理/会话）、
选中文本「加入对话/侧边追问」、消息内联编辑、未读徽标、主题与字号缩放、每回合文件小结面板。

我们强在移动端该有的：单屏不迷路（rail + 单面板，设计文档明确「面板单开原则」）、
斜杠命令建议条、附件（图片/文本/语音转写）、运行中 steering、跨面板交接（GitHub「让助手推送」→
输入框；聊天「查看已创建的文件与历史改动」→ 文件面板；设置页 → 文件面板深链）、终端 ↑/↓ 历史。

移动端**该补**的便利（不追桌面形态）：
- 输入区常驻上下文占用条 + 压缩提示（现在只在设置页；`SESSION_COMPACT_HINT_RATIO` 已有）
- 「本次改了什么」回合小结抽屉（改动文件列表 + 逐文件 diff + 撤销；`FileHistorySheet` 已有底子）
- Files 面板内搜索（GitHub 树有搜索，Files 没有——同一屏内不一致）
- 会话重命名 + 会话内搜索（现在只能按自动标题认）
- 长任务完成/需要审批时的通知（移动端切后台才是常态）
- 文件 @ 提及（把「路径」从打字变成选择）

**不追**（会与平台打架，收益还低）：多栏拖拽缩放、命令面板、xterm PTY 全屏程序、
外接编辑器、VS Code 式顶部标签条、拖拽排序/拖会话拆屏、per-hunk accept/reject 审阅队列。

## 四、我们反而领先的（别在重构里抄丢）

- **GitHub 工作台**：手机上没有 git 二进制，我们用 REST + Trees API 做到了仓库树、带 ETA 的
  ZIP 拉取、批量单提交推送、PR、CI 日志、提交 diff、回滚基线。ZCode 依赖本机 git。
- **权限规则可手写 + `ask` 档**：ZCode 只有「总是批准」时顺带展示规则范围，**没有规则管理页**。
- **文件历史快照可逆恢复**：ZCode 没有 per-hunk 接受/拒绝，只有整轮 rewind 与 git 提交。
- **双后端工作区**（应用私有根 / SAF 外部文件夹）+ 能力门控（shell/python 外部根禁用）。

## 五、规划

流程照老规矩：开 `z1010z6`（基于 z1010z5），每阶段五门（lint / guard:structure / test /
test:coverage / expo export）+ 注入验证，`--no-ff` 合 main 前要单独授权。
**行数棘轮是硬约束**：W1 必须先外提，否则后面什么都塞不进 ChatPanel。

### W1（根）工作区会话投影 + ChatPanel 拆分
- 新增 `src/workspace/conversation.js`（或 `src/chat/timeline.js`）：纯函数把
  「消息数组 + 工具事件 + 计划 + 压缩事实」投影成**行**：`user | assistant | tool | plan |
  compaction | notice`。行的字段固定，渲染层不猜。
- ChatPanel 渲染从「遍历 messages」改为「渲染行」；顺带把工具事件收集、回合小结、
  发送流程外提成子模块（棘轮要求：ChatPanel 必须降到基线以下）。
- 验收：投影纯函数 Node 直测（含 tool 配对、压缩标记、计划行）；ChatPanel 行数下降并**同步下调基线**；
  现有 2458 测试不回归。
- 风险：低（纯逻辑 + 等价渲染）。

### W2 工具卡片（看得见 agent 在干什么）
- 按工具族渲染：`write/edit` → 路径 + 内联 diff（复用 `DiffView`）+ 成功/失败；`read/search` →
  路径 + 命中数；`run_shell/run_python` → 命令 + 输出（默认折叠，长输出落盘指针）；
  `update_plan` → 清单；`run_subagent` → 子会话摘要 + 可展开。
- 落点：`src/workspace/toolCards/`（每族一个纯投影 + 一个渲染组件）。
- 验收：每族一条投影测试；注入验证（把某族卡片去掉 → 断言红）。

### W3 四件内部一致性（便宜、收益直接）
1. 工作区气泡换 Markdown/代码块/思考（复用角色聊天已有渲染组件，别再写一套）。
2. 工作区 plan 落盘：传 `onPlan`（复用 `storage/sessionPlan.js`）+ 切面板恢复。
3. 上下文占用单一口径：抽一个函数，`ChatPanel` 与 `FilesPanel` 都调它（现在两处算法不同）。
4. 工作区 agent 的 GitHub 工具：**要么**给工作区 agent 注册 MCP github 工具，**要么**改掉
   「让助手推送」的文案与 `repoImport.js` 的注释——现在是死路（文案让模型用不存在的工具）。

### W4 移动端操作便利
- 输入区常驻占用条 + 压缩提示；「本次改了什么」回合小结抽屉（列表 + diff + 撤销）；
  Files 面板内搜索；会话重命名 + 会话内搜索；未读徽标；文件 @ 提及。

### W5 后台任务可见性
- 把 `agent/runtime/sessionRuns.js` 接进工作区：正在跑/需要审批的会话条（复用角色聊天的
  `RunningRunsBar`）+ 长任务完成通知（`expo-notifications`，切后台场景）。

### W6（可选，平台硬仗，最后做）终端流式
- 需要新原生模块（事件发射逐行回显）+ 真机验证；`TerminalPanel.js:3-10` 已如实标注边界。
  建议单独一支，且明确「验不了就不宣称能」。

### W7 本地 git 内核（用户 2026-10-10 追加提问：我们要不要补 git）

**先划清「补什么」**：不是再补一个 GitHub 客户端（工作区已有 GitHub 面板，REST + Trees API
能做仓库树/检出/批量推送/PR/CI/提交 diff/回滚）。缺的是**本地版本控制内核**——Android 上没有
git 二进制（`/system/bin` 里没有），无 root 也装不了，所以 `run_shell` 调不到 git，
agent 至今**没有任何办法把「我改了什么」变成一份可回滚的历史**。

**为什么值钱（三条，按重要性）**：
1. **回合检查点**：每轮工具循环结束自动本地 commit，整轮回滚变成 `checkout <sha> -- .`。
   这补的正是现在最实的漏洞——`fileHistory.js` 的快照**明确不覆盖 `run_shell` 改的文件**
   （`FileHistorySheet.js:11-12` 自己写着），而 git 检查点覆盖。
2. **agent 能看自己的改动**：`git_status`/`git_diff`/`git_log` 让模型在改之前先看现状、
   改之后自查，而不是靠把文件整篇读回来。
3. **离线历史**：提交/日志/回滚不需要网络与 token。

**三条实现路径（这是决策核心）**：

| 路径 | 优点 | 代价 | 可 Node 直测？ |
| --- | --- | --- | --- |
| **isomorphic-git（纯 JS）** | 无原生构建；`buffer` 已在依赖（`package.json:23`）；可跑在我们的 store 之上 | Hermes 上的性能（大仓库 `statusMatrix`/`log` 慢）、打包体积、需验 TextEncoder | **能**（决定性优势） |
| JGit（Kotlin 原生模块 + jar） | 原生速度、git 语义最正 | 新加 Gradle 依赖；只能真机 APK 验（同 shellExecutor/python 的痛） | **不能** |
| libgit2（NDK） | 最完整 | 交叉编译 C，最重 | 不能 |

推荐 **isomorphic-git**：本仓的纪律是五门 + 2458 测试，一个**能在 Node 里直测**的纯 JS
实现，比一个只能真机验的原生模块值太多。适配器工作量可控——`store.js` 的 fileSystem 接口已有
`readAsStringAsync` / `writeAsStringAsync` / `readDirectoryAsync` / `makeDirectoryAsync` /
`moveAsync` / `deleteAsync` / `getInfoAsync`（`store.js:25-196`），还缺 `stat` 带 mode、
`symlink`、文件级 `rename`；symlink 可以先**声明不支持**（我们自己建的仓库不会有 120000 条目）。

**硬约束（写进能力卡，不含糊）**：
- 只在**应用私有沙盒根**可用；SAF 外部文件夹不行（`content://` 撑不起 `.git` 的原子重命名与
  锁语义）——门控方式与 shell/python 完全一致（`native.js:105-124` 已有先例）。
- 大仓库/深历史在 JS 引擎上会慢：限制文件数与历史深度，按需触发，不后台常扫。
- **不做「任意仓库 clone/push」的承诺**：那是 GitHub 面板现在的活，替换要单独论证。

**最关键的一条纪律：不要再加第四个历史机制。** 现在已经有 `fileHistory.js`（写前快照）、
`rewind.js`（角色聊天回退）、`rollbackBaseline.js`（推送回滚）。git 进来要么当**唯一历史基底**
并逐步退掉旧的，要么就别做——否则就是我们在 Z 分支刚花力气清掉的那类重复（两套阈值/两套微压缩/
两个队列）。

**最小切片（建议单独一支 z1010z7，跑通再谈扩展）**：
- 内核：`init` / `status` / `diff` / `log` / `commit` / 路径级 `checkout`
- agent 工具：`git_status`、`git_diff`、`git_log`（只读，零风险）；`git_commit`、`git_checkout`
  走审批（`requiresConfirmation`）
- 回合检查点：每轮工具循环后静默本地 commit（可关）
- UI：工作区「历史」面板（提交列表 + 提交 diff，复用 `DiffView`）；回合小结抽屉里出现
  「回滚到本轮之前」
- 验收：纯函数包装 Node 直测（真仓库 fixture，含 `.git` 往返）；门控测试（SAF 根下工具不注册）；
  **真机验证 commit/checkout 的实际行为**（JS git 在 Hermes 上的真实表现只能真机看）

**要你裁决的三点**：
1. git 当**唯一历史基底**（逐步退掉 `fileHistory` 快照）还是先并存？
2. 接受 isomorphic-git 纯 JS 路线吗（换可 Node 直测 + 无原生构建，代价是性能与体积）？
3. clone/push 这层动不动？（我建议先不动，REST 那条留着当兜底。）

**裁决结果（2026-10-10，用户）**：① git 当唯一历史基底、逐步退旧；② 走纯 JS 路线；
③ clone/push 先不动，REST 留着兜底。→ 开分支 `z1010z7`。

## 六、W7 Spike 实测结果（2026-10-10，z1010z7）——结论：**GO**

三条待验风险全部落地，两条变成设计约束：

| 待验项 | 结果 |
| --- | --- |
| 能不能在 Node 里直测（选纯 JS 的唯一理由） | **能**。真 isomorphic-git 1.43.3 跑在我们的 fileSystem 契约上，13 条测试全过（init/add/commit/log/status/diff/checkout/二进制往返/越界守卫） |
| Metro 能不能打包 | **能**。`expo export --platform android` 成功，无 `node:` 内建解析失败（依赖 pako/sha.js/ignore/diff3/async-lock 等都是纯 JS） |
| 体积代价 | **+630,641 字节（8,647,871 → 9,278,512，+7.3%）**。实测方式：临时在 `native.js` 接一行 import 后 export，量完已还原 |
| Node 上的性能 | 300 文件：`add`+`commit` 141ms，`statusMatrix` 42ms（Node 24；**真机 Hermes 未测**） |

**四条改变设计的实测发现**（都已落进代码，不是笔记）：
1. **isomorphic-git 1.43.3 没有 `git.diff`**（`typeof git.diff === 'undefined'`）。「改了什么」
   只能自己拼：取 HEAD 旧 blob + 当前文件 → 喂**已有的** `lineDiff.js`。内核已按此实现
   `diffModel(path)`，没有第二套 diff 算法。
2. **`writeFile` 必须自己兜父目录**。Node 的 fs 不建父目录（git 自己 mkdir），但
   expo-file-system 会直接失败，git 写对象（`.git/objects/xx/yyy`）就随机炸 →
   `gitFs.js` 的 `ensureParent`（与 `store.js` 的 `ensureDirectory` 同款）。
3. **空仓库（还没有任何提交）时 `statusMatrix`/`log` 抛 `NotFoundError`**，而这是**每个新工作区
   第一次调用**就会走的路径 → 内核用 `resolveRef('HEAD')` 判有无提交，无提交时把工作区里的
   文件全算 untracked。测试抓出来的。
4. **二进制必须 base64 进出**（git 对象是 zlib 压缩字节）；且测试的假 fileSystem 必须照真：
   text 写进去的文件要能按 base64 读回来（字节是唯一真相，两种编码都是视图）——不照这一点，
   git 会把文件读成**空 blob**（这个坑在 spike 里真实踩到）。

**落地物**：`src/workspace/gitFs.js`（fs 适配器：路径↔URI、Stat、Buffer）、
`src/workspace/git.js`（内核：init/status/changedFiles/log/readFileAtHead/diffModel/commitAll/checkoutAll）、
`tests/helpers/memoryFileSystem.mjs`（照真的内存 fileSystem，两份测试共用）、
`tests/workspaceGitFs.test.mjs` + `tests/workspaceGit.test.mjs`（13 条）。

**仍未验（不宣称）**：真机 Hermes 上的性能与 `TextEncoder` 可用性。仓里 `polyfills.js` 注释写明
全局 `TextDecoder` 来自 Hermes 且只认 UTF-8，据此推断 `TextEncoder` 也在，但**必须真机确认**
（isomorphic-git 有 1 处 `new TextEncoder`、2 处 `new TextDecoder`；`Buffer` 已由 `polyfills.js`
全局提供）。

**W7 剩余（下一阶段）**：只读 agent 工具（`git_status`/`git_diff`/`git_log`）+ SAF 门控 +
回合检查点 + 「历史」面板与回合小结抽屉；以及**退旧**（`fileHistory.js` 快照逐步让位）。

### 待你裁决的两点
1. **W3-④ 走哪条**：给工作区 agent 开 MCP GitHub 工具（能力更强，但工作区 agent 的工具面变大、
   审批噪音变多），还是把「让助手推送」改成走已注册的 CI/文件工具？
2. **W1 的投影放哪**：`src/workspace/conversation.js`（工作区专属）还是 `src/chat/timeline.js`
   （工作区 + 角色聊天共用一套行投影）。共用更省，但角色聊天的消息形态更杂（媒体/群聊），
   风险更高——我倾向先工作区专属，跑通后再考虑上提。

## 七、W7 落地进度（z1010z7，2026-10-10）

已完成（每步都过五门 + 注入验证）：

| 步 | 内容 | 提交 |
| --- | --- | --- |
| 1 | fs 适配器 + 内核（init/status/log/commit/checkout）+ spike 结论 | `f22c36b` |
| 2 | 只读三件套（git_status/git_diff/git_log）+ 门控 + 设置开关 + 能力卡如实 | `7582159` |
| 3 | 回合检查点（每轮落成本地提交）+ `agentToolSetup` 外提 | `1482385` |
| 4 | 写工具（git_commit / git_discard，后者逐条确认）+ 内核 discard 语义补正 | `a6a6b52` |
| 5 | 工作区「历史」面板（提交列表 → 文件列表 → 内联 DiffView）+ 退旧第一步 | 本步 |

**内核实测坑（都写进了代码注释，别"顺手简化"）**：
- isomorphic-git 1.43.3 **没有 `git.diff`** → 「改了什么」= HEAD 旧 blob + 当前文件喂已有 `lineDiff`；
- `fs.writeFile` 必须自己兜父目录（expo-file-system 不建父目录，git 写对象会随机失败）；
- 空仓库（还没有提交）时 `statusMatrix`/`log` 抛 `NotFoundError`，而这是新工作区第一次调用的路径；
- `git.walk` 的 `WalkerEntry.type()/oid()` 是**异步方法**（按属性读全是 undefined → 改动列表永远为空），
  且 `map` 返回 `null` 会**停止下钻**（只剩根节点）；
- `git.checkout` 只还原**已跟踪**文件 → 「丢弃全部改动」必须自己删未跟踪文件，否则是假的。

**退旧（第一步已做，逐步推进）**：
- ✅ 本地 git 开着时**不再记写前快照**（`shouldRecordFileHistory`）：同一件事已由回合检查点 +
  `git_discard` 覆盖，两份历史并存只会让「哪份才算数」变模糊。**SAF 根下继续记**——那里 git 不可用。
- ✅ 文件面板的「文件历史」入口：git 开着时 sheet 顶部出现指路条（「更完整的历史在「历史」面板」）
  并一键跳过去；老快照仍可看可恢复，只是不再增长（没有把它们藏起来）。交接链
  FilesPanel → FileHistorySheet → WorkspaceScreen 有源码钉死测试，防静默断开。
- ❌ **不是「等真机验过再删」——现在删不掉**（2026-10-11 更正原先的说法）。两条硬约束：
  git 在 **SAF 外部根**不可用（`gitGateReason` → `EXTERNAL_ROOT`），且开关**可以是关的**；
  这两种情况下写前快照是**唯一**回退手段。删了就是让这两类用户彻底没有后悔药。
  真正的前置条件是二选一，且都需要产品决策，不是清理动作：
  1. git 变成**强制开启**且**放弃 SAF 根**（外部文件夹不再支持）；或
  2. 给 SAF 根另找一套回退机制（例如把快照搬到应用私有根做旁路）。
  在那之前，`fileHistory` 的定位是「回退路径」，`shouldRecordFileHistory` 是它与 git 的
  唯一分界；文件面板在 git 开着时已指路到「历史」面板（第二步 ✅）。
- ✅ 端到端链路测试 `tests/workspaceGitFlow.test.mjs`：开开关 → 建仓库 → 写文件（不记快照）
  → 检查点提交 → 问改了什么 → 丢弃 → 回看历史面板的三个数据源；外加「开关关着时工具不注册、
  快照照记」。这是真机冒烟之前最后一道网（接缝处的静默数据丢失由它兜）。
- ✅ 真机冒烟清单见 `SMOKE_TEST.md` 第 10 节（含性能实测点与 `TextEncoder` 这个唯一未验的推断）。

**仍未验（不宣称）**：真机 Hermes 上的 git 性能与 `TextEncoder` 可用性；面板在真机上的观感
（提交列表 / 展开 / 内联 diff 三段式在窄屏是否好用）。

## 八、W1 落地（工作区会话投影，2026-10-11，z1010z7）

**做完了什么**：工作区聊天从「遍历 messages 画气泡」改成「先把会话事实投影成行，再按行渲染」。

- 新增 `src/workspace/conversation.js`（纯函数，Node 直测）：`buildConversationRows` 把
  消息 + 消息上的 `toolTrace` 投影成 `user | assistant | tool | compaction` 四类行；
  `toolRowsFromTrace` 按 `tool_call_id` 配对调用与结果，**轨迹被截断时记 `unknown`**
  （不假装成功也不假装失败）；`summarizeToolArgs` 按工具取最能认人的字段（认不出就空串，
  不甩 JSON）；`previewToolResult` 取首个非空行并截断。
- 新增 `src/workspace/screen/ToolCallRow.js`：工具行（图标按工具族 + 名字 + 参数摘要 +
  状态 + 结果首行）。**这是本轮最直接的观感变化**——此前一轮结束后工具调用什么都看不到。
- 新增 `src/workspace/screen/AgentPlanPanel.js`：计划面板外提（折叠态与「新计划自动展开」
  一并归它自己，ChatPanel 不再需要 `planCollapsed` 这行 state）。
- ChatPanel 1850 → **1781 行**（基线同步收紧）：渲染改为按行分派，压缩产物用虚线边框区分
  （它是系统的动作，不是模型说的话）。

**两条刻意的取舍（不是漏做，写进了模块注释）**：
1. **没有 plan 行**：计划的历史本身就是 `update_plan` 的工具行（参数里带清单），
   当前进度是活状态、由底部面板展示（进滚动流会滚走）。两处合一才是重复。
2. **没有 live 行**：本轮正在跑的那次调用仍由面板的瞬时状态行负责（它在滚动区外、位置固定）。
   行投影只管「已经沉淀下来的事实」——实时行与富卡片是 W2。

**W2 从这里接着长**：按工具族做富卡片（write/edit 内联 diff 复用 `DiffView`、shell/python
输出折叠、subagent 子会话摘要）、实时行（把瞬时状态行并进流里）、回合小结抽屉。

**验证**：测试 +9（投影 8 条 + 接线钉死 1 条）；注入验证「工具行不再走 ToolCallRow」变红。
五门全过（2512 测试、覆盖 79.97%、export 9.33MB）。

## 九、W2 落地（工具富卡片 + 实时行 + 回合小结，2026-10-11，z1010z7）

**做完了什么**：
- **富卡片按「用户要认什么」分族**（不是每个工具一个组件）：`edit` → find/replace 迷你 diff
  （红/绿）；`write` → 文件与体量（覆盖写入没有旧内容可比，**不假装有 diff**）；`shell`/`python`
  → 命令/代码 + 可展开输出；`update_plan` → 清单勾选；`run_subagent` → 子任务 + 结论；其余通用行。
  长内容一律折叠，默认只露摘要。一条纪律写进代码：**状态为 error 时不画「改动」**
  （失败的操作没有改动可言，画了就是撒谎）。
- **分派判定放在投影里**（`toolCardKind` + 行带 `card` 字段）：于是这条分派能被 Node 直测，
  组件保持薄（放在 JSX 文件里 Node 进不去，只能靠源码断言）。
- **实时行**：正在跑的那次调用作为临时行（key 固定 `live`）并进聊天流，删掉滚动区外那条
  「正在调用工具：xxx」状态行——用户不必盯着两处。随状态行作废的 i18n 词条一并清掉。
- **回合小结抽屉**（`TurnSummaryPanel`）：从最后一个带轨迹的助手消息推导「本次改了什么」
  （同文件合并、留最后操作、读工具不算），列表 + **撤销本轮**。
- **撤销的做法**（别简化）：不重写历史、不 reset——取 HEAD 的**父提交**，把本轮碰过的文件
  恢复成那时候的样子（**那时不存在的就删掉**，否则会留下一堆本轮新建的文件），然后**照常提交
  一次「回滚」**。于是回滚本身也在历史里、可追溯、可再撤销。门控如实：没开本地版本控制时
  不给假按钮，直接说明「先打开它，或到「文件历史」逐文件恢复」。
- `SessionSidePanels.js`：回合小结 + 计划进度的装配层（ChatPanel 顶格，新增一律落子模块）。
  ChatPanel 1781 → **1773**，基线同步收紧。

**验证**：测试 +5（卡片分派 / 行带原始参数与截断标记 / live 行是临时行 / turnChanges 合并语义 /
撤销地基）；注入验证「卡片族判定失效」与「撤销时不删本轮新建文件」都变红。五门全过
（2517 测试、覆盖 80.02%、export 9.35MB）。

**W2 剩余（下一步）**：回合小结里对 `run_shell` 改动的覆盖（现在只认写类工具，命令改的文件
看不出来——需要 git status 差分才能补全）；工具卡片的「与历史提交对比」入口（复用历史面板）。

## 十、W2 尾巴 + W3 四条（2026-10-11，z1010z7）

**W2 尾巴**：
- ① 回合小结**优先用 git**（最近一次提交 = 本轮的检查点）：它能看见 `run_shell` 改的文件，
  而工具轨迹看不见（轨迹里只有写类工具）。git 关着/没仓库时退回工具轨迹推导。
  顺带给删除类改动补了展示名。
- ② 写类卡片加「看提交历史」入口（复用历史面板，不另做一套 diff）；交接链
  ChatPanel → WorkspaceScreen → setPanel('history') 有源码钉死测试。

**W3 四条**：
- ① 工作区助手正文改走 `AssistantMessageBody`（与角色聊天**同一个渲染器**：Markdown/代码块/富 HTML），
  不再把 Markdown 当纯文本显示。用户消息与压缩行仍是纯文本。
- ② 计划随会话**落盘**（`saveSessionPlan(chatId, steps)`）+ 切会话读回（`getSessionPlan`）。
  此前只在内存里，切面板/切会话就丢。
- ③ 上下文占用**单一口径**：新增 `src/workspace/usage.js` 的 `loadWorkspaceContextUsage`，
  聊天面板与文件面板都调它。此前文件面板按「该角色最近一个单聊会话」算、聊天面板按工作区会话算，
  同一个标签两种数字，而且文件面板那份算的根本不是工作区要发出去的历史。
- ④ **推送指令不再承诺不存在的工具**：原文让模型「用 GitHub 工具逐个比对后提交」，但工作区
  agent 没有 GitHub 写工具（MCP GitHub 只注册在角色聊天）。改成「逐个读出来比对 + 请你自己用
  面板的推送按钮」，并更正 `repoImport.js` 的过期注释。
  **仍未决**：要不要给工作区 agent 开 MCP GitHub 工具（能力更强 vs 工具面变大、审批噪音变多）——
  这是产品决策，本轮只修了「说了做不到」这个缺陷。

**行数棘轮**：ChatPanel 1773 → 1767、FilesPanel 1580 → 1554（W3③ 的统一顺带把面板里的
20 行计算压成 2 行），基线同步收紧。

**验证**：五门全过（2517 测试、覆盖 79.97%、export 9.35MB）。三处源码钉死测试随契约搬家
重新指向（占用口径搬到 usage.js、侧栏面板搬到 SessionSidePanels、卡片入口新增）。

## 十一、工作区 agent 开 MCP GitHub 工具（2026-10-11，用户裁决）

**背景**：W3④ 只修了「文案说了做不到」这个缺陷，把是否给工作区 agent 开 GitHub 工具留给产品
决策。用户裁决：**开**。

**改了什么**：
- `agentToolSetup.js`：注册工作区文件工具后挂 MCP（`ensureMcpToolsRegistered`），**顺序在列工具
  之前**（否则 GitHub 工具进不了清单）；`registerMcp` 可注入（Node 可测）；MCP 抛错不影响文件
  工具（MCP 是增强，不是依赖）。函数因此变 async，ChatPanel 的调用点跟着 await。
- `tools.js` 的 `unregisterWorkspaceTools`：一并 `unregisterAllMcpTools()`——MCP 也是这条路径
  注册的，离开工作区后不能留在全局注册表里（注册过就必须能摘掉）。
- 能力卡如实列出：`activeWorkspaceTools` / `capabilityViewModel` 收 `mcpToolNames`；设置面板用
  **同一套 riskGate** 过滤目录快照后传进去（不信快照，与注册路径同纪律）——卡片不会承诺
  注册表里没有的工具。
- **文案回正**：昨天（W3④）把推送指令改成「工作区助手没有 GitHub 写工具，推不了」，那是当时
  的事实；现在接上了，改回「用 GitHub 工具逐个比对后提交（写入类每次都会请你确认）」。
  `repoImport.js` 的注释同理回正，并记下「这条通路一度是断的」。

**安全面不变**（这点最关键）：仍由 `mcp/riskGate` 决定注册哪些——只读类直接放行（read 模式
即可用）、写入类（提交/推送/开分支/PR/评论）注册但**每次调用逐条确认**、删除/强推/管理类
**全局硬禁止**（无开关、无弹框、用户同意也不行）。工作区 agent 拿到的能力边界与角色聊天一致。

**验证**：测试 +3（MCP 注册顺序与失败隔离 / 能力卡列 MCP 工具去重与空名 / **GitHub 工具在
read·write 两档的门控与逐条确认，且硬禁止类不在注册表**）；注入验证「不再挂 MCP」变红。
五门全过（2520 测试、覆盖 79.63%、export 9.35MB）。
