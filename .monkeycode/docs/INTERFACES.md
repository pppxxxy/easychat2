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

**消息角色常量**: `user`、`assistant`、`system-error`
**密钥脱敏正则**: `/(sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9\-_]+)/g`，替换为 `[API_KEY已隐藏]`

### `CharacterScreen`（默认导出）
**位置**: `src/CharacterScreen.js`
**Props**: 无
**状态**: `name`、`systemPrompt`、`importing`、`seededRef`
**行为**:
- 首次加载完成后用 Context 中的角色回填输入框（仅一次）
- `save()` 组装 `{ id, name, systemPrompt }` 并调用 `updateCharacter`
- `importCard()` 通过 `DocumentPicker` 选取 `image/png` 或 `application/json`，读取为 Base64 后解析

### `SettingsScreen`（默认导出）
**位置**: `src/SettingsScreen.js`
**Props**: 无
**状态**: `baseUrl`、`model`、`apiKey`
**行为**: 挂载时读取配置；保存前若地址匹配 `/^http:\/\//i` 则弹出明文传输风险确认。

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
- `DEFAULT_CHARACTER = { id: 'default', name: 'EasyChat2 助手', systemPrompt: '你是 EasyChat2 的智能助手，回答简洁清晰。' }`

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

### `sendChatMessage(messages)`
**位置**: `src/api.js`

| 参数 | 类型 | 说明 |
|------|------|------|
| `messages` | `Array<{ role, content }>` | 完整消息数组，含 `system`、历史与最新用户消息 |

**返回**: `Promise<string>` - `choices[0].message.content`，为空时返回 `'没有收到回复。'`

**异常**:
- 未配置 Key：`Error('请先在“设置”里填写 API Key。')`
- 超时：`Error('请求超时，请检查网络后重试')`
- 非 2xx：由 `formatApiError` 提取后端错误信息
- 响应无法解析：`Error('接口返回了无法解析的内容。')`

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
Authorization: Bearer <API_KEY>

{
  "model": "<model>",
  "messages": [{ "role": "system", "content": "..." }],
  "stream": false
}
```

预期响应：

```json
{
  "choices": [
    { "message": { "role": "assistant", "content": "..." } }
  ]
}
```

**超时**: 30 秒，通过 `AbortController` 触发。

## 数据结构

### `Character`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 角色标识；默认角色为 `default`，导入卡为 `card-<base36 时间戳>` |
| `name` | `string` | 角色名 |
| `systemPrompt` | `string` | 人设 / 系统提示词 |

### `Message`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 消息标识，形如 `<时间戳>-user` / `<时间戳>-assistant` |
| `role` | `'user' \| 'assistant' \| 'system-error'` | 消息角色 |
| `text` | `string` | 展示文本 |
| `detail` | `string?` | 系统报错消息的脱敏详情 |
| `pending` | `boolean?` | 占位消息标记，为真时不持久化 |

### `ApiConfig`

| 字段 | 类型 | 说明 |
|------|------|------|
| `baseUrl` | `string` | 接口地址 |
| `model` | `string` | 模型名 |
| `apiKey` | `string` | 密钥，仅存本机 |
