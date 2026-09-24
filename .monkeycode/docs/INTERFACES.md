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
- 导航聚焦时读取 `@easychat2_chat_options`：`streaming` 决定请求体是否流式，`fullWidth` 决定消息气泡使用全宽还是限宽样式，`richHtml` 决定含 `<style>`/`<script>` 的助手消息是否用 WebView 渲染；含 `<details>`/`<summary>` 的折叠状态栏始终使用 WebView，避免标题被内置渲染器丢弃
- 消息操作行提供「引用」：引用目标以引用块展示在输入区上方，可取消；发送时用户消息写入可选 `quoted` 字段并把引用注入请求；气泡内引用块位于正文之上，点击复用会话内定位滚动到原消息，原消息不存在时提示且不报错
- 助手回复完成后本地评估好感与轮次（无额外网络请求），命中好感上下限、50/100 轮或特殊大事且未触发过时生成一条动态；开关关闭时不生成
- 助手消息保存可选 `inlineImage` 字段；并持久化：开启时助手回复完成自动播报，发送新消息或关闭开关时停止；助手消息提供「播报」手动重播。播报前经 `toSpeechText` 清洗为正文：去除 Markdown（标题/加粗/列表/引用/代码块/链接）、HTML 标签与数值状态栏，且手动播报使用原始文本、不套用显示正则
- 助手消息可按需生成配图（气泡下方按钮）或随自动配图开关自动生成：生成中展示加载态，失败展示重试，完成把 `inlineImage` 随消息持久化（`loading`/`error` 不落盘）；同一时刻仅允许一个配图请求
- 顶部栏提供「新建」按钮：单聊先打开开场白选择器，选择结果保存为角色默认开场白并用于后续新会话；群聊沿用成员新建逻辑。空会话也允许选择开场白，开场白消息底部提供「重选」
- 顶部栏常驻元素为：角色头像与名称、播报开关、「新建」与「⋯」更多菜单；「⋯」菜单收纳公告、模型、思考、定位、搜索、总结与设置，点选执行与折叠前一致的操作（定位无消息时禁用、总结进行中禁用、搜索反映开启态），菜单以浮层呈现不改变消息列表滚动位置
- 「⋯」菜单的「设置」打开聊天设置弹窗，提供「系统设置」（跳转设置页）与「编辑角色」（群聊隐藏并提示）两个入口
- `activeSessionId` 变化时按会话加载消息（`getMessagesBySession`），并在加载期间禁用输入与发送；会话所属角色缺失时仍加载历史消息，界面显示「角色资料缺失」并禁用发送、重生成、附件与新建会话
- 发送前按会话 `summarizedUpTo` 截断历史，并把摘要作为 `summaryText` 传入 `buildRequestMessages`，实现请求压缩；同角色记忆 ≥ 2 时仅用当前会话总结（`buildMemorySummaryText` scoped），否则用世界书总结
- 角色页切换角色时同步切换会话（`ensureCharacterSession`）；会话的角色引用暂时缺失时，记忆页仍允许打开该会话，聊天页进入只读历史模式；群聊不依赖基础角色存在
- 顶部栏提供「总结」按钮：单聊点击后先弹出开始确认，手动总结包含当前边界后的全部消息，不受自动阈值与开关限制；收到回复后若独立记忆总结开关开启且可总结消息达到阈值则自动总结一次，自动总结无新增记忆时保留边界，手动总结会明确反馈结果
- 消息落库后若向量记忆开启，异步增量索引当前角色片段（已存在片段跳过，失败静默）；发送前按用户输入召回若干片段，经 `buildMemoryContext` 生成 `[相关记忆]` 注入请求；未配置或请求失败自动回退本地关键词检索；索引为空时不注入
- 顶部栏「搜索」按钮展开会话内搜索条：标记全部命中、显示第 x/n 条并支持上一个/下一个滚动定位；关闭时清除高亮
- 记录每条消息的布局偏移；消费 `pendingTarget` 后滚动定位并高亮目标消息，目标不存在时不定位
- 输入栏附件入口可选择纯文本类文档或图片：文本文档读取内容并在发送时以 `[附件：名称]` 并入上下文；图片仅当来源支持识图时允许，并以多模态形式发送；已选附件以标签与缩略图展示、可移除
- 输入栏最右提供全屏输入入口，全屏界面提供发送与右上角关闭，退出保留文本
- 顶部栏「模型」按钮打开切换面板：先列来源再列模型，选择后更新该来源当前模型并持久化
- 顶部栏「思考」按钮打开思考设置：开关、深度（低/中/高）与思考内容展示（开启/折叠/关闭），按来源声明的字段与格式注入请求；来源不支持思考时禁用；三项保存时合并现有设置，互不覆盖
- 助手消息保存可选 `reasoning` 与 `inlineImage` 字段；生成中经 `onReasoning` 实时更新。思考内容展示 `open` 为思考阶段自动展开、内容开始输出后自动收缩为一行「思考过程 ˅」；`fold` 默认收缩为一行可点开；`off` 不展示。用户手动点开/收起后不再自动收缩
- 顶部栏「定位」按钮打开 `ScrollScrubber`（无消息时禁用）：拖动按索引定位，支持回到开头与最新
- 发送前读取已开启插件并执行 `runPlugins`，命中触发词时把联网搜索结果作为 `pluginContext` 注入；失败静默降级
- 群聊会话（`type: 'group'`）：顶部展示群名与群头像（未设置头像时回退群图标），聊天背景取会话 `bgUri`；输入栏左侧为 `@` 按钮（替代附件入口），点击弹出成员列表（`@全体` 与逐个成员），选择后在光标处插入 `@名字 `；`@全体` 使全部成员发言。发送时解析 `@`。默认走「群像卡」模式（`groupMode: 'ensemble'`）：合并全部成员设定为单次 LLM 调用，由模型以编剧视角输出「角色名：」分段，前端解析为多条带发言者头像与名字的消息；流式过程中累计文本暂存于单条 pending 消息，解析完成替换为多段。生成失败或解析为空时回退逐角色模式（`groupMode: 'turn'`：调度 1-3 个发言角色逐个回复）。群像卡思考阶段的消息显示为群名，不再显示基础角色名；消息头像优先取该成员角色卡的头像，取不到时用群头像。逐角色模式每个角色的请求注入 `[群聊情境]`（在场成员名单 + 简介 + 最近发言 + 最近对话），简介不足（< 30 字）的成员经 `ensureMemberProfiles` 懒生成人设卡并缓存到会话 `memberProfiles`；同轮后发言角色可见前述角色发言；单角色失败生成错误气泡后继续；空群聊首次进入生成开场白；群聊不提供重新生成
- 迟到回复由 `src/chatRace.js` 的 `isStaleReply(currentId, sendId)` 与会话 `id` 比对共同守卫，在 `onChunk`、`setMessages` 与错误原文写入处被丢弃
- `persistableMessages` 过滤 `pending` 后通过快照比对决定是否落盘，写入走 `saveMessagesBySession`
- `renderedMessages` 对助手消息应用 placement 2、对用户消息应用 placement 1 的展示正则（mode `display`），原始文本仍用于落盘

