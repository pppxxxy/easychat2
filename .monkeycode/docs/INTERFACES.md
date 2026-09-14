# 接口文档

本文档描述 EasyChat2 的内部模块接口与外部契约。应用为前端形态，接口分为四类：界面组件、全局状态、持久化与网络。

## 界面组件

### `App`（默认导出）
**位置**: `App.js`
**职责**: 注册手势根节点、安全区、全局 `AppProvider`、导航容器与底部标签导航。

| 标签页名称 | 组件 | 说明 |
|-----------|------|------|
| `聊天` | `ChatScreen` | 对话与消息列表 |
| `角色` | `CharacterScreen` | 角色编辑与角色卡导入 |
| `设置` | `SettingsScreen` | API 配置 |

导航主题在 `App.js` 内以 `DefaultTheme` 扩展定义，暗色背景 `#1a1a2e`，主色 `#6c63ff`。`Header` 组件使用 `useSafeAreaInsets` 计算顶部内边距。

### `ChatScreen`（默认导出）
**位置**: `src/ChatScreen.js`
**Props**: 无（由导航注入）
**内部组件**:

| 组件 | Props | 说明 |
|------|-------|------|
| `MessageBubble` | `message` | 用户消息渲染纯文本，助手消息用 `Markdown` 渲染 |
| `ErrorBubble` | `message`, `rawError`, `onCopied` | 可展开的系统报错气泡，支持复制原文 |

**状态与副作用**:
- 依赖 `useApp()` 获取 `character`，派生 `characterId = character.id || 'default'`
- `characterId` 变化时重新加载该角色的消息，并在加载期间禁用输入与发送
- `persistableMessages` 过滤 `pending` 后通过快照比对决定是否落盘
- `renderedMessages` 对助手消息应用 placement 2、对用户消息应用 placement 1 的展示正则（mode `display`），原始文本仍用于落盘

**消息角色常量**: `user`、`assistant`、`system-error`
**密钥脱敏**: 来自 `src/secrets.js` 的 `SECRET_PATTERN = /(sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9\-_]+)/g` 与 `maskSecrets`，替换为 `[API_KEY已隐藏]`

### `CharacterScreen`（默认导出）
**位置**: `src/CharacterScreen.js`
**Props**: 无
**状态**: `name`、`systemPrompt`、`description`、`personality`、`scenario`、`firstMes`、`worldInfo`、`regexScripts`、`expandedWorld`、`expandedRegex`、`importing`、`seededRef`
**行为**:
- 首次加载完成后用 Context 中的角色回填全部可编辑字段（仅一次）
- `save()` 组装 `{ id, name, systemPrompt, systemPromptComposed, description, personality, scenario, firstMes, worldInfo, regexScripts }` 并调用 `updateCharacter`（浅合并）；`systemPromptComposed` 由 `buildSystemPrompt` 用核心字段合成
- `importCard()` 通过 `DocumentPicker` 选取 `image/png` 或 `application/json`，读取为 Base64 后解析；导入时原始 `system_prompt` 存入 `systemPrompt`，合成结果存入 `systemPromptComposed`
- PNG 无 `chara`/`ccv3` 文本块时提示「该图片不包含角色卡数据，请上传角色卡 JSON 文件或含数据的 PNG 图片。」；解析异常提示脱敏后的错误详情
- 世界书与正则以可折叠区块编辑（默认收起），支持逐条修改与增删；对话示例/作者注释/历史后指令/标签为只读

### `SettingsScreen`（默认导出）
**位置**: `src/SettingsScreen.js`
**Props**: 无
**状态**: `baseUrl`、`model`、`apiKey`
**行为**: 挂载时读取配置；页面提示 API Key 与聊天内容会发送到所填地址且仅存本机；保存前若地址匹配 `/^http:\/\//i` 则弹出明文传输风险确认。

## 全局状态

### `AppProvider`
**位置**: `src/context/AppContext.js`
**Props**: `children`

### `useApp()` 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `character` | `Character` | 当前角色，初始为 `DEFAULT_CHARACTER` |
| `loaded` | `boolean` | 角色是否已从存储加载完成 |
| `updateCharacter` | `(patch) => Promise<Character>` | 合并并持久化角色更新 |

**`updateCharacter(patch)` 契约**:
1. 若尚未加载完成，抛出 `Error('角色尚未加载完成')`
2. 基于 `characterRef.current` 合并 `patch`，乐观更新内存与界面
3. 调用 `saveCharacter(merged)`；失败时回滚旧值并重新抛出
4. 成功时返回合并后的角色对象

## 持久化接口

**位置**: `src/storage.js`

