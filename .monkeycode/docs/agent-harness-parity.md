# Agent 能力对照：EasyChat2 vs Claude Code / DeepSeek Harness / ZCode

> 一页速览。目标：说清「我们的 agent 现在到哪、和主流 harness 差在哪、下一步补什么」。
> 最后更新：2026-10-11（基于 `m1010m10`：main + D(`d1010d3`) + Z(`z1010z7`) + M(`m1010m9`) 四线合并）。
> 三家参考基于公开资料核实（Claude Code 扩展六件套 / DSH 官方站与华为云方案 / ZCode 官方文档）。

## 定位差异

- **EasyChat2**：移动端（Expo）、**模型无关**（OpenAI / Anthropic / 本地）、带**主动性**（主动消息 / 定时 Agent 任务）与**看屏**（跨应用截屏悬浮窗）的**受控 agent 工作台**。
- **Claude Code**：终端优先的**通用编码 agent**，扩展六件套 Skills / MCP / Sub-agents / **Agent Teams**（2026-02，Opus 4.6 起，子代理间**直接通信**）/ Hooks / Plugins。
- **DeepSeek Harness（DSH）**：基于 Cordis「**一切皆插件**」的**Agent Runtime Framework**——模型 / Session / Tool / Agent Loop / Sandbox / Subagent 本身都是插件；桌面/Web GUI + Python SDK；官方插件含 Agent 团队 / 定时任务 / 语音输入 / 终端 / Agent loop / Subagent / 网页搜索。
- **ZCode（智谱）**：面向 GLM-5.3 的 **ADE（Agentic Development Environment）**——1M 无损上下文、长程任务、分组式多 Agent 任务工作区、Zread 项目知识库、时光机重构、飞书/微信远程唤醒。

## 已对齐（部分反超）

- **循环**：12 阶段 turn 状态机（`agent/turn/turnState.js`）、steering（队列 5 条）、plan nag（3 轮）、重复调用 nudge、轮次预算（write 16 / read 10 / 默认 12）、取消、工具结果回喂。
- **工具**：19 个沙盒工具（读/写/改/搜索/`list_symbols` LSP-lite/`ask_user`/`skill`/plan/`materialize_repo`/CI/子代理/工作流/团队/扩展包）+ `run_shell`/`run_python` + git 五件套（`git_status`/`git_diff`/`git_log`/`git_commit`/`git_discard`）+ 聊天工具（`web_search`/`web_fetch`）+ MCP。
- **多智能体**：并行只读子代理（批 3 / 并发 2）+ 可写子代理（opt-in，逐写审批，防递归）+ 依赖式工作流 `run_workflow`（DAG，步 8 / 并发 2）+ **团队共享黑板**（`agent/blackboard.js`）+ **持久化团队**（`.easychat/teams/`，`run_team` 按名复用）+ **跨会话黑板**（`.easychat/board/board.json`）。
- **权限**：allow/ask/deny + permission broker（生命周期与「谁来答」解耦）+ **9 事件 hooks**（before_shell/before_tool/before_prompt/before_compact/after_turn/session_start/after_write/after_edit/on_tool_result）。
- **上下文治理**：四档压缩（L0 修剪 / L1 清除 / L2 摘要 / L3 归档 `.transcripts/`）+ 响应式压缩（超限重试一次）+ K1 工具结果清除 + O1 超限落盘 + toolTrace；阈值**单一来源** `chat/compactionPolicy.js`。
- **持久化/回滚**：文件写前快照（`fileHistory.js`）+ 推送前基线（`rollbackBaseline.js`）+ **git 回合检查点**（`gitCheckpoint.js`）+ 会话事件流（`sessionEvents.js`）+ 对话分支（`branchTree.js`/`sessionBranches.js`）。
- **扩展**：SKILL.md / 斜杠命令 / 子代理档案 / 团队 / hooks.json / **扩展包**（`packs.js`，声明式、零任意代码执行）。
- **程序化**：JS 侧 JSONL 事件协议（`agent/protocol.js`）+ 原生 HTTP `POST /v1/agent`（`plugins/localApiServer/` → `workspace/headlessAgent.js`）。
- **MCP**：`tools/call` + `resources`（`read_resource`）+ `prompts`（`get_prompt`）+ 风险分级（`mcp/riskGate.js`）。
- **本地模型**：常驻上下文 + 多模态 + **本地 OpenAI 兼容 server**（`/v1/chat/completions`、`/v1/agent`、`/v1/models`）+ 持久化下载队列 + 精选目录。
- **反超**：主动消息 + 定时 Agent 任务；看屏悬浮窗；本地模型 + 本地 server；模型无关 + 模型档案（`network/modelProfiles.js`，10 家族窗口）。

