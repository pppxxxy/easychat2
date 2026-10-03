# Agent 工具调用循环（接口契约 v1）

状态：**已审（v1.1），实现中**。归属：monkey code（C 线，`api.js` / `modelProvider` / 新增 `src/agent/`）。
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

// 兼容：语义、返回类型（string）均不变；兜底只在这一层做
export async function sendChatMessage(messages, opts) {
  return (await streamChatCompletion(messages, opts)).text || EMPTY_REPLY_TEXT;
}
```

`opts` 在现有 `onChunk` / `onReasoning` / `signal` / `stream` / `expectedConfig*` 基础上增加：
`tools`（ToolDefinition[]）、`toolChoice`（`'auto' | 'none' | { type:'function', function:{ name } }`）。

- **`EMPTY_REPLY_TEXT` 兜底只留在 `sendChatMessage` 包装层**；`streamChatCompletion` 返回原始空串——工具轮「空文本 + tool_calls」是正常形态，占位文本污染 assistant 历史会把循环带歪。
- **配置守卫随调用进 `streamChatCompletion` 内部**（入口 + 流后检查），循环每轮各查一次。

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
    messages.push({ role:'assistant', content: res.text || null, tool_calls: res.toolCalls })   // 空文本置 null
    if res.toolCalls.length === 0: return res.text
    for call in res.toolCalls:
      if signal.aborted -> throw AbortError
      result = await runTool(call, { signal, mode, ...context })   // 见 §9
      messages.push({ role:'tool', tool_call_id: call.id, content: serialize(result, 16 * 1024) })
  // 上限兜底：整体省略 tools 字段（不发 tool_choice:'none'——兼容面更宽），强制文字收尾
  messages.push({ role:'system', content:'工具调用轮次已达上限，请直接用文字回答。' })
  final = streamChatCompletion(messages, { signal, onToken, onReasoning })
  return final.text
```

- `onToken` / `onReasoning`：**跨轮累积**后上抛（`streamChatCompletion` 每轮只给该轮全量，`runAgentTurn` 负责叠加），否则第 2 轮首个增量会冲掉第 1 轮 UI 文本。
- `onToolEvent`：`{ phase:'start'|'end', name, round, ok, error? }`；`round` 从 1 起，`ok:false` 时带脱敏 `error`。
- **UI 回调（`onToken`/`onReasoning`/`onToolEvent`）一律 try/catch 包裹**：信息性回调抛错不得打断循环。

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

- 文件工具根目录锁定 `documentDirectory/workspace/<sandbox>/`，路径规范化后必须落在根内，拒绝 `..` 与绝对路径越界。**（v1.2 起）** 根可以改到用户自选的外部文件夹（Android SAF）：此时走 `src/workspace/safStore.js` 的 `Directory`/`File` 后端，路径守卫不变（越界/绝对路径/非白名单扩展名照旧拒绝），但授权范围是用户所选文件夹及其全部子目录——已在 `SECURITY.md` §1.1 如实披露。
- ~~不做 shell、不执行任意代码、不发起网络请求类工具。~~ **（v1.2 修订）** 新增可选的 `run_shell`，但受三层门控：**不注册**（开关关 / 非「可改」模式 / 外部 SAF 根 / 原生模块缺失，判定见 `native.js` 的 `shellGateReason`）→ **不进工具列表**（`listToolsForMode`）→ **逐条确认**（`requiresConfirmation` + `runTool` 的 `ctx.confirm`，拒绝则绝不执行）。外部根下禁用是因为无 root 的 shell 访问不到 `content://`；命令只在应用沙盒内执行。不发起网络请求类工具。
- 工具入参/结果进入诊断日志前必须脱敏（复用 `SECRET_PATTERN` 链路）。命令原文会完整显示在**确认弹框**里（那是给用户做授权决定用的，不截断、不进日志）。

## 10.1 审批钩子（v1.2）

| 项 | 契约 |
|----|------|
| `runTool(call, ctx)` | `tool.requiresConfirmation` 为真时，**在超时竞速之外** `await ctx.confirm({ name, args })` |
| 返回值 | 假值 → `toErrorResult('用户拒绝了此操作（未执行）')`，**绝不执行**；真值 → 继续正常执行 |
| `ctx.confirm` 缺失 | **按拒绝处理**（不是放行）：漏接钩子的循环只会「跑不了」 |
| `ctx.confirm` 抛错 | 按中止处理（`AbortError`）；`signal.aborted` → 抛 `AbortError`（审批本身也参与中止竞速，避免弹框开着时循环卡住） |
| `runAgentTurn({ onToolApproval })` | 可选，**必须 await**（与同步、不 await 的 `onToolEvent` 区别开） |
| `requestToolApproval`（`src/chat/toolApproval.js`） | 返回 `Promise<boolean>`；正文显示完整命令；点外部/返回键 = 拒绝；无弹框能力 = 拒绝；监听 `signal` 中止立即结算 |

## 11. 存储与文档登记

- 循环本身不新增持久化键。
- 工作区文件落在 `documentDirectory/workspace/`（或用户自选的外部文件夹）；设置键 `@easychat2_workspace` 现含 `mode` / `location` / `allowCommandExecution`，已同步登记 `SECURITY.md` §1 与 `INTERFACES.md`「工作区设置」。
- 新模块 `src/agent/` 加入 `.c8rc.json` 覆盖白名单（纯逻辑部分可在 Node 测试）。**（v1.2）** `src/workspace/` 新增 `location.js` / `safStore.js` / `picker.js` / `edit.js` / `shell.js` / `capabilities.js`，全部纯逻辑或依赖注入，均可在 Node 直测。

