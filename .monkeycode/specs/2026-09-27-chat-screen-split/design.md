# ChatScreen 拆分技术方案

Feature Name: chat-screen-split
Updated: 2026-09-27
状态: PR1（阶段 A+B）已提交；阶段 C 完成（已抽 useScrollScrubber/useChatSearch/useChatTts/useChatModelThinking）；阶段 D 的 10 个内联 Modal 已全部抽出 + 搜索栏/顶栏已抽（SelectionTextModal、SwitcherModal、MentionPickerModal、ModelPanelModal、ThinkingPanelModal、StickerPanelModal、StickerNamePromptModal、MoreMenuModal、ChatSettingsModal、FullScreenInputModal、ChatSearchBar、ChatTopBar）；阶段 D 剩余：输入区 render 子树

## 实施记录

- 2026-09-27 PR1（阶段 A+B）完成：新建 `src/chat/{chatConstants,chatHelpers,chatStyles,ThinkingIndicator,MessageBubble,ErrorBubble}.js`；`ChatScreen.js` 6112 → 4506 行；同步改 `richHtml.test.mjs`（断言合并读 ChatScreen + MessageBubble）与 `aigc.test.mjs`（断言指向 `chatConstants.js`）；`.c8rc.json` 排除 4 个 RN 展示/样式文件、保留两个纯逻辑文件并新增 `tests/chatHelpers.test.mjs`。核验：所有搬迁块与原文逐字一致（仅加 `export`/`export default`）。
- 2026-09-27 PR2 阶段 C 第 1 个 hook 完成：`src/chat/useScrollScrubber.js`（快速定位滑动条）。共享的滚动基础设施（`scrollRef`/`messageOffsetsRef`/`scrollToMessage`）仍留在 ChatScreen，通过参数注入，因为搜索定位与引用跳转也依赖它。依赖数组与原文逐字保持一致（稳定 ref 不加入依赖）。`.c8rc.json` 排除该 hook（含 `react`，Node 里不可加载）。
- 2026-09-27 PR2 阶段 C 第 2 个 hook 完成：`src/chat/useChatSearch.js`（聊天内搜索：`searchOpen`/`searchQuery`/`activeMatchIndex`/`searchMatches`/`goToMatch`/`closeSearch` + 自动定位 effect）。同样把共享的 `scrollToMessage` 与跨功能焦点锚点 `focusedMessageId` 留在 ChatScreen、参数注入；依赖数组与原文逐字一致。核验：4 个关键逻辑块逐字搬运。`.c8rc.json` 排除该 hook。`ChatScreen.js` 4506 → 4446 行。
- 2026-09-27 PR2 阶段 C 第 3 个 hook 完成：`src/chat/useChatTts.js`（语音播报设置 + 手动/自动播报）。完全自包含（只依赖 storage/tts/speechText 与自身 state/ref），不触碰会话竞态守卫；hook 调用点放在原 `ttsSettings` 声明处（所有 tts 引用之前），消除前向引用。核验：3 个关键逻辑块逐字搬运。`.c8rc.json` 排除该 hook。`ChatScreen.js` 4446 → 4403 行。
- 2026-09-27 PR2 阶段 C 第 4 个 hook 完成：`src/chat/useChatModelThinking.js`（模型来源 + 思考设置面板）。依赖注入 `isSending`/`sendLockRef` 两个发送守卫锚点（唯一的跨功能耦合，用于「发送中禁止切换模型」），不碰会话竞态守卫。核验：4 个关键逻辑块逐字搬运；组件内移除不再用的 `saveApiConfigs`/`saveThinkingSettings` import。`.c8rc.json` 排除该 hook。`ChatScreen.js` 4403 → 4356 行。
- 2026-09-27 PR3 阶段 D 第 1 个 Modal 完成：`src/chat/SelectionTextModal.js`（选择文本弹窗，props `text`/`onClose`，自建 styles）。核验：整块 markup 逐字搬运，仅把 `visible={!!selectionText}` 改为 `visible={!!text}`、两处 `setSelectionText('')` 改为 `onClose`、`Clipboard.setStringAsync(selectionText)` 改为 `Clipboard.setStringAsync(text)`。组件内移除不再用的 `expo-clipboard` import。`.c8rc.json` 排除该文件。`ChatScreen.js` 4356 → 4326 行。
- 2026-09-27 PR3 阶段 D 第 2 个 Modal 完成：`src/chat/SwitcherModal.js`（角色/群聊切换弹窗）。props 收 `visible`/`onClose`/`characters`/`isGroup`/`activeId`/`onSwitch`/`groupSessions`/`activeSessionId`/`onSwitchGroup`/`groupSessionName`；`visible` 与回调仍留在 ChatScreen。核验：markup 逐字搬运，仅 `setSwitcherOpen(false)` → `onClose`。`.c8rc.json` 排除该文件。`ChatScreen.js` 4326 → 4257 行。
- 2026-09-27 PR3 阶段 D 第 3 个 Modal 完成：`src/chat/MentionPickerModal.js`（提及成员弹窗）。props 收 `visible`/`onClose`/`groupCharacters`/`insertMention`；`EVERYONE_MENTION` 由组件直接从 `../groupMentions` 导入（纯函数模块，非 chatConstants），ChatScreen 移除该 import。核验：markup 逐字搬运，仅 `setMentionPickerOpen(false)` → `onClose`（调用顺序不变）。`.c8rc.json` 排除该文件。`ChatScreen.js` 4257 → 4208 行。
- 2026-09-27 PR3 阶段 D 第 4 个 Modal（模型 + 思考成对）完成：`src/chat/ModelPanelModal.js`（props `visible`/`onClose`/`apiConfigs`/`modelSourceId`/`setModelSourceId`/`applyModelSelection`/`isSending`）、`src/chat/ThinkingPanelModal.js`（props `visible`/`onClose`/`thinkingSupported`/`thinkingEnabled`/`thinkingLevel`/`thinkingDisplay`/`applyThinking`）。思考常量来源：`THINKING_LEVELS`/`THINKING_DISPLAYS` 来自 `../storage`，`THINKING_LEVEL_LABELS`/`THINKING_DISPLAY_LABELS` 来自 `./chatConstants`。核验：markup 逐字搬运，仅 `set*Open(false)` → `onClose`。ChatScreen 移除不再用的 `Switch` 与 4 个思考常量 import。`.c8rc.json` 排除两文件。`ChatScreen.js` 4208 → 4055 行。
- 2026-09-27 PR3 阶段 D 第 5 个 Modal（贴纸成对）完成：`src/chat/StickerPanelModal.js`（props `visible`/`onClose`/`stickers`/`stickerSaving`/`addStickerFromPicker`/`sendSticker`/`inputDisabled`）、`src/chat/StickerNamePromptModal.js`（props `visible`/`onClose`/`draft`/`onChangeDraft`/`confirmStickerName`/`stickerSaving`）。核验：markup 逐字搬运，仅 `setStickerPanelOpen(false)` → `onClose`、`setStickerNameDraft` → `onChangeDraft`。`.c8rc.json` 排除两文件。`ChatScreen.js` 4055 → 3979 行。
- 2026-09-27 PR3 阶段 D 第 6 个 Modal（更多菜单 + 聊天设置）完成：`src/chat/MoreMenuModal.js`（props `visible`/`onClose`/`items`；菜单项数组仍在 ChatScreen 构造并传入，组件只渲染，保留渲染期状态捕获与 `onClose → item.onPress` 顺序）、`src/chat/ChatSettingsModal.js`（props `visible`/`onClose`/`onOpenSystemSettings`/`editLabel`/`onOpenEditor`；`onClose → 具体回调` 顺序不变）。核验：markup 逐字搬运。`.c8rc.json` 排除两文件。`ChatScreen.js` 3979 → 3915 行。
- 2026-09-27 PR3 阶段 D 第 7 个 Modal（全屏输入）完成：`src/chat/FullScreenInputModal.js`（props `visible`/`onClose`/`text`/`onChangeText`/`onSend`）。**会话竞态守卫逻辑未拆**：内联 async `onSend`（`captureSessionGuard`/`isSessionGuardCurrent`/`sendMessage`）原样留在 ChatScreen，仅作为 prop 注入组件。`canSend = !!text.trim()` 在组件内推导，与原文 `!fullScreenText.trim()` 等价。核验：markup 逐字搬运。ChatScreen 移除不再用的 `Modal` import。`.c8rc.json` 排除该文件。`ChatScreen.js` 3915 → 3882 行。
- 2026-09-27 阶段 D 小结：render 内 10 个内联 `Modal` 已全部抽出为 `src/chat/*Modal.js`，render 中不再有内联 `<Modal>`。阶段 D 剩余 render 子树：顶栏、输入区、搜索栏。
- 2026-09-27 PR3 阶段 D 第 8 个 render 子树完成：`src/chat/ChatSearchBar.js`（props `visible`/`query`/`onChangeQuery`/`matchCount`/`activeMatchIndex`/`onPrev`/`onNext`/`onClose`）。`visible` 为假时组件内部返回 `null`（等价原 `searchOpen ? (...) : null`）。核验：markup 逐字搬运，`goToMatch`/`closeSearch`/`setSearchQuery` 与派生计数仍留在 ChatScreen 参数注入。`.c8rc.json` 排除该文件。`ChatScreen.js` 3882 → 3848 行。
- 2026-09-27 PR3 阶段 D 第 9 个 render 子树完成：`src/chat/ChatTopBar.js`（聊天页顶栏，含消息多选态与常规态）。props 收 `messageSelectionOpen`/`selectedCount`/`isSending`/`onCancelSelection`/`onDeleteSelected`/`onOpenSwitcher`/`loaded`/`isGroup`/`groupAvatarUri`/`characterAvatarUri`/`displayName`/`onNewChat`/`ready`/`autoBroadcast`/`onToggleBroadcast`/`onOpenMore`；`character.avatarUri` → `characterAvatarUri`、`ttsSettings.autoBroadcast` → `autoBroadcast`、`selectedMessageIds.length` → `selectedCount` 仅为改名。核验：markup 逐字搬运。`.c8rc.json` 排除该文件。`ChatScreen.js` 3848 → 3772 行。

