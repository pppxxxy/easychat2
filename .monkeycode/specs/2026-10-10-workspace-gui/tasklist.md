# 工作区界面线（P0–P5）执行清单

> 规划与依据见 `.monkeycode/docs/agent-workspace-gui-parity.md`（vs DeepSeek Harness 桌面端）。
> 分支 `d1010d3`（基于 `d1010d2`）。用户已裁决：**P1 宽屏破例允许两栏**。
> 纪律：每项独立提交、四条门禁全绿 + 覆盖率、行为测试（守卫类做注入验证）、推送 origin。

## 现状基线（`d1010d2` @ `973b5a2`）

- 骨架：唯一全屏 Modal + 左栏 76px 图标轨五领域（`WorkspaceScreen.js:31-37,98`），内容区条件渲染（`:139-165`）→ 面板单开。
- 工具过程：**只有一行会闪过的 `toolStatus`**（`ChatPanel.js:1188,1486-1491`）；`ToolBubble` 只在聊天页（`MessageList.js:193`）；`toolTrace` 已落盘未展示（`ChatPanel.js:1281-1282`）。
- 检索：聊天/会话历史/本地文件**全无搜索**；唯一搜索框在 GitHub 面板（`GithubPanel.js:1262`）。
- 扩展点 GUI：子代理档案**零入口**；技能只有数量；MCP 入口只在主设置页（`SettingsScreen.js:1785-1796`）。
- 收尾：`WorkspaceScreen.js:163` 传 `onClose` 但 `WorkspaceSettingsPanel.js:22` 不接收；上下文占用两处重复（`WorkspaceSettingsSheet.js:327-353` 与 `FilesPanel.js:1100-1123`）；`专有概念/工作区.md:20-22` 文档过时。

## P0 工作区工具过程可见

- [x] **P0-1 纯函数模型**：`src/chat/toolCardView.js` —— `applyToolEvent`（事件流 → 逐次调用卡片）、
      `summarizeToolArgs`（挑「最能说明动了什么」的字段，拿不到给空串而不是一坨 JSON）、
      `toolCardLabelKey`（未登记的工具返回空串 → 界面回退显示原始工具名）、`summarizeToolCards`。
      与 `chat/toolBubbleView.js` **分工不同**（那个是聊天页 search/fetch 两阶段气泡、按轮次+工具名折叠）。
      测试：`tests/toolCardView.test.mjs` 8 条（含「同一轮同名工具调两次 = 两张卡」、
      「没有配对 start 的 end 一律忽略，不凭空补卡」、不可变更新）。
- [x] **P0-2 组件 + 接线**：`src/workspace/screen/ToolCardList.js`（三态图标 + 标签 + 参数摘要 + 折叠，
      折叠状态由组件自持，宿主不多开 state）；`ChatPanel` 的单行 `toolStatus` 换成卡片列表，
      `onToolEvent` 改为 `setToolCards(prev => applyToolEvent(prev, event))`。
      i18n：`workspace.toolCard.*` 共 20 条（zh-CN + en）。
      **棘轮**：ChatPanel 仍是 1853 行（余量 0）——靠把渲染压成一行 + 组件自持折叠换来。
- [x] **P0-3 接上已落盘的 `toolTrace`**：助手气泡下方可折叠回看「上一轮读了什么、改了什么」。
      新增 `traceToToolCards`（按 `tool_call_id` 配对、解析 JSON 字符串形式的 arguments、
      结果只取第一行做预览）与 `traceCardsForMessage`（按消息对象身份 WeakMap 记忆化——
      单条轨迹最大 256KB，而流式期间 `messages` 每个 token 换一次引用，不缓存就会反复重算）。
      **诚实边界**：轨迹里没有 `isError`，历史卡片一律 `RECORDED` 中性态，**绝不标成功/失败**；
      无配对结果时显示「未返回结果」（可能被拒绝/报错/中止）。
