# Agent 程序化接口 / SDK（差距 #3）

> 目标：让外部驱动（脚本 / 其它应用 / 未来 SDK）能以稳定契约运行 agent 并消费其事件流，
> 对齐 dsh 的 headless + ACP/JSON-RPC 与 Claude Code 的 `-p` headless。

## 现状

- **JS 侧（已落地，m1010m8）**：`src/agent/protocol.js`
  - 事件协议 v1：`run_start` / `text` / `reasoning` / `tool_start` / `tool_end` / `usage` /
    `run_end` / `error`；每条 `{ v, type, at, ...白名单字段 }`。
  - `serializeAgentEvent` / `parseAgentEvent`：JSONL（一行一条），便于流式传输与落盘。
  - `createProtocolEmitter(onEvent)`：把 agent 循环回调（onToken/onReasoning/onToolEvent/onUsage）
    适配成协议事件；回调抛错一律吞掉（旁路不打断运行）。
- **原生侧（待做）**：本地 API server（Kotlin `plugins/localApiServer/`）目前只路由
  `GET /v1/models` 与 `POST /v1/chat/completions`（且只跑本地模型，不跑 agent）。
  要对外暴露 agent，需加一条 `POST /v1/agent`：
  - 请求体：`{ characterId, sessionId?, prompt, mode?: 'read'|'write' }`。
  - 响应：chunked SSE / JSONL 事件流（复用 `respondStream`）。
  - 原生 emit `LocalApiServer:onRequest` → JS 组装请求 + `runAgentTurn` + `createProtocolEmitter`
    → `respondStream(requestId, sseText, done)`。
  - **本机无法编译原生**，故本轮只落 JS 契约；原生接线作为下一步。

## 契约（v1）

| type | 字段 | 说明 |
|---|---|---|
| `run_start` | `mode?` | 一次运行开始 |
| `text` | `text` | 流式正文增量 |
| `reasoning` | `text` | 思考增量 |
| `tool_start` | `name`, `round`, `args` | 工具开始（args 为解析后的对象或 null） |
| `tool_end` | `name`, `round`, `ok` | 工具结束 |
| `usage` | `round`, `promptTokens`, `completionTokens`, `cachedTokens` | 端点返回 usage 时 |
| `run_end` | `text` | 运行结束，附终稿文本 |
| `error` | `message` | 失败（已脱敏） |

## 门禁

- 纯函数 Node 直测（`tests/protocol.test.mjs`）。
- 原生接线落地后需真机验证 SSE 流式与中止。