| 函数 | 签名 | 说明 |
|------|------|------|
| `getApiConfig` | `() => Promise<ApiConfig>` | 读取配置并与默认值合并 |
| `saveApiConfig` | `(config) => Promise<void>` | 写入配置 |
| `getCharacter` | `() => Promise<Character>` | 读取角色，缺失字段回退默认值并补全 `id` |
| `saveCharacter` | `(character) => Promise<void>` | 写入角色 |
| `getMessages` | `(characterId?) => Promise<Message[]>` | 读取指定角色消息，过滤 `pending` |
| `saveMessages` | `(characterId, messages) => Promise<void>` | 写入指定角色消息，过滤 `pending` |

**导出的默认值**:
- `DEFAULT_CHARACTER` 含 `id`、`name`、`systemPrompt`、`systemPromptComposed`，以及扩展字段 `description`、`personality`、`scenario`、`firstMes`、`mesExample`、`creatorNotes`、`postHistoryInstructions`、`tags`、`worldInfo`、`regexScripts`（后四类缺省为空串/空数组）

**AsyncStorage 键约定**:

| 键 | 内容 |
|----|------|
| `@easychat2_api_config` | API 配置 JSON |
| `@easychat2_character` | 当前角色 JSON |
| `@easychat2_messages::<characterId>` | 指定角色的消息数组 |
| `@easychat2_messages` | 旧版单会话消息（仅默认角色读取时兜底） |

**默认 API 配置**:

| 字段 | 默认值 |
|------|--------|
| `baseUrl` | `https://api.deepseek.com` |
| `model` | `deepseek-chat` |
| `apiKey` | 空字符串 |

## 网络接口

### `sendChatMessage(messages, options?)`
**位置**: `src/api.js`

| 参数 | 类型 | 说明 |
|------|------|------|
| `messages` | `Array<{ role, content }>` | 完整消息数组，含 `system`、历史与最新用户消息 |
| `options.onChunk` | `(fullText: string) => void?` | 每解析出一个增量片段后触发；入参为截至当前的累计助手文本 |
| `options.signal` | `AbortSignal?` | 传入后可通过 `abort()` 取消请求；取消时 Promise 以 `AbortError` 拒绝，并移除监听 |

**返回**: `Promise<string>` - 流式累计文本；服务端忽略流式而返回整包 JSON 时取 `choices[0].message.content`；空响应返回 `'没有收到回复。'`

**辅助导出**: `isCanceledError(error): boolean` - 判断错误是否来自主动取消（`error.canceled === true` 或 `error.name === 'AbortError'`）。

**实现说明**: React Native 的 `fetch` 不暴露 `response.body`，无法流式读取。本函数改用 RN 内置 `XMLHttpRequest` 的增量事件（`onprogress` + 累计 `responseText`）解析 SSE，因此不引入任何额外依赖。`onChunk` 接收累计文本，调用方可直接覆盖助手消息的 `text` 字段。收到 `data: [DONE]` 时立即结算并中断连接，无需等待服务端关闭。

**异常**:
- 已取消的信号：`Error('已停止生成。')`，`name = 'AbortError'`
- 未配置 Key：`Error('请先在“设置”里填写 API Key。')`
- 空闲超时：`Error('请求超时，请检查网络后重试')`
- 网络失败：`Error('网络请求失败，请检查网络或 API 地址。')`
- 非 2xx：由 `formatApiError` 提取后端错误信息
- 2xx 但响应既非 SSE 也非可解析 JSON：`Error('接口返回了无法解析的内容。')`
- SSE 流内 `error` 负载：抛出其 `message`
- SSE 流内所有 `data:` 行都无法解析为 JSON：`Error('接口返回了无法解析的内容。')`

**地址归一化规则** `normalizeChatUrl(baseUrl)`:

| 输入结尾 | 归一化结果 |
|----------|-----------|
| `/chat/completions` | 原样使用 |
| `/v1` | 追加 `/chat/completions` |
| 其他（含根地址） | 追加 `/v1/chat/completions` |

**外部 HTTP 契约**:

```http
POST {normalizedUrl}
Content-Type: application/json
Accept: text/event-stream
Authorization: Bearer <API_KEY>

{
  "model": "<model>",
  "messages": [{ "role": "system", "content": "..." }],
  "stream": true
}
```

流式响应为 SSE，每个事件的数据行形如：

```
data: {"choices":[{"delta":{"content":"增量文本"}}]}

data: [DONE]
```

服务端返回整包 JSON 时的兼容响应：

```json
{
  "choices": [
    { "message": { "role": "assistant", "content": "..." } }
  ]
}
```

**超时**: 采用空闲超时。每次收到增量数据都会重置 30 秒计时器；30 秒无数据则判定为超时。

## 卡解析与提示管线接口

### `parseCardFromJson(text)`
**位置**: `src/cardParser.js`
**返回**: 标准化角色卡 `{ name, fields, systemPrompt, worldInfo, regexScripts }`
**异常**: JSON 语法错误时抛出 `Error('JSON 语法错误：...')`