- [x] **P0-4 门禁**：lint 0 ｜ 2462/2462 ｜ guard ok（含棘轮：ChatPanel 1794 行，余量 59）｜
      i18n 缺失 0 ｜ 覆盖率 行 80.2% / 分支 77.41% / 函数 82.66% ｜ 打包通过。

### 前置：拆出叶子部件腾余量（P1 的第一步，已完成）

- [x] **抽出 `PlanProgressBar.js`**：ChatPanel 卡在棘轮基线上（1853 = 基线，余量 0），
      自成一体的部件先出去才加得动东西。54 行渲染 + 30 行样式 → 13 行组件调用，
      **1853 → 1781（余量 72）**，行为不变（折叠状态仍由宿主持有，因为「新计划自动展开」
      的时机只有宿主知道）。既有的两条接线契约断言跟着代码搬到新文件。

## P1 宽屏两栏（已批准破例）

- [x] **P1-1 布局解算内核**：新增纯函数 `src/workspace/splitLayout.js` —— `isWideLayout`（阈值 900）、
      `resolveWorkspaceLayout`（**宽屏 + 不在对话领域**才两栏；宽屏下的对话仍全宽）、
      `splitColumns`（两栏之和恒等于总宽；放不下返回 null 而**不硬分**）、`ratioFromDrag`（位移按
      总宽折算，手感一致）、`clampSplitRatio` / `normalizeStoredLayout`（读回时任一项不合法就
      整份丢弃）。测试 7 条。抓到自己一个真实缺陷：`Number(null)` 是 0（有限），
      于是「没有值」被当成「拖到最左」夹到下限——已把空值与 0 区分开。
- [x] **P1-2 `WorkspaceScreen` 两栏接线**（229 → 292 行，不在基线）。窄屏**逐字不变**（走原来的
      条件渲染，只是抽成 `renderChatPanel`/`renderDomainPanel` 两个具名函数）；宽屏时**树形稳定**
      （对话永远挂同一位置，切侧栏不卸载重建 `ChatPanel`，否则草稿会丢）；「宽屏+设置」用
      `display:'none'` 让对话保持挂载但不参与布局；分隔条 `PanResponder` 拖动，比例/宽度存 ref
      让 responder 只建一次；`RAIL_WIDTH` 提成常量供样式与解算共用。
      规则收紧：侧栏只认**文件/GitHub/终端**（对话与**设置**都保持单栏）。
      **比例暂不持久化**（`normalizeStoredLayout` 已写好测过，落盘要动 settings 白名单，留下一步）。
- [x] **P1-3 比例持久化**：设置白名单新增 `splitLayout`；打开时读回，**只在松手时落盘**
      （拖动中每帧写一次存储是没必要的 IO，松手前崩溃留下的半截比例也没意义）。
      **只存比例、不存「侧栏选了谁」**——那是「当前在干什么」而不是偏好，每次打开都该回到对话；
      把它也持久化会让用户打开工作区时莫名停在文件面板上。`normalizeStoredLayout` 因此从
      `{ratio, side}` 收紧成 `{ratio}`。
- [x] **P2-1（第一步）聊天消息检索内核**：新增纯函数 `src/chat/messageSearch.js`
      （`messageSearchText` 认 content/text/多模态数组三种形态；`searchChatMessages` 返回
      `{matches,total,truncated}`，与 `fileSearch.js` **同构**，但命中带 `index`——要能定位回
      那条消息）。结果倒序、空查询不返回结果。测试 7 条。
- [x] **P2-1（第二步）界面接线**：顶部动作行加搜索开关，展开后是检索条 + 命中计数；
      有查询时**就地过滤**消息列表。**为什么不是另开一页结果**：RN 的 `ScrollView` 没有
      `scrollToIndex`，另开结果页就**没法「跳到那条」**——就地过滤把命中留在原位置，反而诚实。
      抓到自己一个 bug：最初用 `' '` 当「已展开」哨兵，而 `searching` 按 `trim()` 判，
      空格 trim 完是空 → **搜索条永远打不开**；已改成独立布尔，并区分「展开」与「过滤」。

