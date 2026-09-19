# 接口文档

本文档描述 EasyChat2 的内部模块接口与外部契约。应用为前端形态，接口分为四类：界面组件、全局状态、持久化与网络。

## 界面组件

### `App`（默认导出）
**位置**: `App.js`
**职责**: 注册手势根节点、安全区、全局 `AppProvider`、导航容器与底部标签导航。

| 标签页名称 | 组件 | 说明 |
|-----------|------|------|
| `聊天` | `ChatScreen` | 对话与消息列表 |
| `记忆` | `MemoryScreen` | 历史会话列表与操作 |
| `角色` | `CharacterScreen` | 角色编辑与角色卡导入 |
| `扩展` | `ExtensionScreen` | 内嵌小游戏与生图 |
| `设置` | `SettingsScreen` | API 配置 |

导航主题在 `App.js` 内由当前语义色板扩展 `DefaultTheme` 生成，Header、状态栏与底部标签栏颜色均取自 `useTheme()`。`Header` 组件使用 `useSafeAreaInsets` 计算顶部内边距。

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
- 顶部栏下方常驻一行小号浅灰提示「AI 生成可能有误，仅供参考」，仅聊天页展示，不随消息滚动
- 导航聚焦时读取 `@easychat2_chat_options`：`streaming` 决定请求体是否流式，`fullWidth` 决定消息气泡使用全宽还是限宽样式
- 消息操作行提供「引用」：引用目标以引用块展示在输入区上方，可取消；发送时用户消息写入可选 `quoted` 字段并把引用注入请求；气泡内引用块位于正文之上，点击复用会话内定位滚动到原消息，原消息不存在时提示且不报错
- 助手回复完成后本地评估好感与轮次（无额外网络请求），命中好感上下限、50/100 轮或特殊大事且未触发过时生成一条朋友圈动态；开关关闭时不生成
- 助手消息保存可选 `inlineImage` 字段；并持久化：开启时助手回复完成自动播报，发送新消息或关闭开关时停止；助手消息提供「播报」手动重播
- 助手消息可按需生成配图（气泡下方按钮）或随自动配图开关自动生成：生成中展示加载态，失败展示重试，完成把 `inlineImage` 随消息持久化（`loading`/`error` 不落盘）；同一时刻仅允许一个配图请求
- 顶部栏提供「新建」按钮为当前角色开启新会话（群聊则按相同成员新建），旧会话保留在记忆页；空会话时提示且不创建，成功后清空消息、附件、引用与搜索状态
- 顶部栏常驻元素为：角色头像与名称、播报开关、「新建」与「⋯」更多菜单；「⋯」菜单收纳公告、模型、思考、定位、搜索、总结与设置，点选执行与折叠前一致的操作（定位无消息时禁用、总结进行中禁用、搜索反映开启态），菜单以浮层呈现不改变消息列表滚动位置
- 「⋯」菜单的「设置」打开聊天设置弹窗，提供「系统设置」（跳转设置页）与「编辑角色」（群聊隐藏并提示）两个入口
- `activeSessionId` 变化时按会话加载消息（`getMessagesBySession`），并在加载期间禁用输入与发送；无可用会话时渲染空列表
- 发送前按会话 `summarizedUpTo` 截断历史，并把 `buildMemorySummaryText(character)` 作为 `summaryText` 传入 `buildRequestMessages`，实现请求压缩
- 角色页切换角色时同步切换会话（`ensureCharacterSession`）；记忆页打开群聊不依赖基础角色存在
- 顶部栏提供「总结」按钮手动触发记忆总结（忽略开关，进行中禁用）；收到回复后若开关开启且达到阈值则自动总结一次，失败时 `Alert` 且不更新边界
- 消息落库后若向量记忆开启，异步增量索引当前角色片段（已存在片段跳过，失败静默）；发送前按用户输入召回若干片段，经 `buildMemoryContext` 生成 `[相关记忆]` 注入请求；未配置或请求失败自动回退本地关键词检索；索引为空时不注入
- 顶部栏「搜索」按钮展开会话内搜索条：标记全部命中、显示第 x/n 条并支持上一个/下一个滚动定位；关闭时清除高亮
- 记录每条消息的布局偏移；消费 `pendingTarget` 后滚动定位并高亮目标消息，目标不存在时不定位
- 输入栏附件入口可选择纯文本类文档或图片：文本文档读取内容并在发送时以 `[附件：名称]` 并入上下文；图片仅当来源支持识图时允许，并以多模态形式发送；已选附件以标签与缩略图展示、可移除
- 输入栏最右提供全屏输入入口，全屏界面提供发送与右上角关闭，退出保留文本
- 顶部栏「模型」按钮打开切换面板：先列来源再列模型，选择后更新该来源当前模型并持久化
- 顶部栏「思考」按钮打开思考设置：开关与深度（低/中/高），按来源声明的字段与格式注入请求；来源不支持思考时禁用
- 助手消息保存可选 `reasoning` 与 `inlineImage` 字段；生成中经 `onReasoning` 实时更新。导航聚焦时读取思考设置的 `display`，按 `open` 完整展开、`fold` 折叠一行可展开、`off` 不展示
- 顶部栏「定位」按钮打开 `ScrollScrubber`（无消息时禁用）：拖动按索引定位，支持回到开头与最新
- 发送前读取已开启插件并执行 `runPlugins`，命中触发词时把联网搜索结果作为 `pluginContext` 注入；失败静默降级
- 群聊会话（`type: 'group'`）：顶部展示群名与群图标；发送时解析 `@` 并调度 1-3 个发言角色，逐个以各自角色卡设定回复并展示发言者头像与名字；每个角色的请求注入 `[群聊情境]`（在场成员名单 + 简介 + 最近发言 + 最近对话），简介不足（< 30 字）的成员经 `ensureMemberProfiles` 懒生成人设卡并缓存到会话 `memberProfiles`；同轮后发言角色可见前述角色发言；单角色失败生成错误气泡后继续；空群聊首次进入生成开场白；群聊不提供重新生成
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
- 世界书与正则以可折叠区块编辑（默认收起），支持逐条修改与增删；作者注释/历史后指令为只读
- 可编辑「备用开场白」（多条增删改）、「对话示例」（多行，注入系统提示词）、「拍一拍文案」与「标签」
- 「全局预设」入口位于世界书与正则区块之后
- 角色库支持搜索（名称与标签）、星标置顶、多选与全选删除（全选需输入确认）；角色卡提供「群聊」按钮，打开多选面板（2-8 个角色、群名可留空），创建群聊会话后刷新会话并切换到聊天页

