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
- 依赖 `useApp()` 获取 `character`、`characters`、`activeId`、`loaded`、`switchCharacter`、`activeSessionId`、`ensureCharacterSession`，派生 `characterId = character.id || 'default'`
- 顶部栏展示当前角色名，点击弹出 `Modal` 角色列表；点选先 `switchCharacter` 再 `ensureCharacterSession`，中断进行中的请求
- 顶部栏右侧「公告」按钮弹出 `DisclaimerModal` 再次展示免责条款
- `activeSessionId` 变化时按会话加载消息（`getMessagesBySession`），并在加载期间禁用输入与发送；无可用会话时渲染空列表
- 迟到回复由 `src/chatRace.js` 的 `isStaleReply(currentId, sendId)` 与会话 `id` 比对共同守卫，在 `onChunk`、`setMessages` 与错误原文写入处被丢弃
- `persistableMessages` 过滤 `pending` 后通过快照比对决定是否落盘，写入走 `saveMessagesBySession`
- `renderedMessages` 对助手消息应用 placement 2、对用户消息应用 placement 1 的展示正则（mode `display`），原始文本仍用于落盘

**消息角色常量**: `user`、`assistant`、`system-error`
**密钥脱敏**: 来自 `src/secrets.js` 的 `SECRET_PATTERN = /(sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9\-_]+)/g` 与 `maskSecrets`，替换为 `[API_KEY已隐藏]`

### `CharacterScreen`（默认导出）
**位置**: `src/CharacterScreen.js`
**Props**: 无
**状态**: `name`、`systemPrompt`、`description`、`personality`、`scenario`、`firstMes`、`worldInfo`、`regexScripts`、`expandedWorld`、`expandedRegex`、`importing`、`seededIdRef`
**行为**:
- 顶部渲染「角色库」列表：按最近使用降序，当前角色高亮并标「当前」；点选条目调用 `switchCharacter`
- 「新建角色」调用 `addCharacter({ name: '新角色' })` 得到空白角色；非默认角色条目可删除，二次确认后调用 `deleteCharacter` 并连同聊天记录移除
- 当前角色 `id` 变化时用 Context 中的角色回填全部可编辑字段（`seededIdRef` 保证每个角色仅回填一次）
- `save()` 组装 `{ id, name, systemPrompt, systemPromptComposed, description, personality, scenario, firstMes, worldInfo, regexScripts }` 并调用 `updateCharacter`（浅合并）；`systemPromptComposed` 由 `buildSystemPrompt` 用核心字段合成
- `importCard()` 通过 `DocumentPicker` 选取 `image/png` 或 `application/json`，读取为 Base64 后解析，并经 `addCharacter` 加入角色库并设为当前角色
- PNG 无 `chara`/`ccv3` 文本块时提示「该图片不包含角色卡数据，请上传角色卡 JSON 文件或含数据的 PNG 图片。」；解析异常提示脱敏后的错误详情
- 世界书与正则以可折叠区块编辑（默认收起），支持逐条修改与增删；对话示例/作者注释/历史后指令/标签为只读

### `SettingsScreen`（默认导出）
**位置**: `src/SettingsScreen.js`
**Props**: 无
**状态**: `configs`、`activeId`、`loaded`、`userName`、`userPersona`、`userAvatarUri`、`presets`、`presetEnabled`、`presetModalOpen`、`editingPreset`、`presetForm`
**行为**: 挂载时读取多配置列表与当前活跃 `id`；可新建、删除、点选切换配置；保存前对当前选中的配置做 HTTP 明文地址确认；增删改都立即持久化整套配置列表。另有全局对话预设的开关与增删改（弹窗编辑名称/描述/提示词），以及「免责条款」入口复用 `DISCLAIMER_TEXT`。

## 全局状态

### `AppProvider`
**位置**: `src/context/AppContext.js`
**Props**: `children`