### 阶段 C 候选评估（2026-09-27）

- **attachments（暂缓）**：`addAttachment`/`removeAttachment` 依赖 `captureSessionGuard`/`isSessionGuardCurrent` 竞态守卫，命中「不拆竞态守卫」约定。
- **inlineImage（暂缓）**：`generateInlineImage` 依赖 `activeSessionIdRef`/`messagesRef`/`charactersRef`/`userNameRef` 多个共享 ref 且写 `setMessages`，抽取需注入大量锚点、收益低。
- **stickers（候选）**：`sticker*` 组依赖 `stickerImages`，需核查与附件/会话守卫的耦合后再定。
- **已完成**：useScrollScrubber、useChatSearch、useChatTts。

### 阶段 C 方案修正（2026-09-27）

动手核查后发现原计划「低风险三个 hook（search/scrubber/greetings）」的前提不成立：

- **greetings 不是低风险**：`confirmGreeting` 深度依赖切换会话竞态守卫（`switchOperationRef`/`sessionVersionRef`/`abortRef`/`activeCharacterIdRef`）并重置大批跨域状态，命中「不拆竞态守卫」约定 → **暂缓**。
- **search 与 scrubber 共享滚动底座**：`scrollToMessage`/`messageOffsetsRef`/`onMessageLayout` 同时服务搜索、滚动条、引用跳转、消息删除清理；`focusedMessageId` 亦为跨功能共享状态。
- **调整**：先做最干净的 scrubber（共享底座参数注入）；后续如需抽 search，应先把「滚动 + 焦点锚点」抽成 `useMessageAnchors` 再由 search/scrubber 消费，避免单个 hook 反向拥有跨功能共享状态。