## P2 完成 ✅
- [x] **P1-4 窄屏行为**：由 `tests/splitLayout.test.mjs` 覆盖——`resolveWorkspaceLayout` 的
      窄屏分支（`width < 900` → `single: true`，无论选哪个领域）就是窄屏行为的判据本身；
      界面侧「窄屏走原条件渲染」由 `workspaceHome.test.mjs` 的分发函数断言间接钉住。
      **不新增源码断言**（仓库约定：新增测试必须是行为测试）。

## P2 检索与导航

- [x] P2-1（第一步）聊天消息检索内核（见上）。
- [ ] P2-1（第二步）界面接线。
- [x] **P2-2 会话历史搜索 + 排序**：新增纯函数 `src/workspace/chatHistoryView.js`
      （`chatPreview` / `filterChats` / `sortChats` / `buildChatHistoryView`）。关键词**同时匹配
      标题与预览**（用户记得的常是「那句话」）；预览收进纯函数是为了让**过滤与渲染用同一份**
      （原来预览在渲染里现算，两处各算迟早漂移）。排序只给两种**基于时间**的顺序——
      不提供「按标题排」，因为那要 `localeCompare` 的 ICU 数据，Hermes 上中文按码位排会像乱序。
      界面：检索框（带清除）+ 两个排序 chip + 区分「没有会话 / 没有匹配」的空态。
      顺手把行内 `chat.messages.length` 换成 `chatMessageCount`（原写法缺 `messages` 会抛）。
      测试 8 条。
- [x] **P2-3 本地文件搜索**：新增纯函数 `src/workspace/fileSearch.js`
      （`searchWorkspaceFiles(files, query, {limit})` → `{matches, total, truncated}`）。
      排序：**文件名命中 > 仅路径命中**，同档路径越浅越靠前。两个有意取舍：**只搜文件不搜目录**
      （目录能逐层点，混进结果只是噪声）、**空查询不返回结果**（那时该显示原来的树）。
      界面：工具行下方搜索框（带清除），有词时平铺结果替代目录树，截断时说清「还有 N 条」。
      测试 7 条（其中一条抓的是我自己写的 `Number(limit) || 50` 让 `limit:0` 变 50 的缺陷）。
      FilesPanel 1493 行（基线 1580，余量 87）。

## P3 扩展点 GUI 补齐

- [x] **P3-1 子代理档案**：新增 `workspaceAgents` 状态（`ChatPanel` 在设置面板打开时读取，
      与技能同一处 effect、同一套静默降级）+ 设置面板的 `agents` 行与只读清单体。
      提示文案写明两件用户猜不到的事：**放在哪个目录**、**模型最多看到前几个**
      （`AGENT_LIST_MAX = 12`）。没有「安装示例」——仓库里没有样例档案可装，不编假入口。
- [x] ~~P3-2 技能：从「只有数量」升级为逐条列表~~ —— **本条作废**：技能行**本来就有逐条列表**
      （`WorkspaceSettingsSheet.js:404-416`）。初版 parity 文档照抄了子代理报告的失准描述，
      已在文档里更正并留痕。
- [x] **P3-4 会话事件流只读视图**：新增纯函数 `src/workspace/sessionEventView.js`
      （`eventPreview` / `eventTimeLabel` / `summarizeSessionEvent` / `summarizeSessionEvents`）。
      那一行从**动作行**改成**可展开行**（先看，再决定导不导出——顺带消除「点一下不小心导出」）；
      列表**倒序**（回看的第一诉求是「刚刚发生了什么」）。`ChatPanel` 按当前会话读事件，
      `activeChatId` 进 effect 依赖。测试 7 条。
      **如实记录**：`SESSION_EVENT_TYPES` 声明 8 种，但只有 ChatPanel 三个写入点，实际只会出现
      `user`/`assistant`/`tool_call`；其余 5 种备了文案但**不假装它们存在**，未登记类型走兜底。