### `useApp()` 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `character` | `Character` | 当前角色（由 `activeId` 在角色库中解析，缺失时回退默认角色） |
| `characters` | `Character[]` | 角色库，按最近使用降序 |
| `activeId` | `string` | 当前角色 `id` |
| `loaded` | `boolean` | 角色库与当前角色是否已从存储加载完成 |
| `updateCharacter` | `(patch) => Promise<Character>` | 合并并持久化当前角色更新 |
| `switchCharacter` | `(id) => Promise<Character>` | 切换当前角色并更新其 `lastUsedAt` |
| `addCharacter` | `(character) => Promise<Character>` | 以唯一 `id` 新增角色并设为当前角色 |
| `deleteCharacter` | `(id) => Promise<Character[]>` | 删除非默认角色及其消息，必要时切换当前角色 |
| `sessions` | `Session[]` | 全部会话，置顶优先、按更新时间降序 |
| `activeSessionId` | `string` | 当前会话 `id`，无可用会话时为空串 |
| `switchSession` | `(id) => Promise<Session>` | 切换当前会话并持久化指针 |
| `pinSession` | `(id) => Promise<Session[]>` | 切换会话置顶标记并持久化排序结果 |
| `cloneSession` | `(id) => Promise<Session>` | 克隆会话并加入列表，不改变当前会话 |
| `deleteSession` | `(id) => Promise<{ sessions, activeSessionId, created }>` | 删除会话，必要时新建空会话并设为当前 |
| `refreshSessions` | `() => Promise<Session[]>` | 从存储重新读取会话与当前指针并同步状态 |
| `ensureCharacterSession` | `(characterId) => Promise<Session>` | 激活该角色最近更新的会话；无会话时新建空会话 |

**契约**:
1. 未加载完成时 `updateCharacter`/`switchCharacter`/`addCharacter`/`deleteCharacter` 抛出 `Error('角色尚未加载完成')`
2. 所有写操作先在内存乐观更新，再持久化；失败时回滚内存快照并重新抛出（`runWithRollback`）
3. `switchCharacter` 对不存在的 `id` 抛出 `Error('角色不存在')`
4. `deleteCharacter` 对默认角色抛出 `Error('默认角色不可删除')`
5. 未加载完成时 `switchSession`/`pinSession`/`cloneSession`/`deleteSession` 抛出 `Error('会话尚未加载完成')`
6. 会话写操作同样乐观更新并在失败时回滚；`switchSession`/`pinSession`/`cloneSession` 对不存在的会话 `id` 抛出 `Error('会话不存在')`
7. 加载时对无效的当前会话 `id` 回退到排序后的首个会话，回退结果会写回存储

### `characterLibrary` 辅助函数
**位置**: `src/context/characterLibrary.js`（纯函数，供 `AppContext` 与测试使用）

| 函数 | 说明 |
|------|------|
| `resolveActiveId(list, activeId)` | 校验当前角色 `id`，无效时回退默认角色 |
| `uniqueId(base, list)` | 生成库内唯一 `id`，冲突时追加 `-2`、`-3` |
| `withUpdatedCharacter(list, activeId, patch)` | 返回更新后的列表与被更新角色 |
| `withSwitchedCharacter(list, id, now)` | 返回切换后（含 `lastUsedAt`）的列表与目标角色 |
| `withAddedCharacter(list, character, now)` | 返回新增并排序后的列表与新角色 |
| `withDeletedCharacter(list, id, activeId)` | 返回删除后的列表与回退后的当前 `id` |
| `runWithRollback(snapshot, restore, persist)` | 持久化失败时恢复快照并重新抛出 |

### `sessionLibrary` 辅助函数
**位置**: `src/context/sessionLibrary.js`（纯函数，供 `storage` 与 `AppContext` 使用）

| 函数 | 说明 |
|------|------|
| `makeSessionId(now?)` | 生成 `session-<base36 时间戳>-<随机>` 形式的新会话 `id` |
| `uniqueSessionId(base, list)` | 生成库内唯一会话 `id`，冲突时追加 `-2`、`-3` |
| `normalizeSession(raw, index?)` | 规范会话字段与类型，缺失补默认 |
| `sortSessions(list)` | 置顶优先、其次 `updatedAt` 降序、并列 `id` 升序 |
| `buildPreview(messages, maxLength?)` | 取最后一条可读消息生成摘要，默认截断 60 字 |
| `regenerateMessageIds(messages, now?)` | 重新生成消息 `id`，用于克隆 |
| `resolveActiveSessionId(sessions, activeId)` | 校验当前会话 `id`，无效时回退首个会话 |
| `createEmptySession(characterId, sessions, now?)` | 构造未置顶空会话 |
| `buildClonedSession(sessions, source, messages, now?)` | 构造克隆会话（未置顶、记录 `clonedFrom`） |

## 持久化接口

**位置**: `src/storage.js`