### `SettingsScreen`（默认导出）
**位置**: `src/SettingsScreen.js`
**Props**: 无
**状态**: `configs`、`activeId`、`loaded`、`userName`、`userPersona`、`userAvatarUri`、`presetEntryOpen`、`enabledPresetCount`、`sampling`
**行为**: 挂载时读取多配置列表与当前活跃 `id`；可新建、删除、点选切换配置；每个来源维护模型列表（输入添加、点击设为当前、可删除，至少保留一个），「检测模型」结果加入列表；保存前对 HTTP 明文地址与方法能力（支持思考 / 支持识图）分别确认；增删改都立即持久化整套配置列表。「全局配置」卡片提供「全局预设」入口（副标题显示已开启数量或「未开启」），点击打开 `PresetPanel`，关闭时刷新计数。另有「生成参数」卡片：最大回复令牌 / 温度 / top-p / top-k 四项，每项含独立开关与数值输入，输入失焦时夹取到范围并在越界时提示，仅开启项随请求发送。「用户人设」卡片管理多人设：以 chip 列表展示，点击切换当前人设，`+ 新增` 创建并设为当前，逐个可删除（至少保留一个，删除当前时自动切到剩余首项）；名字与人设描述编辑当前人设，头像与拍一拍文案为全局共用。「向量记忆」卡片提供开关、接口地址、密钥（密文）、模型、召回条数、分片长度与「测试连接」，未配置或失败时聊天侧自动降级为关键词检索。「关于」卡片提供「使用教程」入口，打开 `TutorialModal` 图文教程（聊天/记忆/角色/设置四章），只读静态内容；另有「免责条款」入口复用 `DISCLAIMER_TEXT`。

### `CharacterEditForm`（默认导出）
**位置**: `src/CharacterEditForm.js`
**Props**: `{ visible, character, onClose, onSaved }`
**行为**:
- 底部抽屉式 `Modal`，编辑当前角色的常用字段：名称、头像、背景、人设/系统提示词、角色描述、性格、场景、开场白、备用开场白（逐条增删改）、对话示例、拍一拍文案与标签
- 打开时以 `character` 初始化草稿；保存时经 `useApp().updateCharacter` 写入，并重建 `systemPromptComposed`
- 保存成功回调 `onSaved`；失败 `Alert` 并保留草稿不清空
- 世界书与正则脚本不在此表单内，界面提示前往「角色」页编辑
- 供聊天页「编辑角色」使用；角色页保留其完整编辑界面

### `PresetPanel`（默认导出）
**位置**: `src/PresetPanel.js`
**Props**: `{ visible, onClose }`
**行为**:
- `visible` 变为真时读取预设、开关映射与记忆总结设置
- 列出全部预设（名称、描述、启用开关），开关切换即时保存；点击条目打开编辑弹窗
- 提供新增与编辑（名称、描述、提示词）以及删除二次确认，删除同时移除其开关记录
- 列表之外提供「记忆总结」开关与触发阈值输入，阈值只接受大于 0 的整数，非法回退 40
- 设置页与角色编辑页共用该组件；关闭时提交未保存的阈值

### `MemoryScreen`（默认导出）
**位置**: `src/MemoryScreen.js`
**Props**: `navigation`（由导航注入）
**行为**:
- 从 `useApp()` 读取 `sessions`、`characters`、`loaded` 与会话操作，只展示摘要非空的会话（空会话不占行）
- 每行展示角色头像、角色名、摘要与更新时间；克隆产生的会话在角色名后显示「副本」标识，置顶会话显示星标；群聊会话展示叠放成员头像与群名
- 点击行先 `switchCharacter` 再 `switchSession`，随后 `navigation.navigate('聊天')`
- 右侧提供置顶、克隆、删除三个按钮；克隆与删除弹二次确认，失败时 `Alert`
- 顶部「编辑」入口（存在会话时显示）进入编辑模式，每行显示勾选框，底部操作条提供「全选」与「删除（N）」并二次确认，成功后退出编辑模式
- 编辑模式下点击行切换选中且不打开会话，隐藏行内操作按钮
- 列表为空时展示空状态

### `SearchScreen`（默认导出）
**位置**: `src/SearchScreen.js`
**Props**: `{ visible, onClose, onOpenResult, characters }`
**行为**:
- 全屏 Modal，输入关键词后调用 `searchMessages`，展示命中片段、角色名与时间；空结果显示提示
- 关键词为空时不搜索
- 点击结果调用 `onOpenResult(result)`，由记忆页完成切换角色、切换会话与设置定位目标

### `ScrollScrubber`（默认导出）
**位置**: `src/ScrollScrubber.js`
**Props**: `{ visible, onClose, messageCount, previews, onSeek, onToStart, onToEnd }`
**行为**:
- 覆盖层内渲染竖向轨道与滑块，用 `PanResponder` 拖动，按滑动比例映射消息索引（`indexFromRatio`）
- 轨道上方「回到开头」、下方「回到最新」分别调用 `onToStart` / `onToEnd`；松手时以映射索引调用 `onSeek`
- 消息数超过 30 时拖动显示预览卡（时间、发言者、缩略与位置）；无消息时按钮禁用
**辅助导出**: `indexFromRatio(ratio, messageCount)`

### `PluginPanel`（默认导出）
**位置**: `src/PluginPanel.js`
**Props**: `{ visible, onClose }`
**行为**:
- 打开时读取联网搜索列表，列出名称、描述与启用开关
- 联网搜索插件可配置搜索服务（SerpAPI / Google CSE / Bing / 自定义）、API 密钥（密文展示，可切换明暗）、Google CSE 的 `cx`、自定义接口地址与结果条数（1-10）
- 开关即时保存；开启联网搜索但未填密钥（或自定义地址）时提示先填写
- 关闭时保存未提交的配置