**消息角色常量**: `user`、`assistant`、`system-error`
**密钥脱敏**: 来自 `src/secrets.js` 的 `SECRET_PATTERN = /(sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9\-_]+)/g` 与 `maskSecrets`，替换为 `[API_KEY已隐藏]`

### `CharacterScreen`（默认导出）
**位置**: `src/CharacterScreen.js`
**Props**: 无
**状态**: `name`、`systemPrompt`、`description`、`personality`、`scenario`、`firstMes`、`worldInfo`、`regexScripts`、`presets`、`expandedWorld`、`expandedRegex`、`characterListExpanded`、`characterScrubberOpen`、`importing`、`seededIdRef`
**行为**:
- 顶部渲染「角色库」列表：按最近使用降序，当前角色高亮并标「当前」；点选条目调用 `switchCharacter`
- 「新建角色」调用 `addCharacter({ name: '新角色' })` 得到空白角色；非默认角色条目可删除，二次确认后调用 `deleteCharacter`；若该角色还有会话（记忆），会再询问「仅删角色」或「角色和记忆都删」，后者一并调用 `deleteSessions` 清除会话与消息
- 当前角色 `id` 变化时用 Context 中的角色回填全部可编辑字段（`seededIdRef` 保证每个角色仅回填一次）
- `save()` 组装 `{ id, name, systemPrompt, systemPromptComposed, description, personality, scenario, firstMes, worldInfo, regexScripts, presets }` 并调用 `updateCharacter`（浅合并）；`systemPromptComposed` 由 `buildSystemPrompt` 用核心字段合成
- `importCard()` 通过 `DocumentPicker` 选取 `image/png` 或 `application/json`，读取为 Base64 后解析；兼容标准卡、扁平卡与织语 `zhiyu_agent_v1` 纯文本 JSON；读取/解析与确认落库阶段均显示不可误触的导入弹层，大卡片显示文件大小与等待提示；随后用 `GreetingPickerModal` 让用户选择/修改/新增开场白，再经 `addCharacter` 加入角色库并设为当前角色；确认落库失败时保留弹窗与开场白草稿，超大角色正文改由文件系统保存
- PNG 无 `chara`/`ccv3` 文本块时提示「该图片不包含角色卡数据，请上传角色卡 JSON 文件或含数据的 PNG 图片。」；解析异常提示脱敏后的错误详情
- 世界书与正则以可折叠区块编辑（默认收起），支持逐条修改与增删；作者注释/历史后指令为只读
- 可编辑「备用开场白」（多条增删改）、「对话示例」（多行，注入系统提示词）与「标签」
- 角色数据区按「世界书 → 正则脚本 → 预设 → 全局预设」排列；角色预设随角色卡导入、编辑和导出，独立于全局预设
- 角色库支持搜索（名称与标签）、星标置顶、多选与全选删除（全选需输入确认）；角色卡陈列超过 10 个时默认只显示前 10 个，点击展开后显示完整列表，并打开与聊天一致的右侧定位滑动条：顶部/底部按钮定位到角色卡陈列区顶部/底部，拖动滑块按角色卡顺序定位
- 角色卡提供「群聊」按钮，打开多选面板（2-8 个角色、群名可留空），创建群聊会话后刷新会话并切换到聊天页

### `SettingsScreen`（默认导出）
**位置**: `src/SettingsScreen.js`
**Props**: 无
**状态**: `configs`、`activeId`、`loaded`、`userName`、`userPersona`、`userAvatarUri`、`presetEntryOpen`、`enabledPresetCount`、`sampling`
**行为**: 挂载时读取多配置列表与当前活跃 `id`；可新建、删除、点选切换配置；每个来源维护模型列表（输入添加、点击设为当前、可删除，至少保留一个），「检测模型」结果加入列表；保存前对 HTTP 明文地址与方法能力（支持思考 / 支持识图）分别确认；增删改都立即持久化整套配置列表。「全局配置」卡片提供「全局预设」入口（副标题显示已开启数量或「未开启」），点击打开 `PresetPanel`，关闭时刷新计数。另有「生成参数」卡片：最大回复令牌 / 温度 / top-p / top-k 四项，每项含独立开关与数值输入，输入失焦时夹取到范围并在越界时提示，仅开启项随请求发送。「用户人设」卡片管理多人设：以 chip 列表展示，点击切换当前人设，`+ 新增` 创建并设为当前，逐个可删除（至少保留一个，删除当前时自动切到剩余首项）；名字与人设描述编辑当前人设，头像为全局共用。「向量记忆」卡片提供开关、接口地址、密钥（密文）、模型、召回条数、分片长度与「测试连接」，未配置或失败时聊天侧自动降级为关键词检索；API 配置 / 用户人设 / 对话配图 / 向量记忆 卡片各带「教学」按钮，用 `ChapterModal` 打开对应单章。「关于」卡片提供「使用教程」入口，打开 `TutorialModal` 图文教程（12 章，与启动新手教学共用 `onboardingContent.js`），只读静态内容；另有「免责条款」入口复用 `DISCLAIMER_TEXT`。

### `CharacterEditForm`（默认导出）
**位置**: `src/CharacterEditForm.js`
**Props**: `{ visible, character, onClose, onSaved }`
**行为**:
- 底部抽屉式 `Modal`，编辑当前角色的常用字段：名称、头像、背景、人设/系统提示词、角色描述、性格、场景、开场白、备用开场白（逐条增删改）、对话示例与标签
- 打开时以 `character` 初始化草稿；保存时经 `useApp().updateCharacter` 写入，并重建 `systemPromptComposed`
- 保存成功回调 `onSaved`；失败 `Alert` 并保留草稿不清空
- 世界书与正则脚本不在此表单内，界面提示前往「角色」页编辑
- 供聊天页「编辑角色」使用；角色页保留其完整编辑界面

### `GroupEditForm`（默认导出）
**位置**: `src/GroupEditForm.js`
**Props**: `{ visible, session, members, onClose, onSaved }`
**行为**:
- 底部抽屉式 `Modal`，把群聊当作一张卡，只编辑名称、头像与背景
- 头像/背景可从本地图片选择，也可从成员角色卡中选择（头像取成员 `avatarUri`、背景取成员 `bgUri`），或选择「不使用」
- 保存经 `updateSessionInfo` 写入；成功回调 `onSaved` 由聊天页刷新会话
- 供聊天页「编辑群聊」入口使用

### `PresetPanel`（默认导出）
**位置**: `src/PresetPanel.js`
**Props**: `{ visible, onClose, scope = 'global', characterPresets, onCharacterPresetsChange }`
**行为**:
- `scope='global'` 时读取全局文本预设、开关映射与独立的记忆总结设置；`scope='character'` 时读取当前角色草稿预设并通过 `onCharacterPresetsChange` 回写
- 列出全部预设（名称、描述、启用开关），开关切换即时保存；点击条目打开编辑弹窗
- 提供新增与编辑（名称、描述、提示词）以及删除二次确认，删除同时移除其开关记录
- 全局作用域额外提供独立的「记忆总结」开关与可总结消息阈值；角色作用域隐藏该区域
- 设置页与角色页共用该组件；全局面板中的记忆总结配置不会混入文本预设列表，角色页顺序为世界书、正则脚本、预设、全局预设

