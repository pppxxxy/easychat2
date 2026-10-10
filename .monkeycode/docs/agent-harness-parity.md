# Agent 能力对照：EasyChat2 vs Claude Code / DeepSeek Harness / ZCode

> 一页速览。目标：说清「我们的 agent 现在到哪、和主流 harness 差在哪、下一步补什么」。
> 最后更新：2026-10-10（基于 m1010m7：Z 系 + M 系 + D 系三线合并）。

## 定位差异

- **EasyChat2**：移动端（Expo）、**模型无关**（OpenAI / Anthropic / 本地）、带**主动性**（主动消息 / 定时 Agent 任务）与**看屏**（跨应用截屏悬浮窗）的**受控 agent 工作台**。
- **Claude Code / DeepSeek Harness(dsh) / ZCode**：跑在**真实开发机**、可**程序化驱动**、支持**多智能体编排**的**通用编码 agent**（CLI / IDE / 桌面 / web / TUI）。

## 已对齐（部分反超）

- **循环**：turn 状态机、steering、plan nag、重复调用 nudge、轮次预算。
- **上下文治理**：microcompact + token 预算阈值 + 响应式回退重试 + 四档压缩 + `.transcripts/` 归档 + toolTrace。
- **工具**：14 个沙盒工具（读/写/改/搜索/plan/exec/docx/materialize/ci/subagent）+ 聊天工具（web_search/web_fetch）+ MCP（tools/call）。
- **多智能体**：并行只读子代理 + 可写子代理（opt-in，逐写审批，防递归）+ 依赖式工作流 `run_workflow`。
- **权限**：allow/ask/deny + permission broker + 9 事件 hooks。
- **扩展**：技能 / 斜杠命令 / 子代理档案 / hooks.json。
- **其它**：记忆（AGENTS.md）、文件快照、会话事件流、模型降级链、Anthropic 提示缓存、后台运行。
- **反超**：主动消息 + 定时 Agent 任务；看屏悬浮窗；本地模型 + 本地 OpenAI 兼容 server；模型无关。

## 真实差距（按优先级）

1. **运行环境深度（最大）**：参考操作真实文件系统 / git / 包管理器 / LSP / 构建测试 / 任意 Bash；我们是 App 内**角色作用域沙盒** + `run_shell`/`run_python`。**已补 LSP-lite 代码大纲**（m1010m8：`list_symbols`，JS/TS/Python 顶层符号）；**真 LSP / 包管理 / 本地 git（仅 GitHub API）/ 真实项目构建 / OS 级隔离**仍需原生或依赖。
2. **多智能体编排**：已有**并行只读子代理**（`run_subagent` task 数组，并发 2）+ **可写子代理**（opt-in `mode:'write'`，逐写审批、默认只读）+ **依赖式工作流 `run_workflow`**（DAG：无依赖并行、有依赖带前置结论）+ **团队共享黑板**（`src/agent/blackboard.js`：同一批次的多个分身用 `board_post`/`board_read` 自由传递中间结果，突破 DAG 的显式依赖——`run_workflow` 每步、`run_subagent` 并行批次各共享一块内存黑板，署名 `step.id`/`task-N`）+ **持久化团队**（`.easychat/teams/<name>.md` 保存好的多步编排，`run_team` 按名复用；步骤 `agent` 字段现按 `.easychat/agents/` 档案收窄工具/轮次，`workflowRunner.js` 统一执行路径）+ **跨会话黑板**（黑板序列化到 `.easychat/board/board.json`：`run_team` 默认 `remember=true` 播种+落盘，`run_workflow` 可 `remember=true` 开启；团队发现跨会话沉淀，列表枚举隐藏、模型走 `board_read` 读）；仍缺 **多设备/多人实时协作**。
3. **程序化接口 / SDK**：参考有 headless + ACP/JSON-RPC + Python/TS SDK；我们**已落 JS 侧稳定事件协议**（m1010m8：`src/agent/protocol.js`，JSONL 事件流）；**原生 HTTP endpoint（`POST /v1/agent`）待做**——本地 API server 目前只路由本地模型，加 agent 路由需原生改动（本机无法编译验证）。
4. **持久化 transcript**：参考持久化**完整 agent transcript（system + tool 消息）**；我们是**展示文本 + 嵌套 toolTrace** 的混合体。**压缩靶子已改为展开后的完整 transcript**（m1010m8：`buildCompactionSummaryRequest` 内部展开轨迹 + 工具转写）；仍非「以内联 tool 消息为唯一存储」。
5. **MCP 深度**：~~只有 `tools/call`~~ **已补齐**（m1010m8）：`tools/call` + `resources` + `prompts`（连接时拉目录、注册只读工具）。仍无订阅（`resources/subscribe`）。
6. **上下文规模**：ZCode 主打 **1M token 长程**；我们默认 200k + 压缩。
7. **检查点 / 回滚**：参考 `/rewind` 同时回滚**代码 + 对话**；我们是文件快照 + rollback baseline + rewind 联动，非「一键回到任意点」。
8. **形态**：参考是 CLI / IDE / 桌面 / web；我们是移动 App（移动优先是优势，桌面 / IDE 工作流是差距）。
9. **模型专门调优**：参考按自家模型深调（Claude 的 prompt cache/thinking、ZCode 的 GLM）；我们模型无关但缺 per-model 深度调优。

## 一句话

我们更像「**移动端、模型无关、带主动性与看屏能力的受控 agent 工作台**」；参考是「**跑在真实开发机、可程序化驱动、支持多智能体编排的通用编码 agent**」。

补齐优先级：**① 真实执行环境（LSP/git/构建）→ ② 多智能体编排 → ③ 程序化接口/SDK → ④ 完整 transcript 持久化 → ⑤ MCP 完整性**。