## 全局状态

### `ThemeProvider`
**位置**: `src/theme/ThemeContext.js`
**Props**: `children`
**说明**: 加载并持久化 `@easychat2_appearance`，向全应用提供主题与字体缩放。`useTheme()` 在无 Provider 时回退默认主题，便于脚本测试。

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `{ id, label, colors }` | 当前主题，`colors` 为语义令牌（`background`、`surface`、`surfaceAlt`、`surfaceBorder`、`divider`、`primary`、`primaryMuted`、`primarySoft`、`primaryContrast`、`text`、`textMuted`、`textFaint`、`danger`、`dangerSoft`、`overlay`、`star`、`bubbleAssistant`、`bubbleAssistantText`） |
| `themes` | `Array` | 五套预设主题 |
| `themeId` / `setThemeId` | `string` / `(id) => void` | 当前主题 id 与切换 |
| `fontScaleId` / `setFontScaleId` | `string` / `(id) => void` | 当前字体档位与切换 |
| `fontScales` | `Array` | 六档字体（`default` / `system` / `small` / `medium` / `large` / `xlarge`） |
| `fonts.scaled(size)` | `(number) => number` | 按当前档位缩放字号；`system` 取 `PixelRatio.getFontScale()` |

### `AppProvider`
**位置**: `src/context/AppContext.js`
**Props**: `children`