### `MemoryScreen`（默认导出）
**位置**: `src/MemoryScreen.js`
**Props**: `navigation`（由导航注入）
**行为**:
- 从 `useApp()` 读取 `sessions`、`characters`、`loaded` 与会话操作；展示全部会话，顺序沿用存储层的置顶优先 + 更新时间降序（不再按 preview 是否为空重排）
- 聚焦时调用 `refreshSessions()` 重读会话列表：聊天页保存消息只写存储、不同步 Context，不重读会看到过期的 preview 与更新时间
- 空 preview 的会话读一次消息体兜底补出摘要；仍为空才显示「（空会话，可删除）」
- 每行展示角色头像、角色名、摘要与更新时间；克隆产生的会话在角色名后显示「副本」标识，置顶会话显示星标；群聊会话展示叠放成员头像与群名
- 点击行先在角色存在时 `switchCharacter`，再 `switchSession`，随后 `navigation.navigate('聊天')`；角色引用缺失时跳过角色切换，让聊天页以只读方式展示历史
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
- 覆盖层内渲染竖向轨道与滑块，用 `PanResponder` 拖动，按滑动比例映射消息或角色卡索引（`indexFromRatio`）
- 轨道上方「回到开头」、下方「回到最新」分别调用 `onToStart` / `onToEnd`；松手时以映射索引调用 `onSeek`
- 消息数超过 30 时拖动显示预览卡（时间、发言者、缩略与位置）；聊天与角色列表均可复用，无可定位项时按钮禁用；顶部/底部按钮会同步更新滑块位置
**辅助导出**: `indexFromRatio(ratio, messageCount)`、`getScrollRange({ top, height, viewport })`

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
| `character` | `Character` | 当前角色（由 `activeId` 在角色库中解析，失效时回退默认角色）；含可选 `pinned` 与 `tags` |
| `characters` | `Character[]` | 角色库，按最近使用降序 |
| `activeId` | `string` | 当前角色 `id`，恒等于 `character.id`；存储中的值失效时会在加载后修正并写回 |
| `loaded` | `boolean` | 角色库与当前角色是否已从存储加载完成 |
| `updateCharacter` | `(patch) => Promise<Character>` | 合并并持久化当前角色更新 |
| `switchCharacter` | `(id) => Promise<Character>` | 切换当前角色并更新其 `lastUsedAt` |
| `addCharacter` | `(character) => Promise<Character>` | 以唯一 `id` 新增角色并设为当前角色 |
| `pinCharacter` | `(id, pinned) => Promise<Character>` | 切换角色置顶并持久化，置顶优先排序 |
| `deleteCharacters` | `(ids) => Promise<Character[]>` | 批量删除角色；默认角色不可删，其余可全部删除；删除当前角色时回退默认角色 |
| `deleteCharacter` | `(id) => Promise<Character[]>` | 删除非默认角色及其消息，必要时切换当前角色 |
| `sessions` | `Session[]` | 全部会话，置顶优先、按更新时间降序 |
| `activeSessionId` | `string` | 当前会话 `id`，无可用会话时为空串 |
| `switchSession` | `(id) => Promise<Session>` | 切换当前会话并持久化指针 |
| `pinSession` | `(id) => Promise<Session[]>` | 切换会话置顶标记并持久化排序结果 |
| `cloneSession` | `(id) => Promise<Session>` | 克隆会话并加入列表，不改变当前会话 |
| `deleteSession` | `(id) => Promise<{ sessions, activeSessionId, created }>` | 删除会话，必要时新建空会话并设为当前 |
| `deleteSessions` | `(ids) => Promise<Session[]>` | 批量删除多个会话；包含当前会话时先新建空会话再删除 |
| `refreshSessions` | `() => Promise<Session[]>` | 从存储重新读取会话与当前指针并同步状态 |
| `ensureCharacterSession` | `(characterId, opening?) => Promise<Session>` | 激活该角色最近更新的会话；无会话时新建空会话，`opening` 可携带已确认的开场白 |
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
8. 加载或运行中若 `activeId` 不在角色库内，`character` 解析为默认角色；角色库处于恢复阻断态时保留原指针且禁止写回，正常状态下将修正后的 `id` 写回存储与状态

### `characterIdentity` 辅助函数
**位置**: `src/context/characterIdentity.js`（零依赖纯函数，供 `storage` 与测试使用）

| 函数 | 说明 |
|------|------|
| `makeCharacterId(now?)` | 生成 `card-<base36 时间戳>-<随机>` 形式的新角色 `id` |
| `uniqueCharacterId(base, used, now?)` | 基于 `used` 集合生成唯一 `id`；`base` 为空时用 `makeCharacterId`，冲突时追加 `-1`、`-2` |
| `assignStableCharacterIds(list, { defaultId, isInitial, now? })` | 给空 `id` / 撞 `id` 分配唯一 `id`；`defaultId` 归属 `isInitial` 为真的初始卡，若被冒名者抢占则一次性收回；返回 `{ list, changed }`，`changed=true` 表示调用方必须落盘固化，避免每次读取按顺序重算导致身份漂移 |

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

### `cardGreetings` 辅助函数
**位置**: `src/cardGreetings.js`（纯函数，供 `CharacterScreen`/`GreetingPickerModal` 与测试使用）

| 函数 | 说明 |
|------|------|
| `listGreetingCandidates(fields)` | 把 `firstMes` + `alternateGreetings` 整理为 `[{ text, source }]`（`source` 为 `first`/`alt`），去空去空白 |
| `buildGreetingImport(drafts, selectedIndex)` | 由可编辑草稿与选中下标得到 `{ firstMes, alternateGreetings }`；`selectedIndex < 0` 表示不使用开场白，其余非空草稿保留为备用 |

### `GreetingPickerModal`（默认导出）
**位置**: `src/GreetingPickerModal.js`
**Props**: `{ visible, candidates: [{ text, source }], onCancel, onConfirm }`

导入角色卡时选择开场白：列出候选、单选、就地编辑与增删；确认时经 `buildGreetingImport` 得到 `{ firstMes, alternateGreetings }` 交给 `confirmImport`。

## 持久化接口

**位置**: `src/storage.js`