## 目标

`src/ChatScreen.js` 当前 6112 行，是全仓最大的单文件。目标是在**不改变任何行为**的前提下，按「纯函数 → 纯展示组件 → 样式 → 自包含 hook」由易到难的顺序逐步外提，降低后续改动的回归面与阅读成本。**不追求一次性拆完**，每阶段独立提交、独立可回滚。

## 现状测绘（2026-09-27）

文件内区块与行数：

| 行范围 | 内容 | 行数 | 类型 |
|---|---|---|---|
| 1–160 | import | 160 | — |
| 161–272 | 模块常量 + 8 个纯辅助函数 | 112 | 纯逻辑 |
| 273–312 | `ThinkingIndicator` | 40 | 纯展示 |
| 313–339 | `renderHighlightedText` | 27 | 纯函数（返回 JSX） |
| 340–762 | `MessageBubble`（含 2 处 `allowFullscreenVideo`） | 423 | 展示组件 |
| 763–810 | `ErrorBubble` | 48 | 纯展示 |
| 811–5151 | `ChatScreen` 组件本体 | 4341 | 有状态 |
| 5152–6112 | `createChatStyles` | 961 | 纯样式工厂 |

组件内 hooks 规模：52 `useState`、50 `useRef`、18 `useEffect`、70 `useCallback`、26 `useMemo`。