## 真实差距（按优先级）

1. **运行环境深度（最大，结构性）**：三家都跑在**真实开发机**——任意 Bash / 包管理器 / LSP / 真实项目构建测试 / OS 级隔离。我们是 App 内**角色作用域沙盒** + `run_shell`/`run_python`。已补 **LSP-lite 代码大纲**（`list_symbols`）、**本地 git**（`isomorphic-git`，仅应用私有根）、**git 回合检查点**；**真 LSP / 包管理器 / 真实构建 / OS 隔离**仍缺（Android 沙盒无 node 运行时，物理受限）。
2. **插件化运行时（结构性）**：DSH 的「一切皆插件」把 Model/Session/Tool/Agent Loop/Sandbox 本身做成插件，**Creator 模式**能「对话里写插件」（含 UI 浮窗）并热装；Claude Code 的 **Plugins** 打包 Skills+Agents+Hooks+MCP 分发。我们的扩展是**声明式**（技能/命令/档案/团队/hooks/扩展包），**不能注册 UI、不能执行任意代码、无市场**。缺：可扩展 UI 的插件模型（沙盒内执行）+ 分发/市场。
3. **程序化接口 / SDK**：DSH 有官方 **Python SDK**（`pip install deepseek-harness`，`HarnessAgent` 同步/异步）；Claude Code 有 headless + SDK。我们有 JS 事件协议 + `POST /v1/agent` + headless runner，但 **Kotlin 未经编译验证**、**无对外发布的 SDK（Python/TS）**、无 ACP/JSON-RPC。
4. **多智能体协作成熟度**：Claude **Agent Teams** 支持子代理间**直接通信**；DSH Agent 团队有**团队工具 + 成员列表 + 共享任务看板**；ZCode 有**分组式多 Agent 任务工作区**（拖拽折叠、跨区迁移、批量管理）。我们有并行子代理 + 黑板 + 持久化团队 + 跨会话黑板，缺**实时互通/协商**与**并发任务的 GUI 看板**。
5. **长程上下文规模**：ZCode/GLM-5.3 主打 **1M 无损上下文**（IndexShare 稀疏注意力）；DSH 亦支持大窗口。我们默认 **200k + 压缩**。缺 1M 级长程承载（受移动端内存与本地模型窗口限制）。
6. **一键回滚 / 时光机**：Claude `/rewind` 同时回滚**代码 + 对话**；ZCode **时光机**允许改历史指令、自动撤销后续并重推。我们是文件快照 + 回滚基线 + git 检查点 + 对话分支，**非「回到任意点」**、无「改指令重推」。
7. **MCP 完整性**：缺 **`resources/subscribe`**（订阅）与通知。
8. **完整 transcript 持久化**：三家持久化**完整 agent transcript（system + tool 消息）**；我们是**展示文本 + 嵌套 toolTrace** 的混合体（压缩靶子已改为展开后的 transcript，但仍非「以内联 tool 消息为唯一存储」）。
9. **可观测性**：DSH 内置 **Token 计量 / KV-Cache 命中率 / 工具耗时**并在 Web 界面展示；ZCode 有高缓存命中率面板。我们有上下文占用 + 会话事件流，缺 KV-cache 命中率、工具耗时、子代理 token/耗时。
10. **目标对象 + 后台任务视图**：DSH 有 composer **goal 条**（可编辑/暂停/恢复）与**会话头部后台任务列表**（生命周期/实时进度/两击停止）；ZCode 有 `/goal` 目标模式。我们只有 `update_plan` 计划条，**无持久化目标对象**，定时 Agent 任务在拓展页、**会话内看不到这轮起了什么后台活**。
11. **Skills 渐进式披露**：Claude Code 三层按需加载（元数据扫描 → 相关性匹配 → 资源加载），装 100+ 技能几乎不占上下文。我们按名 `skill` 加载，缺三层披露。
12. **形态与远程控制**：三家是 CLI / IDE / 桌面 / Web；ZCode/AutoClaw 支持**飞书/微信远程下达任务**。我们是移动 App（移动优先是优势，桌面/IDE 工作流是差距）；有主动消息推送，缺**远程任务提交**。
13. **模型专门调优**：Claude 按自家模型深调（prompt cache/thinking）、ZCode 与 GLM-5.3 端到端联调（IndexShare/弹性推理强度）。我们模型无关 + 模型档案，**不做 per-model 系统提示/采样深调**。