| 函数 | 签名 | 说明 |
|------|------|------|
| `getApiConfigs` | `() => Promise<{ configs, activeId }>` | 读取多配置列表与当前活跃 id；旧单条配置自动迁移 |
| `saveApiConfigs` | `(configs, activeId) => Promise<{ configs, activeId }>` | 写入多配置列表与活跃 id |
| `getActiveApiConfig` | `() => Promise<ApiConfig>` | 返回当前活跃配置（至少一条） |
| `getActiveModel` | `(config) => string` | 返回配置的当前模型，回退列表首项与默认模型 |
| `getThinkingSettings` | `() => Promise<{ enabled, level, display }>` | 读取思考设置，默认 `{ enabled: false, level: 'medium', display: 'fold' }` |
| `saveThinkingSettings` | `({ enabled, level, display }) => Promise<{ enabled, level, display }>` | 归一化并写入思考设置（`level` 为 `low`/`medium`/`high`，`display` 为 `open`/`fold`/`off`；未传字段回落到默认值，调用方应先合并现有设置） |
| `getSamplingSettings` | `() => Promise<Sampling>` | 读取生成采样设置，缺省四项均关闭（maxTokens 8024 / temperature 1 / topP 1 / topK 0） |
| `saveSamplingSettings` | `(Sampling) => Promise<Sampling>` | 夹取范围并整数化后写入采样设置 |
| `getVectorMemoryConfig` / `saveVectorMemoryConfig` | `(config?) => Promise<VectorConfig>` | 读取/写入向量记忆配置，夹取范围（topK ≤ 20、maxChars ≤ 2000、batchSize ≤ 64） |
| `getVectorIndex` / `saveVectorIndex` | `(characterId, index?) => Promise<Segment[]>` | 读取/写入按角色隔离的记忆片段索引，写入时过滤非法条目 |
| `clearVectorIndex` | `(characterId) => Promise<void>` | 清除某角色的记忆片段索引 |
| `createApiConfig` | `(partial) => ApiConfig` | 创建一条标准化配置（含唯一 id） |
| `getCharacterLibrary` | `() => Promise<Character[]>` | 读取并排序角色库；按索引 + 每角色一键读取，超大角色从文件描述符恢复；缺失索引时迁移旧整库键，Android 读取旧大值失败时通过 SQLite 分块恢复；索引缺项或读取异常时保留原键并进入写入阻断态 |
| `saveCharacterLibrary` | `(list) => Promise<Character[]>` | 排序、补默认角色后逐角色写键；超过 512 KiB 的角色正文写入 `characters/` 文件，AsyncStorage 保存描述符；最后写索引与迁移标记并清理旧键/旧文件 |
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
| `getMessagesBySessionStatus` | `(sessionId) => Promise<{ status, messages }>` | 带状态的按会话读取；损坏时先备份再返回 `status: 'corrupt'`，调用方不得把读失败当成空会话写回 |
| `saveMessagesBySession` | `(sessionId, messages) => Promise<Message[]>` | 按会话写入消息，过滤 `pending`，并同步会话预览与更新时间 |
| `startNewSession` | `(characterId, opening?) => Promise<Session>` | 新建会话并设为当前；传入 `opening` 表示已完成开场白选择，空文本也会记录选择状态，创建时可写入开场白消息 |
| `setSessionGreetingSelected` | `(sessionId, selected?) => Promise<Session\|null>` | 标记单聊已完成开场白选择；群聊或不存在会话直接返回 |
| `createGroupSession` | `(members, name, extras?) => Promise<Session>` | 新建群聊会话（`type: 'group'`）并设为当前；`extras` 可带 `avatarUri`/`bgUri` |
| `updateSessionInfo` | `(sessionId, patch) => Promise<Session\|null>` | 更新群聊名称/头像/背景；非群聊返回目标且不改动 |
| `updateSessionMemberProfiles` | `(sessionId, memberProfiles) => Promise<Session\|null>` | 合并群聊成员人设卡缓存（已有键不覆盖），非群聊返回目标或 `null` |
| `cloneSession` | `(sessionId) => Promise<Session>` | 复制会话元数据与消息，消息 `id` 重新生成，副本未置顶 |
| `deleteSession` | `(sessionId) => Promise<{ sessions, activeSessionId, created }>` | 删除会话与消息；删除当前会话时新建空会话 |
| `deleteSessions` | `(sessionIds) => Promise<{ sessions, activeSessionId }>` | 批量移除多个会话的元数据并 `multiRemove` 其消息键 |
| `migrateLegacyMessages` | `(characters) => Promise<Session[]>` | 将旧键消息迁移为历史会话，幂等 |
| `searchMessages` | `(keyword) => Promise<SearchHit[]>` | 跨全部会话做不区分大小写的子串匹配，按会话 `updatedAt` 倒序返回命中 |
| `saveCharacterState` | `(list, activeId, deletedIds?) => Promise<void>` | 逐角色写库（大角色使用文件描述符，索引为提交点）后写入当前 id；`deletedIds` 为单个 id 或 id 数组，逐个移除其消息键（默认角色跳过） |
| `getMoments` / `getMomentsStatus` | `() => Promise<Moment[]>` / `() => Promise<{ status, moments }>` | 读取动态（按 `createdAt` 降序）；损坏时备份并返回 `corrupt`，调用方不得写回空表 |
| `saveMoments` | `(moments) => Promise<Moment[]>` | 规范化、过滤无 `id` 项后写入动态 |
| `getAffinity` / `getAffinityStatus` | `() => Promise<{ [characterId]: State }>` / `() => Promise<{ status, map }>` | 读取好感度；损坏或结构非法时备份并返回 `corrupt`，调用方不得写回空快照 |
| `saveAffinity` | `(map) => Promise<StateMap>` | 规范化并写入好感度 |
| `getUserProfile` / `saveUserProfile` | 见下 | 读取/写入当前人设（用户名、人设）+ 全局头像 |
| `getPersonas` | `() => Promise<Persona[]>` | 读取人设列表；为空时把旧 `@easychat2_user_profile` 迁移为 `default` 一项并写入；损坏时不覆盖原数据，返回默认人设 |
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
| `getSessionSummaries` / `getSessionSummariesStatus` | `(sessionId) => Promise<SessionSummary[]>` / `(sessionId) => Promise<{ status, summaries }>` | 读取会话级记忆总结（按会话隔离）；带状态版本在损坏时备份并返回 `corrupt` |
| `saveSessionSummaries` | `(sessionId, list) => Promise<SessionSummary[]>` | 写入会话级记忆总结 |
| `appendSessionSummary` | `(sessionId, entry) => Promise<SessionSummary[]>` | 追加一条会话级总结；历史摘要读取失败时抛错，不覆盖原数据 |
| `getMemorySummarySettings` | `() => Promise<{ enabled, threshold }>` | 读取独立的记忆总结开关与可总结消息阈值，缺失时默认 `{ enabled: true, threshold: 40 }` |
| `saveMemorySummarySettings` | `({ enabled, threshold }) => Promise<{ enabled, threshold }>` | 归一化并写入独立记忆总结设置，阈值非法时回退 40 |
| `getPlugins` | `() => Promise<Plugin[]>` | 读取联网搜索列表并规范化，内置项缺失时补入；损坏时先备份再返回默认且不落盘 |
| `savePlugins` | `(plugins) => Promise<Plugin[]>` | 规范化并写入联网搜索列表，确保内置项存在 |
| `getEnabledPlugins` | `() => Promise<Plugin[]>` | 返回已开启插件 |
| `isDisclaimerAcknowledged` | `() => Promise<boolean>` | 是否已确认免责条款 |
| `acknowledgeDisclaimer` | `() => Promise<boolean>` | 写入免责条款已确认标记 |
| `isOnboardingDone` | `() => Promise<boolean>` | 是否已完成/跳过新手教学 |
| `completeOnboarding` | `() => Promise<boolean>` | 写入新手教学完成标记 |

**导出的默认值**:
- `DEFAULT_CHARACTER` 含 `id`、`builtin`（初始卡标记，改名/改提示后仍可识别）、`name`、`systemPrompt`、`systemPromptComposed`、`lastUsedAt`，以及扩展字段 `description`、`personality`、`scenario`、`firstMes`、`mesExample`、`creatorNotes`、`postHistoryInstructions`、`tags`、`worldInfo`、`regexScripts`（后四类缺省为空串/空数组）