- [x] **P3-3 MCP 入口**：`ChatPanel` 读 `getMcpServers()` 传给面板；设置面板新增只读 `mcp` 行
      （`启用数/总数` / 全部停用 / 未配置）与展开体（逐服务器「名字 · 状态 · 工具数」）。
      **不做配置**（同一份设置两处各存一份必然漂移）；底部按钮「去『设置 → 扩展』配置」调 `onClose`
      ——工作区本就是设置页打开的 Modal，关掉即回到设置，不需要新造跨屏导航。
      顺带补齐 P3-1 漏掉的 12 行词条缩进。

## P3 完成 ✅（P3-2 作废，见上）

## P4 收尾与一致性

- [x] **P4-1 面板化改造收尾**：`ChatPanel`/`FilesPanel`/`WorkspaceSettingsPanel` 三个面板都收到
      了签名里没有的 `onClose`（死 prop，已确认不是「按了没反应」的死按钮）→ **删 prop 而不是补参数**
      （导航是屏幕的职责）。顺带修真问题：Android 返回键此前一律 `onClose`，在子面板里按返回会
      **直接关掉整个工作区**；现在按层级退（`handleRequestClose`：子面板→对话，对话→关工作区）。
- [x] **P4-2 上下文占用两处重复 → 收敛单一来源**：删掉 `FilesPanel` 的「调参」折叠卡
      （思考强度 + 上下文占用）。两处是同一份数据的两个显示，且是 **agent 参数放在「文件」
      领域**的范畴错误；先确认设置面板那两行是**可交互**同款控件才删。连带删掉 7 个只服务它的
      import、`loadContextUsage`/`updateThinking`/`formatTokens` 与 13 个样式。
      `FilesPanel.js` **1580 → 1396（余量 184）**。两条既有源码断言按新契约改写为「钉单一来源」
      （含反向断言防复活）。
      **下一个卡点**：`WorkspaceSettingsSheet.js`（基线 904）也是 0 余量——P3 要往那里加
      「子代理档案 / 技能逐条」行，得先同样抽件。
- [x] **P4-3 文档滞后**：`专有概念/工作区.md` 的界面图与「左列」描述停在旧设计
      （新建对话/新建项目/查找历史/综合设置），已按五领域图标轨重画，并补上返回键层级、
      「面板不接收 onClose」两条契约。
- [x] **P4-4 第一批：面板内确认条**。新增 `src/workspace/screen/ConfirmBar.js`（纯展示，
      不持有待确认状态——不同面板的确认对象不同，收进组件反而要把业务状态搬进来）。
      **分工**：面板内确认条 = 用户主动发起、可撤销性低的操作；系统 Alert = 必须打断的、用户没
      预期的（报错/权限/失败）。第一批接入**文件面板的删除文件**。
      后续同类流程（清空改动、目录删除、GitHub 覆盖/推送）按同一形状接入。
- [x] **P4-4 第二批**：文件面板的「清空改动」从系统弹框换成面板内确认条（与删除文件同一形状）。
- [ ] **P4-4 剩余缺口**：**空目录删除目前根本没有确认**——`handleDeleteDirectory` 只在「非空」
      时弹提示，空的直接删。这属于**要补的缺口**而不是要换的形状（非空那处是「用户没预期的
      拒绝」，按 P4-4 的分工**应该继续用系统 Alert**）。
- [ ] P4-4 后续：GitHub 面板的覆盖 / 推送确认（同一形状接入）。

## P5 手势与极简键盘（低优先）

- [ ] P5-1 移动端手势：面板间横滑切换 / 列表滑动操作 / 长按菜单。
- [ ] P5-2 平板 + 外接键盘极小子集（发送 / 停止 / 切换面板）。

## 明确不做（沿用既有裁决）

LSP 集成（物理不可行）｜53 包插件化 UI｜完整键位录制系统｜Electron 内嵌浏览器｜Plan DAG｜
工具结果向量检索｜上下文老化淘汰｜重做 MCP 泛化 / `run_subagent` / SKILL.md 基础格式。
