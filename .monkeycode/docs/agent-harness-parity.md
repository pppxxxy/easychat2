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

1. **运行环境深度（最大）**：参考操作真实文件系统 / git / 包管理器 / LSP / 构建测试 / 任意 Bash；我们是 App 内**角色作用域沙盒** + `run_shell`/`run_python`，**无 LSP / 无本地 git（仅 GitHub API）/ 无包管理 / 无真实项目构建**，shell 也**无 OS 级隔离**。
2. **多智能体编排**：已有**并行只读子代理**（`run_subagent` task 数组，并发 2）+ **可写子代理**（opt-in `mode:'write'`，逐写审批、默认只读）+ **依赖式工作流 `run_workflow`**（DAG：无依赖并行、有依赖带前置结论）；仍缺 **agent 团队 / 跨会话协作 / 子代理间自由通信**。
3. **程序化接口 / SDK**：参考有 headless + ACP/JSON-RPC + Python/TS SDK；我们只有本地 OpenAI 兼容 API server + 定时任务，**无通用 agent SDK / 外部驱动协议**。
4. **持久化 transcript**：参考持久化**完整 agent transcript（system + tool 消息）**；我们是**展示文本 + 嵌套 toolTrace** 的混合体，压缩靶子不是完整 transcript。
5. **MCP 深度**：我们只有 `tools/call`（无 `resources` / `prompts` / 订阅）。
6. **上下文规模**：ZCode 主打 **1M token 长程**；我们默认 200k + 压缩。
7. **检查点 / 回滚**：参考 `/rewind` 同时回滚**代码 + 对话**；我们是文件快照 + rollback baseline + rewind 联动，非「一键回到任意点」。
8. **形态**：参考是 CLI / IDE / 桌面 / web；我们是移动 App（移动优先是优势，桌面 / IDE 工作流是差距）。
9. **模型专门调优**：参考按自家模型深调（Claude 的 prompt cache/thinking、ZCode 的 GLM）；我们模型无关但缺 per-model 深度调优。

## 一句话

我们更像「**移动端、模型无关、带主动性与看屏能力的受控 agent 工作台**」；参考是「**跑在真实开发机、可程序化驱动、支持多智能体编排的通用编码 agent**」。

补齐优先级：**① 真实执行环境（LSP/git/构建）→ ② 多智能体编排 → ③ 程序化接口/SDK → ④ 完整 transcript 持久化 → ⑤ MCP 完整性**。