| 函数 | 签名 | 说明 |
|------|------|------|
| `getApiConfigs` | `() => Promise<{ configs, activeId }>` | 读取多配置列表与当前活跃 id；旧单条配置自动迁移 |
| `saveApiConfigs` | `(configs, activeId) => Promise<{ configs, activeId }>` | 写入多配置列表与活跃 id |
| `getActiveApiConfig` | `() => Promise<ApiConfig>` | 返回当前活跃配置（至少一条） |
| `createApiConfig` | `(partial) => ApiConfig` | 创建一条标准化配置（含唯一 id） |
| `getCharacterLibrary` | `() => Promise<Character[]>` | 读取并排序角色库；库键缺失时迁移旧键并补入默认角色 |
| `saveCharacterLibrary` | `(list) => Promise<Character[]>` | 排序、补默认角色后写入角色库 |
| `getActiveCharacterId` | `() => Promise<string>` | 读取当前角色 `id`（缺失或损坏返回空串） |
| `setActiveCharacterId` | `(id) => Promise<void>` | 写入当前角色 `id` |
| `getActiveCharacter` | `() => Promise<Character>` | 组合读取当前角色，无效 `id` 回退默认并修正 |
| `upsertCharacter` | `(character) => Promise<Character[]>` | 按 `id` 新增或替换一个角色 |
| `deleteCharacter` | `(characterId) => Promise<Character[]>` | 删除非默认角色并移除其消息键 |
| `sortCharacters` | `(list) => Character[]` | 按 `lastUsedAt` 降序、并列按 `id` 升序排序 |
| `getCharacter` / `saveCharacter` | 见下 | 过渡包装：`getActiveCharacter` / `upsertCharacter` + 设为当前 |
| `getMessages` | `(characterId?) => Promise<Message[]>` | 读取指定角色消息，过滤 `pending`（旧接口，过渡期保留） |
| `saveMessages` | `(characterId, messages) => Promise<void>` | 写入指定角色消息，过滤 `pending`（旧接口，过渡期保留） |
| `getSessions` | `() => Promise<Session[]>` | 读取会话列表，规范化并去重 `id` |
| `saveSessions` | `(sessions) => Promise<Session[]>` | 规范化并写入会话列表 |
| `getActiveSessionId` | `() => Promise<string>` | 读取当前会话 `id`（缺失或损坏返回空串） |
| `setActiveSessionId` | `(id) => Promise<void>` | 写入当前会话 `id` |
| `getMessagesBySession` | `(sessionId) => Promise<Message[]>` | 按会话读取消息，过滤 `pending` |
| `saveMessagesBySession` | `(sessionId, messages) => Promise<Message[]>` | 按会话写入消息，过滤 `pending`，并同步会话预览与更新时间 |
| `startNewSession` | `(characterId) => Promise<Session>` | 清理无消息会话，新建空会话并设为当前 |
| `cloneSession` | `(sessionId) => Promise<Session>` | 复制会话元数据与消息，消息 `id` 重新生成，副本未置顶 |
| `deleteSession` | `(sessionId) => Promise<{ sessions, activeSessionId, created }>` | 删除会话与消息；删除当前会话时新建空会话 |
| `migrateLegacyMessages` | `(characters) => Promise<Session[]>` | 将旧键消息迁移为历史会话，幂等 |
| `saveCharacterState` | `(list, activeId, deletedId?) => Promise<void>` | 事务性写入角色库与当前 id，第二步失败时回滚角色库；`deletedId` 存在时移除其消息键 |
| `getUserProfile` / `saveUserProfile` | 见下 | 读取/写入用户人设（用户名、人设、头像路径） |
| `getGlobalPresets` | `() => Promise<Preset[]>` | 读取预设列表；键缺失时由内置预设播种 |
| `saveGlobalPresets` | `(presets) => Promise<Preset[]>` | 校验并写入预设列表（ID/名称/提示词非空、ID 不重复） |
| `createGlobalPresetId` | `(presets) => Promise<string>` | 生成未与列表及开关键冲突的预设 `id` |
| `getGlobalPresetSettings` | `() => Promise<Record<string, boolean>>` | 读取按当前预设归一化后的开关映射 |
| `saveGlobalPresetSettings` | `(enabled) => Promise<Record<string, boolean>>` | 归一化并写入开关映射 |
| `getEnabledGlobalPresetPrompts` | `() => Promise<string[]>` | 返回已开启预设的提示词，供请求组装 |
| `isDisclaimerAcknowledged` | `() => Promise<boolean>` | 是否已确认免责条款 |
| `acknowledgeDisclaimer` | `() => Promise<boolean>` | 写入免责条款已确认标记 |