### `useApp()` 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `character` | `Character` | 当前角色（由 `activeId` 在角色库中解析，缺失时回退默认角色）；含可选 `pinned` 与 `tags` |
| `characters` | `Character[]` | 角色库，按最近使用降序 |
| `activeId` | `string` | 当前角色 `id` |
| `loaded` | `boolean` | 角色库与当前角色是否已从存储加载完成 |
| `updateCharacter` | `(patch) => Promise<Character>` | 合并并持久化当前角色更新 |
| `switchCharacter` | `(id) => Promise<Character>` | 切换当前角色并更新其 `lastUsedAt` |
| `addCharacter` | `(character) => Promise<Character>` | 以唯一 `id` 新增角色并设为当前角色 |
| `pinCharacter` | `(id, pinned) => Promise<Character>` | 切换角色置顶并持久化，置顶优先排序 |
| `deleteCharacters` | `(ids) => Promise<Character[]>` | 批量删除角色；删除当前角色时切换；至少保留一个 |
| `deleteCharacter` | `(id) => Promise<Character[]>` | 删除非默认角色及其消息，必要时切换当前角色 |
| `sessions` | `Session[]` | 全部会话，置顶优先、按更新时间降序 |
| `activeSessionId` | `string` | 当前会话 `id`，无可用会话时为空串 |
| `switchSession` | `(id) => Promise<Session>` | 切换当前会话并持久化指针 |
| `pinSession` | `(id) => Promise<Session[]>` | 切换会话置顶标记并持久化排序结果 |
| `cloneSession` | `(id) => Promise<Session>` | 克隆会话并加入列表，不改变当前会话 |
| `deleteSession` | `(id) => Promise<{ sessions, activeSessionId, created }>` | 删除会话，必要时新建空会话并设为当前 |
| `deleteSessions` | `(ids) => Promise<Session[]>` | 批量删除多个会话；包含当前会话时先新建空会话再删除 |
| `refreshSessions` | `() => Promise<Session[]>` | 从存储重新读取会话与当前指针并同步状态 |
| `ensureCharacterSession` | `(characterId) => Promise<Session>` | 激活该角色最近更新的会话；无会话时新建空会话 |
| `pendingTarget` | `{ sessionId, messageId } \| null` | 待定位的消息目标，供聊天页消费 |
| `setPendingTarget` | `(target) => void` | 设置待定位目标；参数不完整时置空 |
| `consumePendingTarget` | `() => { sessionId, messageId } \| null` | 读取并清空待定位目标 |

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
| `getActiveModel` | `(config) => string` | 返回配置的当前模型，回退列表首项与默认模型 |
| `getThinkingSettings` | `() => Promise<{ enabled, level }>` | 读取思考设置，默认 `{ enabled: false, level: 'medium' }` |
| `saveThinkingSettings` | `({ enabled, level }) => Promise<{ enabled, level }>` | 归一化并写入思考设置（`level` 为 `low`/`medium`/`high`） |
| `getSamplingSettings` | `() => Promise<Sampling>` | 读取生成采样设置，缺省四项均关闭（maxTokens 8024 / temperature 1 / topP 1 / topK 0） |
| `saveSamplingSettings` | `(Sampling) => Promise<Sampling>` | 夹取范围并整数化后写入采样设置 |
| `getVectorMemoryConfig` / `saveVectorMemoryConfig` | `(config?) => Promise<VectorConfig>` | 读取/写入向量记忆配置，夹取范围（topK ≤ 20、maxChars ≤ 2000、batchSize ≤ 64） |
| `getVectorIndex` / `saveVectorIndex` | `(characterId, index?) => Promise<Segment[]>` | 读取/写入按角色隔离的记忆片段索引，写入时过滤非法条目 |
| `clearVectorIndex` | `(characterId) => Promise<void>` | 清除某角色的记忆片段索引 |
| `createApiConfig` | `(partial) => ApiConfig` | 创建一条标准化配置（含唯一 id） |
| `getCharacterLibrary` | `() => Promise<Character[]>` | 读取并排序角色库；库键缺失时迁移旧键并补入默认角色 |
| `saveCharacterLibrary` | `(list) => Promise<Character[]>` | 排序、补默认角色后写入角色库 |
| `getActiveCharacterId` | `() => Promise<string>` | 读取当前角色 `id`（缺失或损坏返回空串） |
| `setActiveCharacterId` | `(id) => Promise<void>` | 写入当前角色 `id` |
| `getActiveCharacter` | `() => Promise<Character>` | 组合读取当前角色，无效 `id` 回退默认并修正 |
| `upsertCharacter` | `(character) => Promise<Character[]>` | 按 `id` 新增或替换一个角色 |
| `deleteCharacter` | `(characterId) => Promise<Character[]>` | 删除非默认角色并移除其消息键 |
| `sortCharacters` | `(list) => Character[]` | 置顶优先，其次 `lastUsedAt` 降序、并列按 `id` 升序 |
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
| `createGroupSession` | `(members, name) => Promise<Session>` | 新建群聊会话（`type: 'group'`）并设为当前 |
| `updateSessionMemberProfiles` | `(sessionId, memberProfiles) => Promise<Session\|null>` | 合并群聊成员人设卡缓存（已有键不覆盖），非群聊返回目标或 `null` |
| `cloneSession` | `(sessionId) => Promise<Session>` | 复制会话元数据与消息，消息 `id` 重新生成，副本未置顶 |
| `deleteSession` | `(sessionId) => Promise<{ sessions, activeSessionId, created }>` | 删除会话与消息；删除当前会话时新建空会话 |
| `deleteSessions` | `(sessionIds) => Promise<{ sessions, activeSessionId }>` | 批量移除多个会话的元数据并 `multiRemove` 其消息键 |
| `migrateLegacyMessages` | `(characters) => Promise<Session[]>` | 将旧键消息迁移为历史会话，幂等 |
| `searchMessages` | `(keyword) => Promise<SearchHit[]>` | 跨全部会话做不区分大小写的子串匹配，按会话 `updatedAt` 倒序返回命中 |
| `saveCharacterState` | `(list, activeId, deletedId?) => Promise<void>` | 事务性写入角色库与当前 id，第二步失败时回滚角色库；`deletedId` 存在时移除其消息键 |
| `getUserProfile` / `saveUserProfile` | 见下 | 读取/写入当前人设（用户名、人设）+ 全局头像与拍一拍文案 |
| `getPersonas` | `() => Promise<Persona[]>` | 读取人设列表；为空时把旧 `@easychat2_user_profile` 迁移为 `default` 一项并写入 |
| `savePersonas` | `(list) => Promise<Persona[]>` | 规范化并写入人设列表（空列表补默认人设） |
| `getActivePersonaId` | `(list?) => Promise<string>` | 读取当前人设 id；不存在或非法时回退列表首项 |
| `setActivePersonaId` | `(id) => Promise<string>` | 写入当前人设 id；非法 id 回退列表首项 |
| `getActivePersona` | `() => Promise<Persona>` | 返回当前人设对象 |
| `createPersona` | `(partial?) => Promise<Persona>` | 新建人设并设为当前 |
| `updatePersona` | `(id, patch) => Promise<Persona>` | 更新指定人设的名称/描述 |
| `deletePersona` | `(id) => Promise<{ personas, activeId }>` | 删除人设；少于 1 个抛错，删除当前时切到剩余首项 |
| `getGlobalPresets` | `() => Promise<Preset[]>` | 读取预设列表；键缺失时由内置预设播种 |
| `saveGlobalPresets` | `(presets) => Promise<Preset[]>` | 校验并写入预设列表（ID/名称/提示词非空、ID 不重复） |
| `createGlobalPresetId` | `(presets) => Promise<string>` | 生成未与列表及开关键冲突的预设 `id` |
| `getGlobalPresetSettings` | `() => Promise<Record<string, boolean>>` | 读取按当前预设归一化后的开关映射 |
| `saveGlobalPresetSettings` | `(enabled) => Promise<Record<string, boolean>>` | 归一化并写入开关映射 |
| `getEnabledGlobalPresetPrompts` | `() => Promise<string[]>` | 返回已开启预设的提示词，供请求组装 |
| `getMemorySummarySettings` | `() => Promise<{ enabled, threshold }>` | 读取记忆总结开关与阈值，缺失时默认 `{ enabled: false, threshold: 40 }` |
| `saveMemorySummarySettings` | `({ enabled, threshold }) => Promise<{ enabled, threshold }>` | 归一化并写入记忆总结设置，阈值非法时回退 40 |
| `getPlugins` | `() => Promise<Plugin[]>` | 读取联网搜索列表并规范化，内置项缺失时补入 |
| `savePlugins` | `(plugins) => Promise<Plugin[]>` | 规范化并写入联网搜索列表，确保内置项存在 |
| `getEnabledPlugins` | `() => Promise<Plugin[]>` | 返回已开启插件 |
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
| `@easychat2_user_profile` | 用户全局资料 `{ avatarUri, nudgeText }`（并作为旧单人设的迁移来源，兼容读取 `userName`/`persona`） |
| `@easychat2_personas` | 用户人设列表 `[{ id, userName, persona, createdAt, updatedAt }]` |
| `@easychat2_active_persona` | 当前人设 `id` |
| `@easychat2_preset_list` | 全局预设数组 |
| `@easychat2_global_presets` | 预设开关映射 `{ [presetId]: boolean }` |
| `@easychat2_disclaimer_ack` | 免责条款已读标记（`'true'`） |
| `@easychat2_memory_summary` | 记忆总结 `{ enabled, threshold }`，默认 `{ enabled: true, threshold: 40 }` |
| `@easychat2_plugins` | 联网搜索配置数组（内置 `web-search`） |
| `@easychat2_thinking` | 思考设置 `{ enabled: boolean, level: 'low' \| 'medium' \| 'high', display: 'open' \| 'fold' \| 'off' }` |
| `@easychat2_sampling` | 生成采样设置 `{ maxTokens, temperature, topP, topK }`，每项 `{ enabled, value }`，默认全关闭 |
| `@easychat2_vector_memory` | 向量记忆配置 `{ enabled, providerId, baseUrl, apiKey, model, topK, maxChars, batchSize }` |
| `@easychat2_vector_index::<characterId>` | 按角色隔离的记忆片段索引 `[{ id, messageId, role, at, text, vector }]` |
| `@easychat2_image_gen` | 生图设置 `{ activeProvider, providers: { [id]: { apiKey, baseUrl, model, extra } } }` |
| `@easychat2_chat_options` | 对话选项 `{ streaming: boolean, fullWidth: boolean }`，默认 `{ streaming: true, fullWidth: false }` |
| `@easychat2_moments_settings` | 虚拟朋友圈开关 `{ enabled: boolean }` |
| `@easychat2_moments` | 朋友圈动态数组（按时间倒序，含点赞与评论） |
| `@easychat2_affinity` | 按角色的好感状态 `{ [characterId]: { score, turnCount, triggers } }` |
| `@easychat2_tts` | 语音播报设置 `{ enabled, activeProvider, providers: { [id]: { ...fields } } }` |
| `@easychat2_inline_image` | 对话配图设置 `{ enabled, providerId, stylePrefix, size, maxPromptChars }` |
| `@easychat2_appearance` | 外观设置 `{ themeId: 'dark' \| 'light' \| 'blue' \| 'pink' \| 'crimson', fontScaleId: 'default' \| 'system' \| 'small' \| 'medium' \| 'large' \| 'xlarge' }` |

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
| `options.stream` | `boolean?` | 默认 `true`；为 `false` 时请求体 `stream: false` 并跳过增量解析，改走整包 JSON 分支 |
| `options.onReasoning` | `(fullReasoning: string) => void?` | 每解析出增量思考内容后触发；入参为截至当前的累计思考文本，兼容 `reasoning_content` 与 `reasoning` |