## 明确不做（沿用既有裁决，防被外部分析带偏）

LSP 完整集成（Android 沙盒无 node 运行时，物理不可行）｜ 53 包插件化 UI（先解决面板怎么拆）｜ 完整键位录制系统（桌面形态产物）｜ Electron 内嵌浏览器 ｜ Plan DAG ｜ 工具结果向量检索 ｜ 上下文老化淘汰 ｜ 重做 MCP 泛化 / `run_subagent` / SKILL.md 基础格式。

## 一句话

我们更像「**移动端、模型无关、带主动性与看屏能力的受控 agent 工作台**」；三家是「**跑在真实开发机、程序化驱动、插件化组合、支持多智能体编排的通用编码 agent**」。

补齐优先级：**① 运行环境深度（LSP/git/构建）→ ② 插件化运行时（可注册 UI + 沙盒执行 + 市场）→ ③ 程序化接口/SDK → ④ 多智能体协作成熟度 → ⑤ 长程上下文与一键回滚**。

## 本次进展（分支 `m1010m11`，按上述优先级）

- **① 运行环境深度**：`workspace/symbols.js` LSP-lite 扩到 13 种语言（JS/TS/Py/Go/Rust/Java/Kotlin/Ruby/PHP/C/C#/Swift/Shell）；新增只读工具 **`find_references`**（`workspace/references.js`：整词匹配 + 定义/引用分类，重构前评估影响面）。真 LSP / 包管理 / 真实构建仍受 Android 沙盒限制。
- **② 插件化运行时**：`workspace/plugins/`——manifest schema/校验、类型化 **UI 槽位注册表**（优先级冲突裁决）、**能力受限沙盒执行**（`sandbox.js`，诚实边界：非安全沙盒）、内置**市场目录**、`.easychat/plugins.json` 加载/安装/装配；面板 `extension/WorkspacePluginsPanel.js` + 槽位渲染 `screen/PluginSlot.js`。
- **③ 程序化接口/SDK**：`agent/rpc.js`（JSONL 事件 ↔ JSON-RPC 2.0，`agent.run`/`agent.cancel`/`agent.models`）+ `agent/sdk.js`（零依赖 JS SDK）+ `sdk/python/easychat2.py`（Python SDK）+ 本地 server `/rpc` 端点（JS 侧就绪；Kotlin 路由待补）。
- **④ 多智能体协作**：黑板扩为「广播 + **直连消息** + **任务看板**」——`board_send`/`board_inbox`（点对点）、`board_task`（add/claim/complete/list 共享清单）；`serialize` v2 跨会话沉淀；设置面板「团队记忆」显示任务看板。
- **⑤ 长程上下文 + 一键回滚**：`chat/longHorizon.js`（大窗口模型抬阈值/多保留的纯策略）；`workspace/gitRewind.js`（git 检查点版一键回滚：对话截断 + 恢复该轮文件；与 Z 系 `rewind.js` 的文件快照版互补）。

仍差：真 LSP / 包管理 / 真实构建（物理受限）、可执行代码的强隔离沙盒、官方 Python/TS 包发布、ACP/JSON-RPC 原生端点、实时互通协商与并发任务 GUI 看板、1M 级长程承载、`/rewind` 的任意点回退。