## 12. 审阅结论（Zcode，2026-10-03）

4 点全部认可，并折入以下修订（v1.1）：

1. **分层 —— 认可**：`EMPTY_REPLY_TEXT` 兜底只留包装层、配置守卫进 `streamChatCompletion`（已写入 §2）。
2. **五轮上限 —— 认可**：上限轮**整体省略 `tools` 字段**（不再发 `tool_choice:'none'`），兼容面更宽；系统提示注入照旧（已写入 §5）。
3. **本地模型降级 —— 接受**（§6）。
4. **`onToolEvent` —— 补 2 字段**：`error?`（`ok:false` 时，脱敏短句）与 `round?`（1 起始）；并加纪律：UI 回调 try/catch，抛错不打断循环（已写入 §5）。

契约外两点已并入实现：

- **跨轮累积**：`runAgentTurn` 自维护累积串再上抛（§5）。
- **assistant 历史消息空 content 置 `null`**，避免兼容端点拒绝空串（§5）。

边界：`useChatSend.js` 的 `onlineSend` → `runAgentTurn` 接线归 `src/chat/`（Zcode 在第 8 项接入时做）；本项交付到 `src/agent/` + `api.js` / `modelProvider` 为止。

## 13. 聊天接线（在线路径 → runAgentTurn）

归属：monkey code（`src/chat/useChatSend.js`；Zcode 已确认第 8 项看屏幕走视觉多模态直连、不依赖本循环，故该文件由 monkey 单写，见协作规则「单写者原则」）。

### 改动点（仅 requestReply 的 onlineSend）

`src/chat/useChatSend.js` 的 `onlineSend`（约 324-344 行）由「直接 `sendChatMessage`」改为「按模式分流」：

```js
const onlineSend = async () => {
  const tools = listToolsForMode(workspaceMode); // ask → []
  if (!tools.length) {
    // ask 模式：保持现状零变化
    return sendChatMessage(onlineMessages, { expectedConfigId, expectedConfigFingerprint,
      signal: controller.signal, stream: chatOptions.stream, onChunk, onReasoning });
  }
  return runAgentTurn(onlineMessages, {
    mode: workspaceMode,
    tools,
    signal: controller.signal,
    requestOptions: { expectedConfigId, expectedConfigFingerprint, stream: chatOptions.stream },
    onToken: fullText => mergeStreamedText(...),      // 已累积全量语义，勿再叠加
    onReasoning: fullReasoning => mergeStreamedReasoning(...),
    onToolEvent: event => { /* 见下 */ },
    context: { characterId: character.id, sessionId: sendSessionId },
  });
};
```

- **mode 来源**：`requestReply` 开始时 `const { mode: workspaceMode } = await getWorkspaceSettings();`（storage 已导出）。`ask`/无工具 → 现有 `sendChatMessage` 路径，行为完全不变。
- **守卫透传**：`expectedConfigId/Fingerprint` 经 `runAgentTurn.requestOptions` 传入（契约 §2/§5 支持；v1.1 会剥离其中的 tools/toolChoice）。
- **累积语义对齐**：`api.js` 的 `onChunk` 与 `runAgentTurn` 的 `onToken` 都已是「全量已累积文本」，`onlineSend` 的 `mergeStreamedText` 语义不变，**不要再加一层累积**。
- **工具注册**：会话进入时调 `registerDefaultWorkspaceTools()`（幂等；`native.js` 惰性加载 expo-file-system）；`runTool` 按 `ctx.mode` 门控，读取/写入 `documentDirectory/workspace/<characterId>/`。
- **本地模型**：`sendWithModelProvider` 在本地就绪时仍走本地纯文本路径（工具循环只在在线路径生效，符合 §6）。**v1 不传 tools 给 provider**（避免语义歧义）；本地模型用户可读工作区文件、但不能 agent 调用工具（降级为普通对话）。这与 §6「本地模型 v1 不支持工具调用」一致，接线不额外处理。

### onToolEvent → 会话内轻提示（工具气泡）

工具调用对用户是「角色正在动手」的过程反馈。v1 以**会话内临时系统气泡**呈现（`pending:'true'` 的临时消息，**不落库**——与既有 pending 占位过滤一致）：

- `phase:'start'` → 插入/更新一条临时气泡「正在<工具名>…」（`kind:'tool-status'`，pending 标记）；`phase:'end', ok:true` → 移除。
- `phase:'end', ok:false` → 短暂显示失败后移除，或替换为该轮的普通错误处理；**不把 `error` 原文展示给用户**（脱敏短句即可）。
- `onToolEvent` 是 UI 信息回调，`runAgentTurn` 已 try/catch 包裹（§5），气泡异常不影响循环。

> 备选（更简）：v1 先不做气泡，仅复用现有「assistant 流式文本」展示思考过程，`onToolEvent` 仅在 dev/诊断记录。二选一由实现时定；本契约推荐做气泡，因为「读了文件才回答」时用户需要看到中间态。

### ask 模式零变化保证

- `listToolsForMode('ask') === []` ⇒ `onlineSend` 完全走原 `sendChatMessage` 分支，不注册工具、不触达 `runAgentTurn`。
- 回归测试钉：`ask` 模式下 `runAgentTurn` 零调用（源码/注入断言）。

### 不改的文件

本次接线**只动 `src/chat/useChatSend.js`**。如需动 `replyFlow.js`/`chatPipeline.js`/`App.js`/`ChatScreen.js`，先告知 Zcode（协作规则 §2），确认后单独提交。