`ChatScreen` 内 render（4049–5148）含 10 个内联 `Modal`、5 个外部组件（`CharacterEditForm`/`GroupEditForm`/`GreetingPickerModal`/`DisclaimerModal`/`ScrollScrubber`）与主消息列表 `ScrollView`。

依赖方：`App.js:13` 默认导入，`App.js:391` 作为 `Tab.Screen component` 挂载。**默认导出必须保持是一个组件**（见风险 1）。

## 关键约束（动手前必读）

1. **路由组件身份**：`ChatScreen` 被 `Tab.Screen` 当路由组件挂载。默认导出一旦被包成 `React.memo(...)` 或改签名，导航可能重挂载并丢失状态。**默认导出始终是 `function ChatScreen()`**，拆分只做「内部调用外提」，不动导出形态。
2. **源码断言测试**（会因拆分而失败，须同步改）：
   - `tests/richHtml.test.mjs:22` 读取 `src/ChatScreen.js`；`allowFullscreenVideo` 必须出现 ≥2 次（现位于 `MessageBubble` 的 644/653 行），且 `viewportCardEntry`/`richHtmlViewport` 等字符串不得出现。
   - `tests/aigc.test.mjs:106` 断言 `src/ChatScreen.js` 含 `AI 生成可能有误，仅供参考`（现位于 166 常量与 4154 渲染）。
   - **规则**：把 `MessageBubble` 抽到新文件时，该测试改读新文件；把 `AI_DISCLAIMER_TEXT` 常量外提时，该断言改读新常量文件或保留一处引用。拆分 PR 必须同步更新这两处断言，否则 CI 红。
3. **惰性 require 历史坑**：`diagnostics.js`/`secretStore.js` 曾因被 `storage.js` 间接拉入纯 Node 测试路径而必须惰性加载。新增的 ChatScreen 子模块若被纯逻辑测试导入，**不得在顶层 import `react-native`**（否则该测试加载失败）。展示组件文件顶层 import RN 是正常的（会被 `.c8rc.json` 排除）。
4. **ref 延迟赋值模式**：`messageActionsRef`/`generateInlineImageRef`/`ttsRef`/`sendTextRef`/`recordTurnRef` 通过 `useEffect` 在声明之后赋值，用于规避「后声明的 const 被前面的回调引用」的 TDZ。外提 hook 时必须保留这个「声明在后、ref 暴露给前」的顺序，不能图省事把顺序调换。
5. **会话竞态守卫是横切逻辑**：`captureSessionGuard`（905）/`isSessionGuardCurrent`（910）/`activeCharacterIdRef`/`activeSessionIdRef`/`sendOperationRef`/`switchOperationRef` 被发送、切会话、迟到回复判定、落盘多处共用。**这些不拆**，留在 `ChatScreen` 顶层。
6. **落盘队列**：`saveQueueRef`/`lastSavedSnapshotRef`/`saveRetry*` 与「同会话并行写盘串行化 + 失败退避重试 + 成功才推进快照」是审查过的行为，搬迁时逐字保留，不做「顺手优化」。

## 拆分阶段（按风险从低到高，逐步提交）

### 阶段 A：纯函数与纯展示组件外提（低风险，纯搬运）

新建目录 `src/chat/`，**先只搬不依赖组件状态的顶层定义**。

| 新文件 | 搬入内容 | 原行 |
|---|---|---|
| `src/chat/chatHelpers.js` | `buildInlineImagePrompt`、`buildQuotePayload`、`getHttpStatus`、`buildErrorRawText`、`buildGreetingMessage`、`formatScrubberTime`、`messageTimestamp` | 161–272 中的纯函数 |
| `src/chat/ThinkingIndicator.js` | `ThinkingIndicator` | 273–312 |
| `src/chat/MessageBubble.js` | `renderHighlightedText` + `MessageBubble` | 313–762 |
| `src/chat/ErrorBubble.js` | `ErrorBubble` | 763–810 |