### `parseCardFromPng(bytes)`
**位置**: `src/cardParser.js`
**返回**: 标准化角色卡；PNG 无 `chara`/`ccv3` 文本块时返回 `null`
**异常**: 非 PNG 签名、base64 解码失败、JSON 语法错误时抛出

### `readCardJsonFromPng(bytes)`
**位置**: `src/cardParser.js`
**说明**: 先用 `parsecard.readJsonFromPNG` 读取 `tEXt`，为空时用本地无压缩 `iTXt` 兜底；均无数据返回 `null`

### `createWorldEntry(partial?, index?)` / `createRegexScript(partial?, index?)`
**位置**: `src/cardParser.js`
**返回**: 经标准化补全默认值的一条世界书条目 / 正则脚本；用于角色页新增条目
**辅助导出**: `WORLD_POSITION_LABELS`、`REGEX_PLACEMENT_LABELS`

### `ensureUniqueIds(items, prefix)`
**位置**: `src/cardParser.js`
**说明**: 对世界书/正则条目做 id 去重，重复时回退为 `<prefix>-<index>`；`normalizeCard` 已内置调用

### `buildRequestMessages({ character, historyMessages, userText })`
**位置**: `src/chatPipeline.js`
**返回**: `Array<{ role, content }>`，形如 `[system, ...history, user]`；世界书 `position 4` 条目以独立消息按深度插入
**说明**: 系统提示词优先取 `character.systemPromptComposed`，为空回退 `character.systemPrompt`，再回退 `DEFAULT_SYSTEM_PROMPT`；历史用户消息与当前输入应用 placement 1 正则，历史助手消息（含开场白）应用 placement 2 正则，命中的世界书文本应用 placement 5 正则

### `collectActiveWorldInfo(character, historyMessages, latestUserText)`
**位置**: `src/lorebook.js`
**返回**: `{ before, after, depth }` 三组已激活条目，各组按 `order` 升序

### `applyRegexScripts(text, scripts, placement, options?)`
**位置**: `src/regexEngine.js`

| 参数 | 类型 | 说明 |
|------|------|------|
| `scripts` | `RegexScript[]` | 角色携带的正则脚本 |
| `placement` | `number` | 见 `REGEX_PLACEMENT`（1 用户输入、2 AI 输出、5 世界信息、6 推理） |
| `options.mode` | `'prompt' \| 'display' \| 'both'` | 决定跳过 `markdownOnly` 或 `promptOnly` |
| `options.depth` | `number?` | 用于 `minDepth`/`maxDepth` 过滤 |

**辅助导出**: `REGEX_PLACEMENT`。

### `maskSecrets(text)`
**位置**: `src/secrets.js`
**说明**: 将 `sk-...` 与 `Bearer ...` 替换为 `[API_KEY已隐藏]`；**辅助导出** `SECRET_PATTERN`

## 数据结构

### `Character`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 角色标识；默认角色为 `default`，导入卡为 `card-<base36 时间戳>` |
| `name` | `string` | 角色名 |
| `systemPrompt` | `string` | 人设 / 系统提示词的原始文本（界面输入框绑定） |
| `systemPromptComposed` | `string?` | 保存/导入时合成的最终系统提示词，聊天优先使用 |
| `description` | `string?` | 角色描述（角色卡导入，参与合成） |
| `personality` | `string?` | 性格 |
| `scenario` | `string?` | 场景 |
| `firstMes` | `string?` | 开场白 |
| `mesExample` | `string?` | 对话示例 |
| `creatorNotes` | `string?` | 作者注释 |
| `postHistoryInstructions` | `string?` | 历史后指令 |
| `tags` | `string[]?` | 标签 |
| `worldInfo` | `WorldInfoEntry[]?` | 世界书条目，结构见[世界书](./专有概念/世界书.md) |
| `regexScripts` | `RegexScript[]?` | 正则脚本，结构见[正则脚本](./专有概念/正则脚本.md) |

### `Message`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 消息标识，形如 `<时间戳>-user` / `<时间戳>-assistant` |
| `role` | `'user' \| 'assistant' \| 'system-error'` | 消息角色 |
| `text` | `string` | 展示文本 |
| `detail` | `string?` | 系统报错消息的脱敏详情 |
| `pending` | `boolean?` | 占位消息标记，为真时不持久化 |

流式回复期间，助手消息的 `pending` 保持为真、`text` 随每个增量片段实时覆盖；流正常结束时 `pending` 置为假，随后才进入持久化，确保「正在思考…」不会落盘。若请求在流中途失败且已收到部分文本，则把该部分文本转为已完成助手消息予以保留，并额外追加一条 `system-error` 消息（`id` 为助手占位 `id` 加后缀 `-error`）；若失败时仍无任何文本，则占位直接替换为 `system-error`。

### `ApiConfig`

| 字段 | 类型 | 说明 |
|------|------|------|
| `baseUrl` | `string` | 接口地址 |
| `model` | `string` | 模型名 |
| `apiKey` | `string` | 密钥，仅存本机 |