**返回**: `Promise<string>` - 流式累计文本；服务端忽略流式而返回整包 JSON 时取 `choices[0].message.content`；空响应返回 `'没有收到回复。'`

**辅助导出**: `isCanceledError(error): boolean` - 判断错误是否来自主动取消（`error.canceled === true` 或 `error.name === 'AbortError'`）。

**辅助导出**: `buildThinkingParams(config, settings)` - 按来源的 `thinking` 声明与思考设置构造请求体思考参数；未开启或来源不支持时返回空对象。

**辅助导出**: `buildSamplingParams(settings)` - 按采样设置构造 `{ max_tokens, temperature, top_p, top_k }`，仅包含已开启项；未开启或值非法时省略。请求体合并顺序为 `{ model, messages, stream, ...thinkingParams, ...samplingParams }`。

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

## 向量记忆接口

**位置**: `src/vectorMemory/`

| 函数 | 说明 |
|------|------|
| `VECTOR_PROVIDERS` / `getVectorProvider(id)` | 声明式向量服务（内置 `openai-embeddings`，默认 `https://api.openai.com/v1`、`text-embedding-3-small`） |
| `buildEmbeddingUrl(baseUrl)` | 归一化 `/embeddings` 结尾 |
| `mapEmbeddingError(status)` | 401/403、429 与其他的可读错误映射 |
| `normalizeVectorConfig(raw)` | 规范化配置并夹取范围 |
| `chunkMessages(messages, { maxChars })` | 按消息边界与长度切分片段，附 `id`/`messageId`/`role`/`at`，文本前缀标注说话者 |
| `embedTexts({ config, texts })` | 调用 `/embeddings` 批量向量化，返回向量数组 |
| `cosineSimilarity(a, b)` | 余弦相似度 |
| `retrieve({ config, index, query, topK })` | 查询向量化后按相似度取 TopN；未启用或失败回退 `keywordRetrieve` |
| `keywordRetrieve({ index, query, topK })` | 本地关键词检索（中英文分词计分） |
| `buildMemoryContext(snippets, { maxTotalChars })` | 拼装 `[相关记忆]` 文本并限制总长，空输入返回空串 |
| `indexMessages({ characterId, messages, config, existing })` | 增量分片并向量化，已存在片段跳过；未启用或失败时仅存片段（`vector: []`） |
| `testVectorConnection(config)` | 测试连接，返回向量维度或抛可读错误 |

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

### 角色卡导出接口
**位置**: `src/cardExporter.js`

| 函数 | 说明 |
|------|------|
| `buildCardV2(character)` | 构造 `chara_card_v2`（V2 `data` + V1 平铺字段），映射 `character_book` 与 `extensions.regex_scripts` |
| `cardToJson(character)` | 返回格式化 JSON 字符串 |
| `cardToPng(character, avatarBytes?)` | 返回含 `chara` 文本块的 PNG 字节；头像缺失或非法时回退占位 PNG |
| `exportCardFile(character, format, avatarBytes?)` | 写入缓存目录并返回文件 uri；`format` 为 `'png'` 或 `'json'` |
| `createPlaceholderPng(width?, height?)` | 生成最小 RGB 占位 PNG（deflate stored + 自实现 CRC32/Adler32） |
| `injectCharaChunk(pngBytes, jsonText)` | 在 `IHDR` 之后、`IDAT` 之前插入 `chara` 文本块 |

### `createWorldEntry(partial?, index?)` / `createRegexScript(partial?, index?)`
**位置**: `src/cardParser.js`
**返回**: 经标准化补全默认值的一条世界书条目 / 正则脚本；用于角色页新增条目
**辅助导出**: `WORLD_POSITION_LABELS`、`REGEX_PLACEMENT_LABELS`

### `ensureUniqueIds(items, prefix)`
**位置**: `src/cardParser.js`
**说明**: 对世界书/正则条目做 id 去重，重复时回退为 `<prefix>-<index>`；`normalizeCard` 已内置调用

### `buildRequestMessages({ character, historyMessages, userText, userProfile, globalPresets, summaryText, pluginContext, images, quote })`
**位置**: `src/chatPipeline.js`
**返回**: `Array<{ role, content }>`，形如 `[system, ...history, user]`；世界书 `position 4` 条目以独立消息按深度插入
**说明**: 系统提示词优先取 `character.systemPromptComposed`，为空回退 `character.systemPrompt`，再回退 `DEFAULT_SYSTEM_PROMPT`；随后按顺序追加 `[用户设定]`（用户人设）、`[对话示例]`（`mesExample`，为空跳过）、`[全局预设]`（已开启预设）、`memorySnippets`（`[相关记忆]`，向量召回，为空跳过）、`[记忆摘要]`（`summaryText`）、`groupContext`（群聊情境，单聊为空）与联网搜索背景资料（`pluginContext`）；`images` 非空时最后一条用户消息的 `content` 为 `[{ type: 'text' }, { type: 'image_url' }]` 多模态数组，否则为纯文本；`quote` 非空且文本非空时在用户消息文本前追加 `[引用<name>的消息] <text>` 强调段（`name` 缺失回退「对方」），只影响当前用户消息；历史用户消息与当前输入应用 placement 1 正则，历史助手消息（含开场白）应用 placement 2 正则，命中的世界书文本应用 placement 5 正则