- `messageTimestamp` 在 `diary/diary.js:207` 也有一份同名本地实现（各自独立，非共享）。外提 ChatScreen 这份是安全的，不涉重命名；将来若想合并两处，另立任务，别并进本次拆分。
- `MessageBubble`/`ErrorBubble` 依赖 `createChatStyles`（阶段 B 才搬）。**阶段 A 先让它们从 `ChatScreen` 导入 styles 工厂会造成循环依赖**（ChatScreen 导入 Bubble，Bubble 又要 ChatScreen 的 styles）。**解决顺序**：把 `createChatStyles` 外提到 `src/chat/chatStyles.js` 必须先于 MessageBubble 外提，或阶段 A 先把 `createChatStyles` 一起搬到 `src/chat/chatStyles.js`。
- 常量（`USER_ID`/`ASSISTANT_ID`/`SYSTEM_ERROR_ID`/`THINKING_PLACEHOLDER`/`NEAR_BOTTOM_THRESHOLD`/`AI_DISCLAIMER_TEXT`/`QUOTE_TEXT_MAX`/`INLINE_IMAGE_PROMPT_MAX`/`NO_BODY_TEXT`/`THINKING_LEVEL_LABELS`/`THINKING_DISPLAY_LABELS`）一并进 `src/chat/chatConstants.js`，`ChatScreen` 从这里 import（`aigc` 断言随之指向新文件）。

**验收**：`npm test`（同步改 richHtml/aigc 两处断言读新文件）、`npm run lint` 无输出、`npm run test:coverage` 通过、`npx expo export --platform android` 成功。行为零变化。

### 阶段 B：样式外提（低风险，纯搬运）

| 新文件 | 内容 | 行数 |
|---|---|---|
| `src/chat/chatStyles.js` | `createChatStyles` | 961 |

- 样式工厂已被 `MessageBubble`/`ErrorBubble`/`ChatScreen` 三处使用，外提后各文件从 `chatStyles` 导入。
- 阶段 B 与阶段 A 的 `MessageBubble` 外提有顺序耦合，**建议合并为「阶段 A+B 一次做」**：先建 `chatStyles.js`，再搬 `MessageBubble`/`ErrorBubble`/`ThinkingIndicator`，最后 `ChatScreen` 瘦身。
- 完成后 `ChatScreen.js` 预计从 6112 行降到 ~4500 行。

**验收**：同上；重点人工核对三处组件的视觉与交互（真机 `npm run start`）。

### 阶段 C：自包含 hook 外提（中风险）

逐个抽成 `src/chat/use*` 自定义 hook，**每次只抽一个**，抽完即验证。

候选与依赖评估：

| hook | 对应行 | 依赖状态 | 风险 |
|---|---|---|---|
| `useChatSearch` | `searchOpen`/`searchQuery`/`activeMatchIndex`/`focusedMessageId`/`searchMatches`/`scrollToMessage`/`onMessageLayout`/`goToMatch`/`closeSearch` + effect 1910 | 依赖 `messages`、`scrollRef`、`messageOffsetsRef` | 低 |
| `useScrollScrubber` | `scrubberOpen`/`scrubberMessages`/`scrubberPreviews`/`onScrubberSeek`/`onScrubberToStart`/`onScrubberToEnd` | 依赖 `messages`、`scrollRef` | 低 |
| `useChatPersistence` | `saveQueueRef`/`lastSavedSnapshotRef`/`saveRetry*` + effect 1499 | 依赖 `messages`、`activeSessionId`、`ready` | **高**（落盘语义，逐字保留） |
| `useChatAttachments` | `attachments`/`addAttachment`/`removeAttachment`/`pickAttachmentMenu`/`pendingAttachmentUrisRef` + 相关 effect | 依赖 attachments 模块 | 中 |
| `useChatStickers` | `sticker*` 全套 + effect 3839 | 依赖 `stickerImages` | 中 |
| `useChatTts` | `ttsSettings`/`toggleBroadcast`/`broadcastMessage`/`autoBroadcastMessage`/`playbackSourceRef` + effect 3483 | 依赖 `tts` | 中 |
| `useChatGreetings` | `greetingCandidates`/`greetingPicker`/`openGreetingPicker`/`confirmGreeting`/`greetingReady` | 依赖 `cardGreetings` | 中 |
| `useInlineImage` | `inlineImageSettings`/`resolveInlineImageScene`/`generateInlineImage`/`inlineImage*Ref` + effect 3479 | 依赖 `imageGen`/`inlineImagePrompt` | 中 |

