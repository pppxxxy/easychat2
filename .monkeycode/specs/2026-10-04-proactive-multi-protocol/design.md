# 主动消息多协议支持 — 设计

日期：2026-10-04。分支：`Z-proactive-protocols`（基于 `Z-overlay-fixes`）。

## 核心决策

**协议大脑继续留在 JS（`src/apiProtocols.js`），原生只做传输。**

- 保存槽时，JS 用 `apiProtocols` 的纯函数把消息数组转换成**该协议的完整请求体**
  （含 model 与生成参数）直接快照进原生；原生不再拼 OpenAI 形态的体。
  这样三种协议的转换只实现一次，主动消息与聊天路径共享同一份协议代码。
- 时间占位符的替换从「遍历 messages 数组」改为「**整份 body 文本串替换**」：
  转换后占位符可能落在 `system`（anthropic）/ `instructions`（responses）/
  `messages`（openai）任一处，串替换对三种形态都正确，且与原生实现解耦。
- 鉴权头不进快照、不进日志：JS 只下发 `authHeader` / `authScheme` / 额外头 JSON，
  apiKey 仍走既有的加密存储通道。

## JS 侧（`src/proactive/proactiveRequest.js`）

- 新增纯函数（全部可 Node 直测）：
  - `PROACTIVE_MAX_TOKENS = 120`、`PROACTIVE_TEMPERATURE = 0.9`
  - `buildProactiveRequestBody({ protocol, model, messages })`：
    - `anthropic` → `toAnthropicRequest(messages)` → `{ model, max_tokens, temperature, system?, messages }`
    - `openai-responses` → `toResponsesRequest(messages)` → `{ model, input, store:false, max_output_tokens, temperature, instructions? }`
    - `openai` → `{ model, messages, max_tokens, temperature }`
  - `buildProactiveEndpoint(protocol, baseUrl)` = `normalizeProtocolUrl` 薄包装
  - `buildProactiveAuthSettings({ protocol, config })` → `{ protocol, authHeader, authScheme, extraHeaders }`
    （默认值与 `apiProtocols.buildRequestHeaders` 同口径；anthropic 附 `anthropic-version`）
- `buildProactiveRequestJson({ ..., protocol, model })` 返回值从「消息数组 JSON」
  改为「完整请求体 JSON」。

## 原生侧（`plugins/proactiveMessage/android/`）

- `ApiSettings` 增 `protocol / authHeader / authScheme / extraHeadersJson`（带 openai 语义
  默认值，旧持久化缺字段自动兼容）；`MessageStore.save/loadApiSettings` 增对应键。
- `ProactiveMessageModule.setApiSettings` 读取新字段（缺省给默认值）。
- `AiApiClient.generateProactiveMessage`：
  1. `schedule.requestJson` 为合法 JSON **对象** → 直接作为请求体（JS 已按协议组好）；
     否则按 `settings.protocol` 组「角色设定 + 类型提示词」的回退简版体。
  2. 时间占位符在整份 body 文本上替换。
  3. 请求头：`authHeader: authScheme + apiKey` + `Content-Type` + `extraHeadersJson` 逐条。
  4. 回复解析按 `protocol` 分派（见需求 R4）。

## 测试

- JS：`tests/proactiveRequest.test.mjs` 增协议转换/鉴权/端点用例；
  `tests/proactivePanel.test.mjs` 改为断言「保存时按当前协议组端点与鉴权并随快照下发」
  （取代原 openai-only 守卫断言）。
- Kotlin：新增 `tests/proactiveProtocolsKotlin.test.mjs` 源码断言（回复解析按协议分派、
  鉴权头来自设置、时间占位符整串替换、回退简版按协议组体、持久化新键含默认值）。
- Kotlin 不进本地门禁编译：首次 Gradle 编译与真机后台触发由 CI/真机验证。