### 群聊接口
**位置**: `src/groupChat.js`

| 函数 | 说明 |
|------|------|
| `parseMentions(text, characters)` | 解析消息中的 `@角色名`，返回角色 `id` 列表 |
| `selectSpeakers({ characters, history, userText, mentions })` | 调用 LLM 选出 1-3 个发言角色；解析失败回退本地规则（`@` 优先、名字命中、轮转）；`@` 角色必定入选 |
| `parseSpeakerResponse(text, characters)` | 解析调度返回的 `{ speakers: [...] }`，按角色名映射为 `id` |
| `generateOpening({ characters, userProfile, globalPresets })` | 生成群场景开场白与首位发言角色，失败回退合成文案 |
| `buildGroupHistory(messages)` | 为助手消息加上 `发言者：` 前缀，供模型区分发言人 |
| `needsProfile(character)` | `description` + `personality` 去空白后字符数 `< 30` 视为简介不足 |
| `generateMemberProfile(character)` | 基于完整角色卡调用 LLM 生成 1-2 行第三人称人设卡，失败返回 `null` |
| `ensureMemberProfiles({ characters, profiles })` | 对简介不足且无缓存的成员生成人设卡，返回新 `profiles`（不重复生成） |
| `buildGroupContext({ speaker, characters, historyMessages, profiles })` | 构造 `[群聊情境]` 文本：多人群聊说明、在场成员名单（含简介与最近发言）、最近对话 |
| `buildGroupRequest({ speaker, characters, historyMessages, userText, userProfile, globalPresets, quote, summaryText, pluginContext, profiles })` | 以发言角色卡设定构造请求，注入群聊情境并透传引用信息 |

**常量**: `MAX_SPEAKERS = 3`、`PROFILE_MIN_CHARS = 30`、`MEMBER_RECENT_LINES = 3`、`GROUP_RECENT_LINES = 8`。

### 附件接口
**位置**: `src/attachments.js`

| 函数 | 说明 |
|------|------|
| `TEXT_EXTENSIONS` / `IMAGE_EXTENSIONS` | 支持的文档与图片扩展名 |
| `isTextLike(name, mime)` / `isImage(name, mime)` | 按扩展名与 MIME 判定类型 |
| `pickAttachment()` | 选取单个文件，返回 `{ uri, name, mime, size }` |
| `readTextAttachment(uri, maxBytes?)` | 读取为 UTF-8 文本，默认上限 200KB，超限抛「文件过大」 |
| `readImageDataUri(uri, mime)` | 读取为 `data:` URI |
| `mergeTextAttachments(userText, attachments)` | 把文本附件以 `[附件：名称]` 追加到用户消息上下文 |

### 生图接口
**位置**: `src/imageGen/providers.js`、`src/imageGen/index.js`

`IMAGE_PROVIDERS` 为声明式配置表，内置 `z-image`、`wan-image`、`qwen-image`、`flux2-klein-4b`、`glm-image`、`novelai` 与 `openai-compatible`；`getImageProvider(id)` 按 id 取配置并回退首个。

| 函数 | 说明 |
|------|------|
| `buildRequest({ provider, config, prompt, image, model, size, seed, extra })` | 按 t2i/i2i 模板构造请求；支持 GET 查询参数、POST JSON、header/body/query 认证、multipart/base64/url 图生图；缺 `baseUrl` 返回 `null` |
| `parseImages(provider, data)` | 按 `response.path` 取根节点，兼容字符串、`url`、`base64`（`b64_json`、`images[].url`、`output.results`、`output[]`）；`response.mode === 'binary'` 时把非 JSON 响应按 base64 包装为图片项 |
| `mapHttpError(status)` | 401/403 → 「密钥无效或未授权」；429 → 「请求过于频繁，请稍后重试」；其他 → 「生成失败（HTTP n）」 |
| `generateImage({ provider, prompt, imageFile?, imageUrl?, model?, size?, seed?, extra?, config? })` | 统一生成入口，返回 `Promise<{ images: [{ url?, base64? }], raw }>`；含超时与按 `retries` 重试 |

**说明**: 密钥仅存本机 AsyncStorage；未填地址或密钥时直接抛错不发起请求；`extra.params` 与 Provider 的 `params` 映射按点号路径写入请求体；`sizeSplit` 把 `宽*高` 拆为 width/height；图生图必须携带图片。

### `getImageGenSettings()` / `saveImageGenSettings(settings)`
**位置**: `src/storage.js`
**说明**: 读取/写入 `@easychat2_image_gen`；`extra` 支持 JSON 字符串或对象，读取时统一规范化为对象。

### `ExtensionScreen`（默认导出）
**位置**: `src/ExtensionScreen.js`
**Props**: 无（由导航注入）
**说明**: 分段控件切换「游戏」与「生图」；游戏区从 `GAMES` 列列表，选中后用 `WebView` 加载内嵌 HTML，顶部返回列表，加载失败提供重试；生图区内联渲染 `ImageGenScreen embedded`；两视图同时挂载、以透明度与 `pointerEvents` 控制显隐，切换分段保留生图已填内容；`react-native-webview` 不可用时隐藏游戏入口并提示。

### 游戏清单
**位置**: `src/games/games.js`

| 导出 | 说明 |
|------|------|
| `GAMES` | `[{ id, name, description, html }]`，内置 `guess-number`、`snake`、`breakout`、`snake-battle`、`thunder-fighter` |
| `getGame(id)` | 按 id 取游戏，未命中返回 `null` |

**说明**: `html` 为完整 HTML 字符串常量，样式与脚本内联，无外部资源与网络请求。

### 虚拟朋友圈接口
**位置**: `src/moments/affinity.js`、`src/moments/moments.js`、`src/MomentsView.js`