**不建议抽**：发送主链路（`requestReply`/`requestGroupReply`/`performSendMessage`/`regenerateMessage`/`editUserMessage`）与 `recordTurn`/affinity —— 它们与竞态守卫、落盘、摘要失效强耦合，抽取收益低、风险最高，留待后续单独评估。

**验收**：每个 hook 抽完跑全套门禁 + 真机验证该功能域（搜索定位、scrubber 拖动、发送/重发、附件、表情、播报、开场白、配图）。

### 阶段 D：render 子树外提（中风险，收益最大但最难）

把 render（4049–5148）中体量大的块抽成展示组件：

| 组件 | 大致行 | 说明 |
|---|---|---|
| 顶栏（选择态 + 角色名 + 新建/播报/更多） | 4055–4152 | 回调多，纯展示 |
| 搜索栏 | 4156–4200 | 与 `useChatSearch` 配套 |
| 输入区（quoteBar + attachmentBar + TextInput + 发送/停止） | 4327–4475 | 回调多 |
| 10 个 Modal | 4477–5137 | 各自独立，逐个搬 |

- Modal 逐个搬时，**注意 `Modal` 的 `visible` 与回调仍在 `ChatScreen`**，抽出的组件收 props。
- `CharacterEditForm`/`GroupEditForm`/`GreetingPickerModal`/`DisclaimerModal`/`ScrollScrubber` 已是外部组件，无需处理。

**验收**：真机逐项走查所有 Modal 开关、输入、发送、搜索、多选、滚轮。

## 分阶段提交计划

1. **PR1（阶段 A+B）**：新建 `src/chat/{chatConstants,chatHelpers,chatStyles,ThinkingIndicator,MessageBubble,ErrorBubble}.js`；`ChatScreen.js` 瘦身至 ~4500 行；同步改 `richHtml.test.mjs`/`aigc.test.mjs` 的源码断言。纯搬运，零行为变化。
2. **PR2（阶段 C，分批）**：每个 hook 一个提交，共 8 个左右。低风险三个（search/scrubber/greetings）优先。
3. **PR3（阶段 D）**：render 子树，按「Modal → 顶栏 → 输入区 → 搜索栏」顺序。

每步提交信息：`refactor: 从 ChatScreen 抽出 XXX（无行为变化）`。

## 验证基线（每阶段必跑）

```bash
npm test              # 单元与回归（当前 437）
npm run lint          # 必须无输出
npm run test:coverage # c8 门禁（当前行覆盖 81%）
npx expo export --platform android  # Metro 打包
npm run start         # 真机手测受影响功能域
```

## 风险与对策汇总

| 风险 | 对策 |
|---|---|
| 路由组件被重挂载 | 默认导出形态不变，只外提内部调用 |
| 源码断言测试失效 | PR1 同步改 `richHtml`/`aigc` 断言指向新文件 |
| 循环依赖（styles ↔ Bubble） | styles 先外提，再搬 Bubble；或同一次提交 |
| TDZ（ref 延迟赋值） | 保留「声明在后、ref 暴露给前」的顺序 |
| 落盘/竞态语义被改 | 阶段 C 的高风险 hook 逐字搬运，不做顺手优化；每个 hook 单独提交 |
| 纯逻辑测试加载 RN | 新子模块若被纯 Node 测试导入，不得顶层 import `react-native` |
| `exhaustive-deps` 未启用 | 搬迁回调时依赖数组原样保留，不「修正」 |

## 明确不做

- 不改 `ChatScreen` 的对外行为、UI、文案。
- 不拆会话竞态守卫、发送主链路、`recordTurn`/affinity（留待单独评估）。
- 不启用 `exhaustive-deps`（存量 37 处刻意省略依赖，需逐条判断）。
- 不合并 storage 拆分（P2 第 9 项）与 schemaVersion（P2 第 10 项），那是独立工作项。