**AsyncStorage 键约定**:

| 键 | 内容 |
|----|------|
| `@easychat2_api_configs` | API 多配置 `{ configs, activeId }` |
| `@easychat2_api_config` | 旧版单条 API 配置（仅迁移读取，保留） |
| `@easychat2_character_index` | 角色库索引：角色 `id` 字符串数组（新格式） |
| `@easychat2_character_item::<id>` | 单个角色 JSON；超大角色改为 `{ storage: 'file', version, id, fileName }` 描述符，正文位于 `characters/<fileName>` |
| `@easychat2_character_migration` | 角色库迁移提交标记与当前索引快照，防止旧 legacy 整库在后续启动中复活已删除角色 |
| `@easychat2_characters` | 旧版整库 JSON 数组（仅迁移读取，保留不覆盖；Android 大行可由 SQLite 分块读取） |
| `@easychat2_active_character` | 当前角色 `id` |
| `@easychat2_character` | 旧版单角色 JSON（仅迁移读取，保留） |
| `@easychat2_sessions` | 会话元数据数组 |
| `@easychat2_active_session` | 当前会话 `id` |
| `@easychat2_messages::<sessionId>` | 会话消息数组（新数据按会话 id 存储） |
| `@easychat2_messages::<characterId>` | 旧版按角色存储的消息（仅迁移读取） |
| `@easychat2_messages` | 旧版单会话消息（仅默认角色迁移读取时兜底） |
| `@easychat2_user_profile` | 用户全局资料 `{ avatarUri }`（并作为旧单人设的迁移来源，兼容读取 `userName`/`persona`） |
| `@easychat2_personas` | 用户人设列表 `[{ id, userName, persona, createdAt, updatedAt }]` |
| `@easychat2_active_persona` | 当前人设 `id` |
| `@easychat2_preset_list` | 全局预设数组 |
| `@easychat2_global_presets` | 预设开关映射 `{ [presetId]: boolean }` |
| `@easychat2_disclaimer_ack` | 免责条款已读标记（`'true'`） |
| `@easychat2_onboarding_done` | 新手教学完成标记（`'true'`） |
| `@easychat2_memory_summary` | 独立的记忆总结设置 `{ enabled, threshold }`，默认 `{ enabled: true, threshold: 40 }`，不属于全局文本预设 |
| `@easychat2_session_summaries::<sessionId>` | 会话级记忆总结 `[{ summary, keywords, boundary, createdAt }]`（同角色记忆 ≥2 时启用） |
| `@easychat2_plugins` | 联网搜索配置数组（内置 `web-search`） |
| `@easychat2_thinking` | 思考设置 `{ enabled: boolean, level: 'low' \| 'medium' \| 'high', display: 'open' \| 'fold' \| 'off' }` |
| `@easychat2_sampling` | 生成采样设置 `{ maxTokens, temperature, topP, topK }`，每项 `{ enabled, value }`，默认全关闭 |
| `@easychat2_vector_memory` | 向量记忆配置 `{ enabled, providerId, baseUrl, apiKey, model, topK, maxChars, batchSize }` |
| `@easychat2_vector_index::<characterId>` | 按角色隔离的记忆片段索引 `[{ id, messageId, role, at, text, vector }]` |
| `@easychat2_image_gen` | 生图设置 `{ activeProvider, providers: { [id]: { apiKey, baseUrl, model, extra } } }` |
| `@easychat2_chat_options` | 对话选项 `{ streaming: boolean, fullWidth: boolean, richHtml: boolean }`，默认 `{ streaming: true, fullWidth: false, richHtml: true }` |
| `@easychat2_moments_settings` | 动态开关 `{ enabled: boolean }`，缺省 `true`（默认开启） |
| `@easychat2_moments` | 动态列表（按时间倒序，含点赞与评论） |
| `@easychat2_affinity` | 按角色的好感状态 `{ [characterId]: { score, turnCount, triggers } }` |
| `@easychat2_tts` | 语音播报设置 `{ enabled, activeProvider, providers: { [id]: { ...fields } } }` |
| `@easychat2_inline_image` | 对话配图设置 `{ enabled, providerId, stylePrefix, size, maxPromptChars }` |
| `@easychat2_appearance` | 外观设置 `{ themeId: 'dark' \| 'light' \| 'blue' \| 'pink' \| 'crimson', fontScaleId: 'default' \| 'system' \| 'small' \| 'medium' \| 'large' \| 'xlarge' }`（`pink` 显示为「蜜桃」、`crimson` 显示为「薰衣草」） |

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
{authHeader}: {authScheme}<API_KEY>    # 默认 Authorization: Bearer <KEY>；小红书 Dots Studio 为 api-key: <KEY>