| 函数 | 说明 |
|------|------|
| `evaluateTurn({ userText, assistantText })` | 本地关键词启发式，返回 `{ delta, milestone }`，`delta` 绝对值不超过 5 |
| `detectMilestone(text)` | 命中表白/生日/永别/约定等事件时返回事件 id |
| `clampAffinity(score)` | 好感夹在 `[-100, 100]` |
| `shouldTrigger({ affinity, turnCount, milestone, triggers })` | 依次判定好感上限/下限、`turns-50`/`turns-100`、`milestone-*`，已存在 `triggers` 中则不重复 |
| `buildMomentText({ trigger, character, seed })` | 按触发类型从固定模板生成文本，包含角色名 |
| `appendMoment(list, moment)` | 追加并按 `MAX_MOMENTS`（200）淘汰最旧 |

**说明**: 全部为本地纯逻辑，无模型调用与网络请求。

### 语音播报接口
**位置**: `src/tts/providers.js`、`src/tts/index.js`

`TTS_PROVIDERS` 为声明式配置表，内置 `system` 与 `xiaomi-mimo`、`siliconflow`、`iflytek-spark`、`stepfun`、`tencent-cloud`、`aliyun`、`baidu`、`volcano`、`minimax`；`getTtsProvider(id)` 按 id 取配置并回退系统引擎。

| 函数 | 说明 |
|------|------|
| `truncateText(text, maxChars?)` | 按 `TTS_MAX_CHARS`（800）截断 |
| `buildTtsRequest(provider, config, text, token?)` | 按字段映射构造请求；支持 header/query/body/token 鉴权与讯飞/腾讯云/火山签名；无地址返回 `null` |
| `resolveToken(provider, config, opts?)` | `auth.type === 'token'` 时兑换并缓存令牌（按 `tokenTtlSec`） |
| `synthesize({ provider, config, text })` | 返回 `{ mode: 'system' | 'audio', text?/base64? }` |
| `speak({ provider, config, text, onDone?, onError? })` | 系统引擎走 `expo-speech`，云端音频走 `expo-av` 播放；播放前先停止上一段 |
| `stop()` | 停止系统朗读与当前音频 |
| `listVoices(provider)` | 系统引擎取 `getAvailableVoicesAsync`，云端取声明音色 |
| `mapHttpError(status)` | 401/403 → 「密钥无效或未授权」；429 → 「请求过于频繁，请稍后重试」；其他 → 「播报失败（HTTP n）」 |

**说明**: 密钥仅存本机 AsyncStorage，不写入日志或文档。

### 插件接口
**位置**: `src/plugins/registry.js`、`src/plugins/webSearch.js`、`src/plugins/providers.js`

| 函数 | 说明 |
|------|------|
| `hasTrigger(userText, keywords?)` | 判断文本是否命中内置触发词 |
| `shouldSearch({ userText, plugin, sessionId, now? })` | 插件启用、类型匹配、命中触发词且不在 30 秒冷却内 |
| `formatContext(results, now?)` | 生成含标题、来源链接与获取时间的 `[背景资料（联网搜索 …）]` 文本 |
| `runPlugins({ userText, plugins, sessionId, now? })` | 遍历启用插件，命中则搜索并返回注入文本；失败或超时返回空串并记录冷却 |
| `runWebSearch({ query, config, maxResults? })` | 按 `config.provider` 取声明、构造请求、解析并返回 `{ title, url, snippet, raw }[]`；带 60 秒内存缓存、一次重试、每分钟 20 次限流与 10 秒超时 |
| `getByPath(source, path)` | 按点号路径取值（如 `web.results`） |
| `buildRequest(provider, config, query, limit)` | 按声明构造请求（URL/方法/头/体），GET 查询参数 `encodeURIComponent` |
| `parseResults(provider, data, limit)` | 按 `resultsPath` 与 `fields` 映射为统一结构 |
| `resetSearchCooldown()` / `resetSearchCache()` | 清空冷却与缓存（测试用） |

**声明式 Provider**: `src/plugins/providers.js` 的 `PROVIDERS` 描述各搜索服务的 `baseUrl`、`method`、`authType`（query/header/body）、`authKeyName`、`queryParam`、`limitParam`、`extra`、`extraFields`、`resultsPath`、`fields` 与 `secretFields`；新增服务只需追加声明。内置 `serpapi`、`google-cse`、`bing`、`brave`、`tavily` 与 `custom`（自定义地址）。密钥仍由用户在应用内填写并存入 `@easychat2_plugins`，不使用环境变量。

**触发词**: `TRIGGER_KEYWORDS`（最新、今天、新闻、股价、天气、汇率等）。

### 记忆总结接口
**位置**: `src/memorySummary.js`

| 函数 | 说明 |
|------|------|
| `selectSummarizable(messages, summarizedUpTo, keepRecent?)` | 返回边界之后、且保留最近若干条（默认 6）以外的可总结消息 |
| `shouldSummarize({ session, messages, settings, force? })` | 自动触发需开关开启且消息数达到阈值且有可总结消息；`force` 用于手动触发 |
| `buildSummaryPrompt(messages, userName?, memories?)` | 组装「只提取新增记忆、每行一条 `- `」的提示词，并把已有记忆注入 `<memories>` 区块 |
| `parseMemoryLines(text)` | 按行提取记忆，去掉 `-`/`*`/`•` 前缀与空行 |
| `parseSummaryResponse(text)` | 解析纯文本行式输出，规范化为 `- ` 行；关键词用占位；空内容抛错 |
| `generateSummary({ character, messages, userName?, memories? })` | 调用 `sendChatMessage` 生成新增记忆行 |
| `applySummary({ session, character, messages, updateCharacter, userName? })` | 生成新增记忆后写入角色世界书（`记忆总结 N`、关键词占位触发），注入已有记忆避免重复，并更新会话边界 |
| `buildMemorySummaryText(character)` | 拼接世界书中「记忆总结」条目内容，供请求压缩与已知记忆注入 |

**常量**: `MEMORY_SUMMARY_PREFIX = '记忆总结'`、`KEEP_RECENT = 6`、`DEFAULT_THRESHOLD = 40`、`FALLBACK_KEYWORDS`（占位关键词「前情提要」）。

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

