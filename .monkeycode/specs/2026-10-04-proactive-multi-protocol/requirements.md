# 主动消息多协议支持（openai / openai-responses / anthropic）— 需求

日期：2026-10-04。提出：用户（「要彻底跟随当前协议得让原生支持三种协议，立项修」）。
背景：`m-api-protocols` 给聊天路径放开了三种接口协议，但原生主动消息的后台请求
只会按 OpenAI Chat Completions 发（endpoint 由 `normalizeChatUrl` 固化为
`<base>/v1/chat/completions`，请求体为 OpenAI 形态，鉴权固定 `Authorization: Bearer`）。
曾以「JS 侧拒绝非 openai 协议」做临时守卫（`Z-audit-fixes` `29e67d7`），本项立项后由
完整支持取代该守卫。

## 需求

1. **R1 三协议后台发送**：用户在设置页选择任意受支持协议（openai / openai-responses /
   anthropic）后，主动消息的时间槽在后台触发时按该协议发送，端点、鉴权头、请求体
   形态全部正确。
2. **R2 快照一致性**：槽的请求体快照（requestJson）在保存时即按协议组好完整请求体
   （含 model 与生成参数），原生不做事后转换——保证「保存时的上下文 + 保存时的协议」
   始终配套；先排槽后改协议的行为见 R5。
3. **R3 鉴权与额外头**：按协议与配置生成鉴权头（默认 openai 系 `Authorization: Bearer`、
   anthropic 系 `x-api-key` 原值 + `anthropic-version`），尊重用户自定义的
   `authHeader` / `authScheme` / `anthropicVersion`。apiKey 依旧只经加密存储下发原生，
   快照与日志不含密钥。
4. **R4 回复解析**：原生按协议解析回复文本（openai `choices[0].message.content`；
   anthropic `content[].type=="text"` 拼接；openai-responses `output[].content[]` 中
   `output_text` 拼接）。解析失败/HTTP 非 2xx 仍走既有本地降级兜底文案。
5. **R5 兼容与边界**：
   - 旧版本持久化的设置缺新字段时按 openai 语义取默认值（不破坏升级）。
   - 先排槽、后改协议：原生仍持有保存时的完整配置，行为是「按旧配置继续发」，
     不是打错端点；用户重新保存槽即刷新。
   - 时间感知占位符 `{{proactive_now}}` 语义不变：保存时不固化时间，原生触发时
     在**整份请求体文本**上替换（转换后可能落在 system/instructions/messages 任一处）。
   - 主动消息仍不带流式、不带工具；失败兜底文案机制不变。
6. **R6 可验证**：JS 侧协议转换/鉴权/端点为纯函数可 Node 直测；Kotlin 侧以源码
   断言钉住关键行为（按协议解析回复、鉴权头来自设置、时间占位符整串替换、
   回退简版按协议组体）。Kotlin 编译与真机后台触发由 CI/真机验证。