**导出的默认值**:
- `DEFAULT_CHARACTER` 含 `id`、`name`、`systemPrompt`、`systemPromptComposed`、`lastUsedAt`，以及扩展字段 `description`、`personality`、`scenario`、`firstMes`、`mesExample`、`creatorNotes`、`postHistoryInstructions`、`tags`、`worldInfo`、`regexScripts`（后四类缺省为空串/空数组）

**AsyncStorage 键约定**:

| 键 | 内容 |
|----|------|
| `@easychat2_api_configs` | API 多配置 `{ configs, activeId }` |
| `@easychat2_api_config` | 旧版单条 API 配置（仅迁移读取，保留） |
| `@easychat2_characters` | 角色库 JSON 数组 |
| `@easychat2_active_character` | 当前角色 `id` |
| `@easychat2_character` | 旧版单角色 JSON（仅迁移读取，保留） |
| `@easychat2_sessions` | 会话元数据数组 |
| `@easychat2_active_session` | 当前会话 `id` |
| `@easychat2_messages::<sessionId>` | 会话消息数组（新数据按会话 id 存储） |
| `@easychat2_messages::<characterId>` | 旧版按角色存储的消息（仅迁移读取） |
| `@easychat2_messages` | 旧版单会话消息（仅默认角色迁移读取时兜底） |
| `@easychat2_user_profile` | 用户人设 `{ userName, persona, avatarUri }` |
| `@easychat2_preset_list` | 全局对话预设数组 |
| `@easychat2_global_presets` | 预设开关映射 `{ [presetId]: boolean }` |
| `@easychat2_disclaimer_ack` | 免责条款已读标记（`'true'`） |

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

## 聊天竞态接口

### `isStaleReply(currentCharacterId, sendCharacterId)`
**位置**: `src/chatRace.js`
**返回**: `boolean` - 当前角色与发起请求时的角色不同时返回 `true`
**用途**: `ChatScreen` 在 `onChunk`、`setMessages` 与错误原文写入处据此丢弃切换角色后的迟到回复

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

### `DISCLAIMER_TEXT` / `DisclaimerModal`
**位置**: `src/disclaimer.js`
**说明**: `DISCLAIMER_TEXT` 为免责条款纯文本；`DisclaimerModal`（默认导出）Props 为 `{ visible, title?, content?, onClose }`，`content` 缺省为 `DISCLAIMER_TEXT`，用于启动弹窗与聊天「公告」

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
| `lastUsedAt` | `number?` | 最近一次成为当前角色的时间戳，决定列表排序 |

### `Message`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 消息标识，形如 `<时间戳>-user` / `<时间戳>-assistant` |
| `role` | `'user' \| 'assistant' \| 'system-error'` | 消息角色 |
| `text` | `string` | 展示文本 |
| `detail` | `string?` | 系统报错消息的脱敏详情 |
| `pending` | `boolean?` | 占位消息标记，为真时不持久化 |

流式回复期间，助手消息的 `pending` 保持为真、`text` 随每个增量片段实时覆盖；流正常结束时 `pending` 置为假，随后才进入持久化，确保「正在思考…」不会落盘。若请求在流中途失败且已收到部分文本，则把该部分文本转为已完成助手消息予以保留，并额外追加一条 `system-error` 消息（`id` 为助手占位 `id` 加后缀 `-error`）；若失败时仍无任何文本，则占位直接替换为 `system-error`。

### `Session`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 会话标识，形如 `session-<base36 时间戳>-<随机>`；迁移会话为 `legacy-<characterId>` |
| `characterId` | `string` | 所属角色 `id` |
| `preview` | `string` | 最后一条可读消息的摘要，最长 60 字 |
| `pinned` | `boolean` | 是否置顶 |
| `createdAt` | `number` | 创建时间戳 |
| `updatedAt` | `number` | 最后更新时间戳，决定排序 |
| `clonedFrom` | `string` | 克隆来源会话 `id`，非副本为空串 |

排序规则：置顶优先，其余按 `updatedAt` 降序，并列按 `id` 升序。空会话（无消息）不进入列表。

### `ApiConfig`

| 字段 | 类型 | 说明 |
|------|------|------|
| `baseUrl` | `string` | 接口地址 |
| `model` | `string` | 模型名 |
| `apiKey` | `string` | 密钥，仅存本机 |
