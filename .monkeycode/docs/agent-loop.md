# Agent 工具调用循环（接口契约 v1）

状态：**待 Zcode 审**。归属：monkey code（C 线，`api.js` / `modelProvider` / 新增 `src/agent/`）。
上游规划见 [审查待办](./审查待办.md) 的「2026-10-03 长程功能规划」第 5 项；本文是其接口契约。

## 1. 范围

- 目标：让角色具备本地工具调用能力，支撑工作区沙盒（第 6 项）与看手机（第 8 项）。
- 非目标（v1）：MCP；任意代码执行；本地模型（llama.rn）工具调用。

## 2. 分层与向后兼容

在 `api.js` 下沉结构化流式函数，`sendChatMessage` 降为薄包装，**不改变现有调用方的签名与返回值**：

```js
// 新增：结构化结果
export async function streamChatCompletion(messages, opts)
  // -> { text, reasoning, toolCalls: [{ id, name, arguments }], finishReason }

// 兼容：语义、返回类型（string）均不变
export async function sendChatMessage(messages, opts) {
  return (await streamChatCompletion(messages, opts)).text;
}
```

`opts` 在现有 `onChunk` / `onReasoning` / `signal` / `stream` / `expectedConfig*` 基础上增加：
`tools`（ToolDefinition[]）、`toolChoice`（`'auto' | 'none' | { type:'function', function:{ name } }`）。

## 3. 数据结构

```js
// 工具定义（发往模型，OpenAI function 形状）
ToolDefinition = { type: 'function', function: { name, description, parameters /* JSON Schema */ } }

// 模型返回的调用（累积完成后）
ToolCall = { id: string, name: string, arguments: string /* 原始 JSON 串 */ }

// 回喂给模型的结果消息
ToolResultMessage = { role: 'tool', tool_call_id: string, content: string }

// 单轮结果
TurnResult = { text: string, reasoning: string, toolCalls: ToolCall[], finishReason: 'stop'|'tool_calls'|'length'|null }
```

## 4. SSE 增量累积规则

- `choices[].delta.content` → `text`；`delta.reasoning_content` → `reasoning`；两者各自累加，互不覆盖。
- `choices[].delta.tool_calls[]` → 按 `index` 分桶；每片 `function.arguments` 追加到 `arguments` 串；`id`、`function.name` 在首片到账。
- 文本与工具调用可交错到达：按到达顺序分别累积即可，无需假设「先文本后工具」。
- `choices[].finish_reason` 落 `finishReason`；`usage` 可选透传（供后续预算用）。

## 5. 循环算法

```
runAgentTurn(messages, { tools, mode, signal, maxRounds = 5, onToken, onReasoning, onToolEvent })
  for round in 1..maxRounds:
    if signal.aborted -> throw AbortError
    res = streamChatCompletion(messages, { tools, toolChoice: 'auto', signal, onChunk: onToken, onReasoning })
    messages.push({ role:'assistant', content: res.text, tool_calls: res.toolCalls })   // 原样入 history
    if res.toolCalls.length === 0: return res.text
    for call in res.toolCalls:
      if signal.aborted -> throw AbortError
      result = await runTool(call, { signal, mode, ...context })   // 见 §9
      messages.push({ role:'tool', tool_call_id: call.id, content: serialize(result, 16 * 1024) })
  // 上限兜底：强制文字收尾
  messages.push({ role:'system', content:'工具调用轮次已达上限，请直接用文字回答。' })
  final = streamChatCompletion(messages, { tools, toolChoice: 'none', signal, onToken, onReasoning })
  return final.text
```

- `onToken` / `onReasoning`：每轮各自的增量文本实时上抛，UI 可见「模型正在想 / 正在说」。
- `onToolEvent`：工具执行生命周期（`{ phase:'start'|'end', name, ok }`），供 UI 显示「正在读取文件…」。

## 6. provider 路由

`sendWithModelProvider` 增加 `tools` / `mode` / `onToolEvent` 入参：

- **在线路径**：`onlineSend()` 改调 `runAgentTurn`（消息组装后），返回最终文本。
- **本地路径（v1）**：不传 `tools`，维持现有 `runLocalModel` 纯文本；若上层请求了 `tools`，记录 `recordModelLog('api', '本地模型暂不支持工具调用', { level:'warn' })` 并降级为纯对话。
- 在线/本地回退语义（`classifyLocalModelError`、单次回退）保持不变。

## 7. 取消语义

- 统一沿用 `AbortSignal` 与 `createAbortError()`（`name`/`code` 与现有实现一致）。
- signal 透传给每个 `execute`；工具自身超时默认 15s（每个工具可覆盖），超时视为工具失败（§8），不中断循环。
- 轮次边界、工具执行前后均复查 `signal.aborted`；中止即抛错，**不回喂半成品**，不留悬空 assistant/tool 消息。
- 与现有 `expectedConfigId` / `expectedConfigFingerprint` 配置切换守卫共存。

## 8. 错误处理与重试

- **工具失败不中断循环**：`execute` 抛错、参数 JSON 非法、未知工具名 → 以 `{ role:'tool', content:'工具执行失败：<脱敏原因>', isError:true }` 回喂，让模型自行解释或改参数。
- **接口/网络失败**：沿用现有行为直接抛错（含诊断记录与脱敏），**不静默重试**。
- **解析健壮性**：`arguments` 非法 JSON 在 `runTool` 内捕获，不抛到循环外。
- **上下文保护**：单条工具结果序列化上限 16KB，超出截断并标注 `…（已截断）`。

## 9. 工具注册表与模式门控

```js
registerTool({
  name,          // ^[a-zA-Z0-9_-]{1,64}$
  description,
  parameters,    // JSON Schema
  readOnly,      // bool
  execute,       // async (args, ctx) => string | { content, isError? }
  timeoutMs,     // 可选，默认 15000
})

// ctx = { signal, characterId, sessionId, workspaceMode }
```

- 注册在 `src/agent/tools/registry.js`，内置工具随模块加载注册。
- **模式过滤（暴露层）**：`询问` 不暴露任何副作用工具；`只读` 仅暴露 `readOnly:true`；`可改` 暴露读写工具。
- **模式复查（执行层）**：`runTool` 再次校验 `mode` 与 `readOnly`，双保险防越权。

## 10. 安全边界

- 文件工具根目录锁定 `documentDirectory/workspace/<sandbox>/`，路径规范化后必须落在根内，拒绝 `..` 与绝对路径越界。
- 不做 shell、不执行任意代码、不发起网络请求类工具。
- 工具入参/结果进入诊断日志前必须脱敏（复用 `SECRET_PATTERN` 链路）。

## 11. 存储与文档登记

- 循环本身不新增持久化键。
- 工作区文件落在 `documentDirectory/workspace/`；其元数据索引键由第 6 项定，届时同步登记 `SECURITY.md` §1 与 `INTERFACES.md`。
- 新模块 `src/agent/` 加入 `.c8rc.json` 覆盖白名单（纯逻辑部分可在 Node 测试）。

## 12. 待 Zcode 确认

1. `streamChatCompletion` 结构化返回值与 `sendChatMessage` 兼容包装的分层是否认可。
2. 循环上限默认 5 轮 + 上限时 `tool_choice:'none'` 强制收尾，是否够用。
3. 本地模型 v1 不支持工具调用（降级纯对话 + 提示），是否接受。
4. 工具事件 `onToolEvent` 的形状（`{ phase, name, ok }`）是否满足第 8 项 UI 需要，需要补充哪些字段。