### `TUTORIAL_SECTIONS` / `TutorialModal`
**位置**: `src/tutorialContent.js` / `src/TutorialModal.js`
**说明**: `TUTORIAL_SECTIONS` 为静态教程数据，结构 `{ id, title, icon, intro, items: [{ name, where, usage }] }`，含聊天/记忆/角色/设置四章；`TutorialModal`（默认导出）Props 为 `{ visible, onClose }`，全屏 `Modal` + `ScrollView` 只读渲染，由设置页「使用教程」入口打开

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
| `alternateGreetings` | `string[]?` | 备用开场白（角色卡 `alternate_greetings`） |
| `mesExample` | `string?` | 对话示例，非空时注入系统提示词 `[对话示例]` |
| `creatorNotes` | `string?` | 作者注释 |
| `postHistoryInstructions` | `string?` | 历史后指令 |
| `tags` | `string[]?` | 标签 |
| `worldInfo` | `WorldInfoEntry[]?` | 世界书条目，结构见[世界书](./专有概念/世界书.md) |
| `regexScripts` | `RegexScript[]?` | 正则脚本，结构见[正则脚本](./专有概念/正则脚本.md) |
| `lastUsedAt` | `number?` | 最近一次成为当前角色的时间戳，决定列表排序 |
| `pinned` | `boolean?` | 是否置顶；置顶角色排在角色库最前 |
| `nudgeText` | `string?` | 拍一拍文案（角色卡 `extensions.nudge_text`）；留空用全局默认 |

### `Message`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 消息标识，形如 `<时间戳>-user` / `<时间戳>-assistant` |
| `role` | `'user' \| 'assistant' \| 'system-error'` | 消息角色 |
| `text` | `string` | 展示文本 |
| `detail` | `string?` | 系统报错消息的脱敏详情 |
| `pending` | `boolean?` | 占位消息标记，为真时不持久化 |

流式回复期间，助手消息的 `pending` 保持为真、`text` 随每个增量片段实时覆盖；流正常结束时 `pending` 置为假，随后才进入持久化，确保「正在思考…」不会落盘。若请求在流中途失败且已收到部分文本，则把该部分文本转为已完成助手消息予以保留，并额外追加一条 `system-error` 消息（`id` 为助手占位 `id` 加后缀 `-error`）；若失败时仍无任何文本，则占位直接替换为 `system-error`。

### `Persona`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 人设标识；迁移生成的为 `default`，新建为 `persona-<base36 时间戳>-<随机>` |
| `userName` | `string` | 人设名称（注入 `{{user}}`） |
| `persona` | `string` | 人设描述文本 |
| `createdAt` / `updatedAt` | `number` | 创建与更新时间戳 |

头像与拍一拍文案为全局共用，存于 `@easychat2_user_profile`，不随人设切换。

### `Session`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 会话标识，形如 `session-<base36 时间戳>-<随机>`；迁移会话为 `legacy-<characterId>` |
| `type` | `'single' \| 'group'` | 会话类型，缺省为 `single` |
| `characterId` | `string` | 单聊所属角色 `id`；群聊为空串 |
| `members` | `string[]` | 群聊成员角色 `id` 列表；单聊为空数组 |
| `memberProfiles` | `{[characterId]: string}` | 群聊成员人设卡缓存（简介不足时懒生成）；单聊为 `{}` |
| `name` | `string` | 群聊名称；单聊为空串 |
| `preview` | `string` | 最后一条可读消息的摘要，最长 60 字 |
| `pinned` | `boolean` | 是否置顶 |
| `createdAt` | `number` | 创建时间戳 |
| `updatedAt` | `number` | 最后更新时间戳，决定排序 |
| `clonedFrom` | `string` | 克隆来源会话 `id`，非副本为空串 |
| `summarizedUpTo` | `string` | 记忆总结边界消息 `id`，未总结为空串；仅允许单调前移，克隆不继承 |

排序规则：置顶优先，其余按 `updatedAt` 降序，并列按 `id` 升序。空会话（无消息）不进入列表。

### `SearchHit`

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 命中消息所属会话 |
| `characterId` | `string` | 所属角色 |
| `messageId` | `string` | 命中消息标识 |
| `role` | `'user' \| 'assistant'` | 消息角色 |
| `text` | `string` | 消息原文 |
| `updatedAt` | `number` | 所属会话更新时间，用于倒序排列 |

### `Preset`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 预设标识；内置项含 `immersive`、`no-user-act`、`rich-senses`、`no-repeat`、`concise`、`paragraphs`、`zh-cn`、`character-state` |
| `name` | `string` | 名称 |
| `description` | `string` | 描述 |
| `prompt` | `string` | 开启后追加到系统提示词的内容 |

### `MemorySummary`

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | `boolean` | 是否开启记忆总结 |
| `threshold` | `number` | 触发阈值（当前会话消息条数），大于 0 的整数，默认 40 |

### `Plugin`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 插件标识；内置为 `web-search` |
| `name` | `string` | 名称 |
| `description` | `string` | 描述 |
| `type` | `string` | 插件类型；内置为 `web-search` |
| `enabled` | `boolean` | 是否启用 |
| `config.provider` | `'serpapi' \| 'google-cse' \| 'bing' \| 'custom'` | 搜索服务 |
| `config.apiKey` | `string` | 搜索服务密钥（仅存本机） |
| `config.cx` | `string` | Google CSE 的搜索引擎 ID |
| `config.customBaseUrl` | `string` | 自定义接口地址 |
| `config.maxResults` | `number` | 单次返回结果数上限，1-10，默认 5 |

### `ApiConfig`

| 字段 | 类型 | 说明 |
|------|------|------|
| `baseUrl` | `string` | 接口地址 |
| `apiKey` | `string` | 密钥，仅存本机 |
| `models` | `string[]` | 模型列表，始终非空 |
| `activeModel` | `string` | 当前模型，必须属于 `models` |
| `supportsThinking` | `boolean` | 是否支持思考，保存前确认 |
| `supportsVision` | `boolean` | 是否支持识图，保存前确认 |
| `thinking` | `{ field, format }` | 思考参数声明；`format` 为 `effort` / `boolean` / `object`，缺省 `reasoning_effort` + `effort` |