{
  "model": "<model>",
  "messages": [{ "role": "system", "content": "..." }],
  "stream": true
}
```

**发送前校验**: `baseUrl` 为空抛「请先填写 API 地址」；无可用模型抛「请先添加并选择模型」；`protocol === 'anthropic'` 抛「Claude 协议暂未开放」。避免空地址或空模型静默回退到默认端点与模型。

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
**返回**: 标准化角色卡 `{ name, fields, systemPrompt, worldInfo, regexScripts, presets }`
**说明**: 兼容标准 V2/V3、扁平结构、织语 `zhiyu_agent_v1`，并对纯文本 JSON 的 BOM、围栏、全角空白和字符串换行做容错
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
**说明**: 系统提示词优先取 `character.systemPromptComposed`，为空回退 `character.systemPrompt`，再回退 `DEFAULT_SYSTEM_PROMPT`；随后按顺序追加 `[用户设定]`（用户人设）、`[对话示例]`（`mesExample`，为空跳过）、`[全局预设]`（已开启预设）、`memorySnippets`（`[相关记忆]`，向量召回，为空跳过）、`[记忆摘要]`（`summaryText`）、`groupContext`（群聊情境，单聊为空）、联网搜索背景资料（`pluginContext`），最后恒定追加 `[输出格式]`（`DEFAULT_OUTPUT_FORMAT_PROMPT`，要求自然分段换行，不受预设开关影响）；`images` 非空时最后一条用户消息的 `content` 为 `[{ type: 'text' }, { type: 'image_url' }]` 多模态数组，否则为纯文本；`quote` 非空且文本非空时在用户消息文本前追加 `[引用<name>的消息] <text>` 强调段（`name` 缺失回退「对方」），只影响当前用户消息；历史用户消息与当前输入应用 placement 1 正则，历史助手消息（含开场白）应用 placement 2 正则，命中的世界书文本应用 placement 5 正则

### 群聊接口
**位置**: `src/groupChat.js`

| 函数 | 说明 |
|------|------|
| `parseMentions(text, characters)` | 解析消息中的 `@角色名`，返回角色 `id` 列表；`@全体` 返回全部成员 `id` |
| `hasEveryoneMention(text)` | 消息是否包含 `@全体` |
| `EVERYONE_MENTION` / `MENTION_PREFIX` | `'全体'` / `'@'` 常量 |
| `selectSpeakers({ characters, history, userText, mentions, everyone })` | 调用 LLM 选出 1-3 个发言角色；解析失败回退本地规则（`@` 优先、名字命中、轮转）；`@` 角色必定入选；`everyone` 为真时返回全部成员且不受 3 人上限 |
| `parseSpeakerResponse(text, characters)` | 解析调度返回的 `{ speakers: [...] }`，按角色名映射为 `id` |
| `generateOpening({ characters, userProfile, globalPresets })` | 生成群场景开场白与首位发言角色，失败回退合成文案 |
| `buildGroupHistory(messages)` | 为助手消息加上 `发言者：` 前缀，供模型区分发言人 |
| `needsProfile(character)` | `description` + `personality` 去空白后字符数 `< 30` 视为简介不足 |
| `generateMemberProfile(character)` | 基于完整角色卡调用 LLM 生成 1-2 行第三人称人设卡，失败返回 `null` |
| `ensureMemberProfiles({ characters, profiles })` | 对简介不足且无缓存的成员生成人设卡，返回新 `profiles`（不重复生成） |
| `buildGroupContext({ speaker, characters, historyMessages, profiles })` | 构造 `[群聊情境]` 文本：多人群聊说明、在场成员名单（含简介与最近发言）、最近对话 |
| `buildGroupRequest({ speaker, characters, historyMessages, userText, userProfile, globalPresets, quote, summaryText, pluginContext, profiles })` | 逐角色模式：以发言角色卡设定构造请求，注入群聊情境并透传引用信息 |
| `buildEnsemblePrompt({ characters, historyMessages, userText, userProfile, globalPresets, profiles, mentions, everyone })` | 群像卡模式：合并全部成员设定为单次调用的提示词，要求按「角色名：」分段并由模型决定发言者与篇幅；`mentions` 注入点名，`everyone` 为真时要求全员发言 |
| `parseEnsembleReply(text, characters)` | 解析「角色名：内容」为发言段 `[{ speakerId, speakerName, text }]`，兼容空行、半角冒号、星号包裹、未知角色与多行内容 |
| `mergeAdjacentSegments(segments)` | 合并同一发言者的连续段，丢弃空文本段 |

**常量**: `MAX_SPEAKERS = 3`、`PROFILE_MIN_CHARS = 30`、`MEMBER_RECENT_LINES = 3`、`GROUP_RECENT_LINES = 8`、`ENSEMBLE_MODE = 'ensemble'`、`TURN_MODE = 'turn'`。

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

`IMAGE_PROVIDERS` 为声明式配置表，按平台内置 `google-ai-studio`、`openrouter`、`stability-ai`、`gitee-ai`、`agnes-ai` 与 `openai-relay`（自定义中转站）；每个平台可声明 `defaultModel`、`listModelsPath`、`keyHint` 与 `corsNote`。`getImageProvider(id)` 按 id 取配置并回退首个，`isKnownImageProvider(id)` 判断 id 是否为当前已内置平台。

| 函数 | 说明 |
|------|------|
| `buildRequest({ provider, config, prompt, image, imageUri, model, size, seed, extra, imageMime })` | 按 t2i/i2i 模板构造请求；支持 GET 查询参数、POST JSON、header/body/query 认证；`requestFormat === 'multipart'`（可由 i2i 规格覆盖）时改发 FormData，若提供 `imageUri` 则把图片作为文件部件发送，否则回退字符串，并自动去掉 `Content-Type`；`spec.endpoint` / `spec.endpointFromBaseUrl` 可覆盖端点（如 OpenAI 中转站图生图走 `/v1/images/edits`）；缺 `baseUrl` 返回 `null`；`model` 缺省回退 `provider.defaultModel` 并剥离 `models/` 前缀，`imageMime` 供 `{mime}` 占位符使用；`size` 写入 `params.size` 前会把 `宽*高` 归一化为 `宽x高`（OpenAI 兼容 / OpenRouter 的像素格式），`spec.stripImagePrefix` 控制图生图是否去掉 `data:` 前缀 |
| `parseImages(provider, data)` | 按 `response.path` 取根节点，兼容字符串、`url`、`base64`（`b64_json`、`images[].url`、`output.results`、`output[]`） |
| `mapHttpError(status)` | 401/403 → 「密钥无效或未授权」；429 → 「请求过于频繁，请稍后重试」；其他 → 「生成失败（HTTP n）」 |
| `listModels({ provider, config })` | 按平台的 `listModelsPath` 拼模型列表地址：内置平台用 `origin + path`（Google AI Studio `/v1beta/models`、OpenRouter `/api/v1/images/models`）；`custom` 平台（OpenAI 兼容中转站）先从 baseUrl 去掉 `baseUrlSuffixes`（`/images/generations`、`/images/edits`）得到目录，再拼 `/models`，以保留 `/api/v1` 等自定义子路径；`listModelsPath` 为空串的平台（Stability AI）抛「该服务不提供模型列表接口」 |
| `parseModelList(data)` | 兼容数组、`data[]`、`models[]`，取 `id` / `name` 归一化为字符串数组 |
| `checkConnectivity({ provider, config })` | 调用 `listModels`，区分 401/403（密钥无效）与网络类错误并返回 `{ ok, models?, error?, authFailed?, networkFailed? }` |
| `detectImageProvider({ provider, config, model, prompt })` | 先尝试模型列表并比对模型名；列表不可用时回退到一次真实生成探测，返回 `{ ok, mode, message, modelFound?, models? }` |
| `generateImage({ provider, prompt, imageFile?, imageUrl?, imageUri?, image?, model?, size?, seed?, extra?, config?, imageMime? })` | 统一生成入口，返回 `Promise<{ images: [{ url?, base64? }], raw }>`；含超时与按 `retries` 重试 |

**说明**: 密钥仅存本机 AsyncStorage；未填地址或密钥时直接抛错不发起请求；`extra.params` 与 Provider 的 `params` 映射按点号路径写入请求体；`sizeSplit` 把 `宽*高` 拆为 width/height；图生图必须携带图片。个性化配置中已下线的旧平台 id 会在读取时被规范化为空，界面回退到首个平台。

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

### 动态接口
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

`TTS_PROVIDERS` 为声明式配置表，内置 `system` 与 `xiaomi-mimo`、`siliconflow`、`iflytek-spark`、`stepfun`、`tencent-cloud`、`aliyun`、`baidu`、`volcano`、`minimax`；`getTtsProvider(id)` 按 id 取配置并回退系统引擎。除 `system` 外的每个服务商带 `apiKeyUrl`（各厂商控制台的密钥申请地址），`TtsPanel` 据此渲染「获取 API Key / 密钥」外链入口。

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

**说明**: 密钥仅存本机 AsyncStorage，不写入日志或文档。播报正文清洗由 `src/speechText.js` 提供：`toSpeechText(text)` 去除 Markdown/HTML/状态栏并折叠空白，`hideVariantStatusBar(text)` 去除 `【数值状态栏】` 等行。

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

**声明式 Provider**: `src/plugins/providers.js` 的 `PROVIDERS` 描述各搜索服务的 `baseUrl`、`method`、`authType`（query/header/body）、`authKeyName`、`queryParam`、`limitParam`、`extra`、`extraFields`、`resultsPath`、`fields`、`secretFields` 与 `keyLinks`（`[{ label, url }]`，各厂商密钥/凭据申请地址，`PluginPanel` 据此渲染外链入口；Google CSE 含凭据与可编程搜索引擎两条）；新增服务只需追加声明。内置 `serpapi`、`google-cse`、`bing`、`brave`、`tavily` 与 `custom`（自定义地址）。密钥仍由用户在应用内填写并存入 `@easychat2_plugins`，不使用环境变量。

**触发词**: `TRIGGER_KEYWORDS`（最新、今天、新闻、股价、天气、汇率等）。

### 记忆总结接口
**位置**: `src/memorySummary.js`

| 函数 | 说明 |
|------|------|
| `selectSummarizable(messages, summarizedUpTo, keepRecent?)` | 返回边界之后、且保留最近若干条（默认 6）以外的可总结消息 |
| `selectManualSummarizable(messages, summarizedUpTo)` | 返回边界之后的全部可对话消息，包含保留的最近消息；边界后为空时回退到完整列表，供手动总结绕过阈值并修复旧空边界 |
| `shouldSummarize({ session, messages, settings, force? })` | 自动触发要求独立开关开启且可总结消息达到阈值；`force` 只要求存在自动候选 |
| `buildSummaryPrompt(messages, userName?, memories?)` | 组装「只提取新增记忆、每行一条 `- `，并在末行输出尽量多、覆盖主要事件的关键词」的提示词，并把已有记忆注入 `<memories>` 区块 |
| `parseMemoryLines(text)` | 按行提取记忆，排除关键词行，去掉 `-`/`*`/`•` 前缀与空行 |
| `parseKeywordsLine(text)` | 从「关键词：」行解析顿号/逗号分隔的关键词，兼容中英文标点 |
| `parseSummaryResponse(text)` | 解析纯文本行式输出，规范化为 `- ` 行并提取关键词；只有关键词而无记忆正文时返回 `skipped`，不推进总结边界 |
| `generateSummary({ character, messages, userName?, memories? })` | 调用 `sendChatMessage` 生成新增记忆行 |
| `applySummary({ session, character, messages, updateCharacter, userName?, scoped? })` | 生成新增记忆：无记忆正文时返回 `skipped` 且不写盘；有内容时 `scoped` 为真写会话级总结，否则写角色世界书（`记忆总结 N`），两者都更新会话边界 |
| `countCharacterMemories(sessions, characterId)` | 统计该角色在记忆页可见的会话数（单聊、`preview` 非空） |
| `isSessionScopedMemory(sessions, characterId)` | 记忆数 ≥ 2 时返回 `true`，启用按会话作用域 |
| `buildWorldSummaryText(character)` | 拼接世界书中「记忆总结」条目内容 |
| `buildSessionSummaryText(sessionSummaries)` | 拼接会话级总结内容 |
| `buildMemorySummaryText(character, sessionSummaries?, scoped?)` | `scoped` 为真取会话总结，否则取世界书总结 |

**常量**: `MEMORY_SUMMARY_PREFIX = '记忆总结'`、`KEEP_RECENT = 6`、`DEFAULT_THRESHOLD = 40`、`MEMORY_SCOPE_THRESHOLD = 2`、`FALLBACK_KEYWORDS`（占位关键词「前情提要」）。

**作用域规则**: 当同一角色在记忆页存在 ≥ 2 条记忆（单聊、摘要非空的会话）时，记忆总结不再写入该角色的世界书（世界书对角色全局生效会造成跨会话串味），改为写入会话级总结并作为 `[记忆摘要]` 随请求发送；既有世界书条目保留、只停止新增。**当会话所属角色已被删除（`characters` 中不存在该 `characterId`）时，同样强制按会话作用域处理**，避免写入不存在的角色世界书。

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

**替换语法**: 替换文本走 JS `String.replace` 语义（`$1`/`$&`/`$$`），并把 `$0` 兼容为整段匹配（映射为 `$&`），以兼容角色卡常见写法。

### `richHtml` 辅助函数
**位置**: `src/richHtml.js`（纯函数，供 `ChatScreen`/`RichHtmlMessage` 与测试使用）

| 函数 | 说明 |
|------|------|
| `needsRichHtmlRendering(text)` | 文本是否含内置渲染器不支持的标签（`<style>`/`<script>`/`<details>`/`<summary>`/`<svg>`/`<audio>`/`<video>`），这类消息需要 WebView 才能还原样式、折叠、媒体播放与交互 |
| `shouldRenderRichHtml(text, enabled)` | 在上者基础上叠加 `richHtml` 开关；含 `<details>`/`<summary>` 时始终返回 `true`，确保折叠状态栏标题保留 |
| `stripMarkdownFences(text)` | 去掉 ` ```html ` / ` ``` ` 围栏行 |
| `buildRichHtmlDocument({ bodyHtml, textColor, linkColor, fontSize, fontFamily })` | 包装为完整 HTML 文档（含视口与高度回传/命令桥脚本） |
| `RICH_HTML_RESIZE_BRIDGE` | 注入的桥脚本：`ResizeObserver` 回传高度、`button[data-command]` 回传命令 |

### `RichHtmlMessage`（默认导出）
**位置**: `src/RichHtmlMessage.js`

用 `react-native-webview` 渲染含 `<style>`/`<script>`/媒体标签的助手消息，动态高度由桥脚本回传（`<details>` 展开/收起与点击后都会重新测量，优先使用 `body` 实际边界高度）；富 HTML 消息的内容容器、气泡和 WebView 强制撑满可用宽度并允许收缩，完整 HTML 文档会直接作为 WebView 页面加载，注入盒模型、宽度约束、换行策略、运行时命令桥与 `window.triggerSlash`，避免地图等宽内容把正文和卡片挤成左右两列、横向溢出、闪烁和局部白屏。`onCommand` 接收 `button[data-command]` 的斜杠命令。WebView 开启 `allowsFullscreenVideo` 与多窗口支持，卡内 `<video controls>` 可进入原生全屏，同时拦截新窗口以保持卡片链接留在当前消息内。因关闭了 WebView 自身滚动，普通片段包装会注入 `body *{max-height:none !important}`，完整页面保留自身滚动与折叠规则。`react-native-webview` 缺失时返回 `null`。

### `maskSecrets(text)`
**位置**: `src/secrets.js`
**说明**: 将 `sk-...` 与 `Bearer ...` 替换为 `[API_KEY已隐藏]`；**辅助导出** `SECRET_PATTERN`

### `DISCLAIMER_TEXT` / `DISCLAIMER_SECTIONS` / `DisclaimerModal`
**位置**: `src/disclaimer.js`
**说明**: `DISCLAIMER_TEXT` 为免责条款纯文本；`DISCLAIMER_SECTIONS` 为同源的分节结构 `[{ title?, icon?, body?, bullets? }]`；`DisclaimerModal`（默认导出）Props 为 `{ visible, title?, content?, sections?, onClose }`，`content` 缺省为 `DISCLAIMER_TEXT`、`sections` 缺省为 `DISCLAIMER_SECTIONS`（传入 `content` 时以文本渲染），用于启动弹窗与聊天「公告」

### `ONBOARDING_CHAPTERS` / `OnboardingModal`
**位置**: `src/onboardingContent.js` / `src/OnboardingModal.js`
**说明**: `ONBOARDING_CHAPTERS` 为向导与教程共用的章节数据（12 章），结构 `{ id, title, icon, image?, images?: [{ key, caption? }], summary, disclaimer?, intro, sections?, warning?, links?: [{ label, url }], steps: string[], items: [{ name, where, usage }], note, outro? }`；单图用 `image`，多图用 `images`（优先于 `image`）；`sections` 为结构化条款（免责章取自 `DISCLAIMER_SECTIONS`），经 `ChapterSections` 渲染；`disclaimer` 为章首声明、`warning` 为合规警告、`links` 为可点击外链（如角色卡来源平台），三者经 `ChapterNotice` 渲染；`outro` 为章末附加块 `{ title, body?, bullets?: string[], link?: { label, url }, linkNotice?, disclaimer? }`，经 `ChapterOutro` 渲染（角色卡获取章的「进阶工具」）。聊天厂商与生图服务清单分别由 `apiVendors.js`、`imageGen/providers.js` 生成，免责正文取 `DISCLAIMER_TEXT`。辅助导出 `getOnboardingChapter(id)` 取单章、`getOnboardingChapters(ids)` 取子集（`ids` 为空返回全部）。`OnboardingModal`（默认导出）Props 为 `{ visible, onFinish }`，一次展示一章，含进度条、上一/下一步与跳过，`onFinish` 在末章或跳过时触发；图片经 `getOnboardingImages(chapter)` 解析（`src/onboarding/images.js`）后交给 `ChapterImages` 横向分页渲染，未注册的图直接跳过。`ChapterImages`（`src/ChapterImages.js`，默认导出）Props 为 `{ images: [{ source, caption }], height?, style? }`，按容器宽度分页、多图显示圆点指示、图注跟随当前页。`ChapterSections`（`src/ChapterSections.js`，默认导出）Props 为 `{ sections: [{ title?, icon?, body?, bullets? }] }`，逐节渲染图标标题、正文与要点，供免责弹窗与免责教学章共用。

### `ChapterModal` / `ChapterNotice` / `ChapterImages` / `TutorialModal`
**位置**: `src/ChapterModal.js` / `src/ChapterNotice.js` / `src/ChapterImages.js` / `src/TutorialModal.js`
**说明**: `ChapterModal`（默认导出）Props 为 `{ visible, onClose, chapterIds, title?, buttonText? }`，全屏 `Modal` + `ScrollView` 渲染指定章节（摘要、正文、合规警告、外链、编号步骤、速查条目、注意事项与已注册图片，`chapterIds` 为空数组时渲染全部）；`chapterIds` 含多章时顶部渲染可横滑的章节目录 chips，点击按 `onLayout` 记录的偏移滚动到对应章节；各界面「教学」按钮以单章子集打开它。`ChapterImages`（默认导出）Props 为 `{ images: [{ source, caption }], height?, style? }`，横向分页、多图圆点指示、图注跟随当前页。`ChapterNotice`（默认导出）Props 为 `{ disclaimer?, warning?, links?: [{ label, url }] }`，依次渲染章首声明、警告框与可点击外链，点击链接先 `Alert` 二次确认再 `Linking.openURL`。`ChapterOutro`（默认导出）Props 为 `{ outro }`，渲染章末附加块（标题、正文、要点列表、外链与免责声明），外链确认文案取 `linkNotice`。`TutorialModal`（默认导出）Props 为 `{ visible, onClose }`，是 `ChapterModal` 展示全部章节的薄封装，由设置页「使用教程」入口打开；`TUTORIAL_SECTIONS` 为 `ONBOARDING_CHAPTERS` 的兼容转发（`src/tutorialContent.js`）。

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
| `presets` | `CharacterPreset[]?` | 随角色卡保存的角色预设，发送时注入 `[角色预设]` |
| `lastUsedAt` | `number?` | 最近一次成为当前角色的时间戳，决定列表排序 |
| `pinned` | `boolean?` | 是否置顶；置顶角色排在角色库最前 |

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

头像为全局共用，存于 `@easychat2_user_profile`，不随人设切换。

### `Session`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 会话标识，形如 `session-<base36 时间戳>-<随机>`；迁移会话为 `legacy-<characterId>` |
| `type` | `'single' \| 'group'` | 会话类型，缺省为 `single` |
| `characterId` | `string` | 单聊所属角色 `id`；群聊为空串 |
| `members` | `string[]` | 群聊成员角色 `id` 列表；单聊为空数组 |
| `memberProfiles` | `{[characterId]: string}` | 群聊成员人设卡缓存（简介不足时懒生成）；单聊为 `{}` |
| `groupMode` | `'ensemble' \| 'turn' \| ''` | 群聊发言模式：`ensemble` 群像卡单次生成（缺省），`turn` 逐角色模式；单聊为空串 |
| `avatarUri` | `string` | 群聊头像路径（可来自成员角色卡或用图片）；单聊为空串 |
| `bgUri` | `string` | 群聊背景图路径；单聊为空串 |
| `name` | `string` | 群聊名称；单聊为空串 |
| `preview` | `string` | 最后一条可读消息的摘要，最长 60 字 |
| `pinned` | `boolean` | 是否置顶 |
| `greetingSelected` | `boolean` | 单聊是否已完成开场白选择；新建空会话时缺省为 `false` |
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
| `threshold` | `number` | 自动总结阈值（可总结消息条数），大于 0 的整数，默认 40；手动总结绕过此阈值 |

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
| `baseUrl` | `string` | 接口地址；可为空串（厂商预设如 AMD 待用户填），发送前会校验非空 |
| `apiKey` | `string` | 密钥，仅存本机 |
| `vendorId` | `string` | 来源厂商预设 id（`apiVendors.js`），空串表示自定义 |
| `protocol` | `'openai' \| 'anthropic'` | 接口协议；`anthropic` 目前置灰未开放，发送时会报错 |
| `authHeader` | `string` | 鉴权头字段名，默认 `Authorization`；小红书 Dots Studio 为 `api-key` |
| `authScheme` | `string` | 鉴权头前缀，默认 `Bearer `；允许空串 |
| `apiKeyUrl` | `string` | 密钥获取页，用于「点击获取密钥」跳转 |
| `models` | `string[]` | 模型列表；厂商预设创建时为空，需添加或「检测模型」，保存时要求非空 |
| `activeModel` | `string` | 当前模型，必须属于 `models` |
| `supportsThinking` | `boolean` | 是否支持思考，保存前确认 |
| `supportsVision` | `boolean` | 是否支持识图，保存前确认 |
| `thinking` | `{ field, format }` | 思考参数声明；`format` 为 `effort` / `boolean` / `object`，缺省 `reasoning_effort` + `effort` |

厂商与协议预设见 `src/apiVendors.js`：`CHAT_API_VENDORS`（DeepSeek、魔搭、ai.gitee、Agnes、小红书 Dots Studio、NVIDIA NIM、AMD Radeon Cloud）、`API_PROTOCOL_PRESETS` 与 `THIRD_PARTY_RELAY_RISK`；`getChatApiVendor(id)` 按 id 取厂商。
