# 手机 ↔ 桌面 功能对齐矩阵

> 这份表是「有没有功能差距」的**可核对底稿**，不是宣传材料。
> 生成方式：先把手机端全部用户可达功能面列成清单（从 `App.js` 的 Tab.Screen 出发，
> 逐个 tab 追到每个能打开的 Modal / 子页），再把桌面端同样列一份，然后逐项对照，
> 差异逐条核实到文件级（不是靠命名猜）。
>
> 状态口径只有五种，**不允许出现「大概齐」**：
> - `已对齐` —— 桌面有等价功能面，且**判定/数据来自共享层**（不是重写一份）。
> - `平台差异` —— 桌面有等价功能面，但交互形态因平台不同（如相机→文件选择）。
> - `不适用` —— 依赖手机独有硬件/系统能力，桌面不存在等价物（写明是哪一项）。
> - `Agent 排除` —— 属 agent 能力，按本次任务范围排除。
> - `待补` —— 确有差距且可移植，尚未实现（必须写清卡在哪）。
>
> 维护规则：两边任何一侧新增功能面时，先改这张表再改代码；`待补` 项清零前，
> 不能声称「没有功能差距」。

## 0. 统计

| 区域 | 手机功能面 | 已对齐 | 平台差异 | 不适用 | Agent 排除 | 待补 |
|---|---|---|---|---|---|
| 全局 | 10 | 7 | 1 | 2 | 0 | 0 |
| 聊天 | 32 | 25 | 4 | 0 | 3 | 0 |
| 记忆 | 10 | 9 | 1 | 0 | 0 | 0 |
| 角色 | 22 | 19 | 2 | 0 | 0 | 1 |
| 扩展 | 42 | 27 | 3 | 5 | 3 | 4 |
| 设置 | 33 | 28 | 1 | 0 | 4 | 0 |
| **合计** | **149** | **115** | **12** | **7** | **10** | **5** |

> 手机上同一个弹层可能从多个入口进（免责声明、教程、预设、转写、本地模型、导入扩展），
> 上表按「入口 × 区域」各计一次，与手机端排查时看到的入口数一致。

## 1. 全局（10）

| 手机功能面 | 手机实现 | 桌面实现 | 状态 |
|---|---|---|---|
| 免责声明弹窗 | `onboarding/disclaimer.js` | `settings/DisclaimerDialog.jsx` | 已对齐 |
| 新手引导 | `OnboardingModal.js` | `settings/TutorialDialog.jsx` | 已对齐 |
| 应用内公告 / 更新说明 | `announcements/AnnouncementStartup.js` + `AnnouncementModal.js` | `settings/AnnouncementDialog.jsx`（启动静默拉取 + 关于卡只读缓存） | 已对齐（S36 补） |
| 崩溃兜底页 | `App.js:89-138` | `provider/DesktopApp.jsx` 启动错误态 | 已对齐 |
| 应用锁（生物识别） | `security/SecurityGate.js` + `biometrics.js` | 无 | 不适用：手机唯一解锁路径是指纹/面容（`expo-local-authentication`）；桌面无等价物，强行提供会锁死用户 |
| 单角色锁 PIN | `security/SecurityGate.js:375` + `PinModal.js` | `settings/RoleLockGate.jsx` + `CharacterLockCard.jsx` | 已对齐 |
| 安全状态未知拦截层 | `security/SecurityGate.js:314` | `RoleLockGate`（读坏时**放行**，与手机相反） | 平台差异：桌面无生物识别这一把「备用钥匙」，fail-closed 会把用户永久挡在外面；这是刻意反着做并在代码里注明 |
| 主动消息通知跳转桥 | `App.js:384` ProactiveMessageBridge | `electron/ipc/notify.js`（`notify:click` 回传）+ `DesktopApp` 导航 | 已对齐（S37 补；切角色→切会话→定位消息） |
| 悬浮窗 deep link 跳转 | `App.js:483-506` | 无 | 不适用：`easychat2://screen-watch` 依赖手机悬浮窗 |
| 角色编辑未保存离页确认 | `App.js:632-663` + `character/characterEditGuard.js` | `provider/DesktopApp.jsx`（`shouldConfirmTabLeave`） | 已对齐（S37 补；三动作齐全，保存失败不离开） |

## 2. 聊天（32）

| 手机功能面 | 手机实现 | 桌面实现 | 状态 |
|---|---|---|---|
| 角色 / 群聊切换器 | `chat/SwitcherModal.js` | `chat/SwitcherPanel.jsx` | 已对齐 |
| 「更多」菜单 | `chat/MoreMenuModal.js` + `moreMenuItems.js` | `chat/ChatMoreMenu.jsx` | 已对齐 |
| 消息长按操作 | `chat/MessageBubble.js:571-592` | `render/MessageActionsMenu.jsx` | 已对齐 |
| 消息多选批量 | `ChatTopBar.js` + `ChatScreen.js:2606` | `chat/MessageSelectionBar.jsx` + `useMessageSelection.js` | 已对齐 |
| 分支分叉列表 | `chat/BranchForkRow.js` + `BranchSwitcher.js` | `chat/BranchForkRow.jsx` + `BranchSwitcher.jsx` | 已对齐 |
| 滚动定位器 | `chat/ScrollScrubber.js` | `chat/ScrollScrubber.jsx` | 已对齐 |
| 聊天内搜索条 | `chat/ChatSearchBar.js` | `chat/ChatSearchBar.jsx` | 已对齐 |
| 表情包面板 | `chat/StickerPanelModal.js` | `stickers/StickerPanel.jsx` | 已对齐 |
| 表情包命名 | `chat/StickerNamePromptModal.js` | `stickers/StickerNameDialog.jsx` | 已对齐 |
| 附件菜单 | `chat/AttachmentMenuModal.js` | `attachments/useDesktopAttachments.js` + `ChatComposer` | 平台差异：拍照/相册 → 原生文件对话框；其余（文本/图片/视频）同能力 |
| 全屏输入 | `chat/FullScreenInputModal.js` | `chat/FullScreenInput.jsx` | 已对齐 |
| 提及成员 | `chat/MentionPickerModal.js` | `group/MentionPicker.jsx` | 已对齐 |
| 选择文本 | `chat/SelectionTextModal.js` | `MessageActionsMenu`（选择文本复制原文） | 已对齐 |
| 记忆总结面板 | `chat/MemorySummarySheet.js` | `chat/MemorySummaryPanel.jsx` | 已对齐 |
| 本会话统计 | `chat/SessionStatsModal.js` | `chat/SessionStatsPanel.jsx` | 已对齐 |
| 导出对话 | `chat/ConversationExportModal.js` | `chat/ConversationExportPanel.jsx` + `shareCardImage.js` | 平台差异：系统分享 → 「另存为」写盘 |
| 从对话生成角色卡 | `chat/ConversationCardModal.js` | `chat/ConversationCardPanel.jsx` | 已对齐 |
| 聊天设置（压缩/占用） | `chat/ChatSettingsModal.js` + `CompactFocusModal.js` | `chat/ContextUsageBar.jsx` + `CompactFocusDialog.jsx` | 已对齐 |
| 语音设置（播报/模式/转写入口） | `chat/VoiceSettingsModal.js` | `chat/VoiceSettingsPanel.jsx`（更多→语音设置） | 已对齐（S37 补；播报/全语音模式/转写入口三合一） |
| 语音转写配置 | `TranscriptionPanel.js` | `settings/TranscriptionCard.jsx` | 已对齐（S36 补；入口在设置→全局配置） |
| 角色编辑（聊天内） | `CharacterEditForm.js` | `character/CharacterEditScreen.jsx` | 已对齐 |
| 群聊编辑（聊天内） | `GroupEditForm.js` | `group/GroupSettingsPanel.jsx` | 已对齐 |
| 开场白选择 | `GreetingPickerModal.js` | `chat/GreetingPicker.jsx` | 已对齐 |
| 公告（聊天菜单） | `onboarding/disclaimer.js` | `settings/DisclaimerDialog.jsx`（从设置进） | 平台差异：桌面不从聊天菜单重复开一份，入口归到设置→关于 |
| 模型切换 | `chat/ModelPanelModal.js` | `chat/ModelThinkingPanels.jsx`（ModelPanel） | 已对齐 |
| 思考设置 | `chat/ThinkingPanelModal.js` | `chat/ModelThinkingPanels.jsx`（ThinkingPanel） | 已对齐 |
| 运行中角色条 | `chat/RunningRunsBar.js` | `chat/RunningNoticeBar.jsx` | 已对齐 |
| 图片消息操作（保存/存表情/引用/删除） | `ChatScreen.js:2247-2274` | `MessageActionsMenu` + `MediaMessage.jsx` | 平台差异：不支持「保存到相册」；存表情/引用/删除已对齐（删除项 S36 前是死条目，已修） |
| 本地模型中心（聊天入口） | `LocalModelPanel.js` | 无 | Agent 排除 |
| 工具执行确认 | `chat/toolApproval.js` | 无 | Agent 排除 |
| ask_user 选择询问 | `chat/askUserPrompt.js` | 无 | Agent 排除 |
| 应用内公告启动弹窗（聊天侧复用） | `AnnouncementStartup.js` | `AnnouncementDialog` | 已对齐（S36 补） |

## 3. 记忆（10）

| 手机功能面 | 手机实现 | 桌面实现 | 状态 |
|---|---|---|---|
| 记忆列表与筛选 | `MemoryScreen.js` + `memoryBuckets.js` | `memory/MemoryListScreen.jsx` | 已对齐 |
| 多选批量删除 | `MemoryScreen.js:319-387` | `MemoryListScreen` 编辑态多选 | 已对齐 |
| 会话长按操作 | `MemoryScreen.js:262-283` | `MemoryListScreen`（重命名/置顶/克隆/删除） | 已对齐 |
| 全库搜索 | `SearchScreen.js` + `sessionMessages/search.js` | `memory/GlobalSearchPanel.jsx` | 已对齐 |
| 记忆体检 | `memory/MemoryCheckupModal.js` | `memory/MemoryCheckupPanel.jsx` | 已对齐 |
| 丢失会话恢复 | `SessionRecoveryModal.js` | `memory/OrphanRecoveryPanel.jsx` | 已对齐 |
| 屏幕对话管理 | `MemoryScreen.js:455-468` | `memory/ScreenWatchThreadsPanel.jsx` | 已对齐 |
| 记忆页 ⋯ 菜单 | `MemoryScreen.js:134-154` | `MemoryListScreen`（体检/恢复/搜索直出） | 平台差异：桌面没有折叠菜单，三个入口直接平铺（点击路径更短） |
| 记忆教学 | `MemoryScreen.js:643` + `books/ChapterModal.js` | `settings/TutorialDialog.jsx`（记忆页「教程」） | 已对齐 |
| 记忆溯源 | `memory/MemoryProvenanceModal.js` | `memory/MemoryProvenancePanel.jsx` | 已对齐 |

## 4. 角色（22）

| 手机功能面 | 手机实现 | 桌面实现 | 状态 |
|---|---|---|---|
| 角色库 | `character/CharacterLibraryScreen.js` | `character/CharacterLibraryScreen.jsx` | 已对齐 |
| 新建角色 | `CharacterLibraryScreen.js:401` | 同左（+「导入/新建」） | 已对齐 |
| 创建群聊 | `character/GroupCreateModal.js` | `group/GroupCreatePanel.jsx` | 已对齐 |
| 多选批量删除 | `CharacterLibraryScreen.js:228` | 无 | 待补：桌面只有逐卡删除（走同一条 `runCharacterDelete` 编排），没有多选态 |
| 角色详情 | `character/CharacterDetailScreen.js` | `character/CharacterEditScreen.jsx` | 平台差异：手机是四段切换（人设/世界书/正则/预设），桌面是单页滚动分区 |
| 人设段 | `CharacterDetailScreen.js:783` | `CharacterEditScreen.jsx:432-540` | 已对齐 |
| 世界书段 / 条目编辑 | `CharacterDetailScreen.js:1198` + `CharacterEntryModals.js` | `CharacterEditScreen.jsx:129-248` | 已对齐 |
| 正则段 / 脚本编辑 | `CharacterDetailScreen.js:1232` + `CharacterEntryModals.js:89` | `CharacterEditScreen.jsx:250-356` | 已对齐 |
| 角色预设 | `CharacterDetailScreen.js:1268` + `PresetPanel.js` | `CharacterEditScreen.jsx:594-685` | 已对齐 |
| 全局预设 | `PresetPanel.js:359` | `settings/GlobalPresetCard.jsx` | 已对齐 |
| 导入角色卡（文件） | `useCardTransfer.js` | `backup/services.js` + `DesktopApp` | 平台差异：SAF → 原生文件对话框 |
| 剪贴板导入 | `useCardTransfer.js` | `character/CharacterShareDialog.jsx` | 已对齐 |
| 开场白导入选择 | `GreetingPickerModal.js` | `chat/GreetingPicker.jsx` | 已对齐 |
| 角色卡分享（二维码/分享码） | `character/CardShareModal.js` + `share/cardShare.js` | `character/CharacterShareDialog.jsx` + `CardSharePanel.jsx` | 已对齐 |
| 角色卡导出 | `character/cardExporter.js` | `backup/services.js`（exportCharacterCard） | 已对齐 |
| 转入制卡工坊 | `CharacterDetailScreen.js:608-637` | `CharacterEditScreen.jsx`（导入到制卡按钮 → `draftFromCharacter`） | 已对齐（S37 补；导航到扩展→制卡） |
| 角色覆盖设置（聊天/OCR/TTS/转写） | `CharacterOverridesSection.js` | `character/CharacterOverrideCard.jsx`（四项齐全） | 已对齐（S37 补；TTS provider/音色 + 转写配置） |
| 草稿恢复提示 | `CharacterDetailScreen.js:372-380` | `character/useDesktopCharacterDraft.js` | 已对齐（S37 补；800ms 防抖 + 读即取走） |
| 导入进度遮罩 | `CharacterEntryModals.js:37-50` | `character/ImportOverlay.jsx` | 已对齐（S37 补；读取/保存两阶段，大卡另带体积） |
| 角色卡教程 | `CharacterDetailScreen.js:928` | `settings/TutorialDialog.jsx` | 已对齐 |
| 语音显示模式 | `CharacterDetailScreen` | `CharacterEditScreen.jsx`（语音模式三选） | 已对齐 |
| 原始卡只读资料 / AIGC 标识 | `CharacterDetailScreen` | `CharacterEditScreen.jsx`（原始卡资料区） | 已对齐 |

## 5. 扩展（42）

| 手机功能面 | 手机实现 | 桌面实现 | 状态 |
|---|---|---|---|
| 扩展首页 | `extension/ExtensionHome.js` | `extension/ExtensionScreen.jsx` | 已对齐 |
| 制卡工坊（问答流） | `CardForgeScreen.js` | `extension/screens/CardForgeScreen.jsx` | 已对齐 |
| 制卡编辑器（全字段） | `CardForgeEditor.js:557` | `ForgeAdvancedPanels.jsx` + 字段区 | 已对齐 |
| 制卡预览 / 模拟对话 | `CardPreviewModal.js` | `forgeAssist.jsx:80-178` | 已对齐 |
| 制卡 AI 补写 | `CardForgeEditor.js:953-1014` | `forgeAssist.jsx:25-78` | 已对齐 |
| 制卡头像/背景 AI 生成 | `CardForgeEditor.js:1016-1060` | 无 | 待补：桌面有「图片制卡」（以图生成整卡），但没有对单张头像/背景单独重生成 |
| 图像生成 | `ImageGenScreen.js` | `extension/screens/ImageGenScreen.jsx` | 已对齐 |
| 图像服务/模型选择 | `ImageGenScreen.js:718-761` | `ImageGenScreen.jsx`（内联选择） | 已对齐 |
| 图像服务设置（baseUrl/key/额外参数） | `imageGen/ProviderSettingsModal.js` | `ImageGenScreen.jsx`（内联表单） | 已对齐 |
| 图像生成教程 | `ImageGenScreen.js:588` | `settings/TutorialDialog.jsx` | 已对齐 |
| 动态 | `MomentsView.js` | `extension/screens/MomentsScreen.jsx` | 已对齐 |
| 动态教程 | `MomentsView.js:483` | `settings/TutorialDialog.jsx` | 已对齐 |
| 音乐库 | `music/MusicScreen.js` | `extension/screens/MusicScreen.jsx` | 已对齐 |
| 音乐播放控制（进度/倍速/上下首/15秒/播放模式） | `MusicScreen.js:120`+ | `MusicScreen.jsx`（仅播放/暂停） | 待补：桌面播放器只做了播放/暂停，进度拖动、倍速、上一首/下一首、前后 15 秒、播放模式均未接 |
| 音乐陪伴设置（切片/采样率/自动评论） | `MusicScreen.js:534` | `RoleCommentPanel.jsx`（手动生成） | 待补：桌面只能手动让角色评论，没有切片与自动评论链 |
| 歌单命名 / 选择 | `ui/CollectionModals.js` | `MusicPlaylistPanel.jsx` | 已对齐 |
| 书籍库 | `books/BookScreen.js` | `extension/screens/BooksScreen.jsx` | 已对齐 |
| DOCX 导入 | `books/decodeText.js`（手机走原生/第三方库） | 明确拒绝（`desktop.books.docxUnsupported`） | 待补：桌面只解析 txt/md；DOCX 需 zip+XML 解析 |
| 阅读器（分章/进度） | `books/BookReaderView.js` | `extension/screens/BookReader.jsx` | 已对齐 |
| 阅读器字号增减 | `BookReaderView.js:616-619` | `BookReader.jsx`（A-/A+，共享 `books/readerFont.js`） | 已对齐（S36 补） |
| 阅读器翻页方式（点击/滑动/仿真翻书） | `BookReaderView` + `readerSettings.js` | 无 | 不适用：依赖 RN 文本测量做逐行分页；桌面是滚动阅读，翻页手势无对应物 |
| 章节目录 | `BookChaptersModal.js` | `BookReader.jsx`（章节下拉） | 已对齐 |
| 陪读评论 | `BookCommentsModal.js` | `RoleCommentPanel.jsx`（kind=books） | 平台差异：手机按页/按章批量生成，桌面按当前章手动生成 |
| 书架命名 / 选择 | `ui/CollectionModals.js` | `BookshelfPanel.jsx` | 已对齐 |
| 屏幕注视 | `screenWatch/ScreenWatchScreen.js` | `extension/screens/ScreenWatchScreen.jsx` | 已对齐（截本应用画面） |
| 悬浮窗控制 | `screenWatch/ScreenWatchScreen.js:442-478` | 无 | 不适用：SYSTEM_ALERT_WINDOW + MediaProjection |
| 无障碍服务卡 | `screenWatch/AccessibilityCard.js` | 无 | 不适用：Android 无障碍服务 |
| 画面识别来源卡（主模型直看 / OCR 先转文字） | `screenWatch/FrameRecognitionCard.js` | 设置→图片识别（OCR 开关） | 平台差异：能力存在但不在该页就地切换 |
| 悬浮球头像卡 | `screenWatch/AvatarCard.js` | 无 | 不适用：悬浮窗子功能 |
| 主动消息 | `ProactivePanel.js:148` | `extension/screens/ProactiveScreen.jsx` | 平台差异：桌面只在窗口开着时到点触发（无后台服务） |
| 主动消息风格/时段编辑 | `proactive/ProactiveStyleEditor.js` | `ProactiveScreen.jsx`（风格权重表） | 已对齐 |
| 主动消息权限区（通知/精确闹钟/电池/自启动） | `ProactivePanel.js:702-770` | 无 | 不适用：Android 系统权限 |
| 定时任务 | `extension/AgentTaskPanel.js` | 无 | Agent 排除（Headless JS + agent 指令） |
| 作息 | `extension/SchedulePanel.js` | `extension/screens/ScheduleScreen.jsx` | 已对齐 |
| 插件管理（已装列表/卸载/市场/槽位） | `extension/WorkspacePluginsPanel.js` | 无 | Agent 排除（插件运行时：外部 JS + 原生界面注入） |
| 导入扩展（GitHub/npm/粘贴） | `extension/ExtensionImportSheet.js` | 无 | Agent 排除（同上） |
| 日记 | `DiaryPanel.js:34` | `extension/screens/DiaryScreen.jsx` | 已对齐 |
| 世界地图（40×40 网格/房屋） | `MapPanel.js:47` | `extension/screens/MapScreen.jsx` | 已对齐 |
| 真实地图视图（手写坐标/位置列表/对外分享） | `worldMap/RealMapView.js` | `extension/screens/RealMapScreen.jsx`（共享 `buildRealMapHtml`） | 已对齐（S37 补；网格/真实两视图切换） |
| 游戏中心 | `extension/GamesView.js` | `extension/screens/GamesScreen.jsx` | 已对齐 |
| 网页游戏详情 | `GamesView.js:84-124` | `GamesScreen.jsx`（iframe srcDoc + sandbox） | 已对齐 |
| 今日老婆/老公 | `games/DailyWifeView.js` | `extension/screens/DailyWifeScreen.jsx` | 已对齐（S36 补，原先标成「需要角色库面板」是误判） |

## 6. 设置（33）

| 手机功能面 | 手机实现 | 桌面实现 | 状态 |
|---|---|---|---|
| 设置搜索 | `settings/searchIndex.js` + `SettingsScreen.js:1624` | `settings/desktopSearchIndex.js` + 搜索框 | 已对齐（S36 补；分区做了映射） |
| API 配置 | `settings/sections/ApiSection.js` | `settings/ApiCard.jsx` | 已对齐 |
| 厂商预设选择 | `SettingsScreen.js:2007` | `ApiCard.jsx`（供应商预设） | 已对齐 |
| 模型能力编辑 | `SettingsScreen.js:2096-2334` | `ApiCard.jsx`（逐模型能力位） | 已对齐 |
| 生成参数 | `settings/SamplingCard.js` | `settings/SamplingCard.jsx` | 已对齐 |
| 用户人设 | `settings/sections/PersonaSection.js` | `settings/PersonaCard.jsx` | 已对齐 |
| 外观（主题/字号） | `settings/sections/AppearanceSection.js` | `settings/AppearanceCard.jsx` | 已对齐 |
| 自定义配色 | `settings/CustomThemeModal.js` | `settings/CustomThemeCard.jsx` | 已对齐（S36 补，含实时预览） |
| 对话体验 | `settings/sections/ExperienceSection.js` | `settings/ChatOptionsCard.jsx` | 已对齐 |
| 自动配图 + 表情包 | `settings/sections/ExtensionsSection.js` | `settings/InlineImageCard.jsx` | 已对齐 |
| 图片识别（OCR） | `ExtensionsSection.js` | `settings/ImageRecognitionCard.jsx` | 已对齐 |
| 联网搜索插件 | `PluginPanel.js` | `extension/screens/PluginScreen.jsx` | 已对齐 |
| 语音播报 | `TtsPanel.js` | `settings/TtsCard.jsx` | 已对齐（S36 补；云端引擎播放器也补齐） |
| 语音转文字 | `TranscriptionPanel.js` | `settings/TranscriptionCard.jsx` | 已对齐（S36 补） |
| 向量记忆（含记忆总结设置） | `settings/sections/VectorSection.js` | `settings/MemorySettingsCard.jsx:69-372` | 已对齐 |
| 记忆溯源 / 冲突处置 | `memory/MemoryProvenanceModal.js` | `memory/MemoryProvenancePanel.jsx` + `MemoryConflictPanel.jsx` | 已对齐 |
| 隐私与安全（单角色锁） | `settings/sections/SecuritySection.js` | `settings/CharacterLockCard.jsx` | 已对齐 |
| 批量上锁选人 | `settings/sections/BulkLockPickerModal.js` | `settings/CharacterLockCard.jsx`（多选态 + `setCharacterLocks`） | 已对齐（S37 补；手机两步弹层，桌面密码在卡内所以合并为「勾选→应用」） |
| 设置/验证密码 | `security/PinModal.js` | `CharacterLockCard.jsx`（内置 PIN 设置） | 已对齐 |
| 自动备份 | `settings/sections/AutoBackupSection.js` | `settings/AutoBackupCard.jsx` | 平台差异：目标固定为应用私有目录（无长期目录句柄） |
| 界面语言 | `SettingsScreen.js:1897-1933` | `settings/AppearanceCard.jsx` | 已对齐 |
| 关于 | `settings/sections/AboutSection.js` | `SettingsScreen.jsx` AboutCard | 已对齐 |
| 更新说明 | `announcements/AnnouncementModal.js` | `settings/AnnouncementDialog.jsx` | 已对齐（S36 补） |
| 教程 | `TutorialModal.js` + `books/ChapterModal.js` | `settings/TutorialDialog.jsx` | 已对齐 |
| 免责声明 | `onboarding/disclaimer.js` | `settings/DisclaimerDialog.jsx` | 已对齐 |
| 诊断日志 | `DiagnosticsModal.js` | `settings/DiagnosticsCard.jsx` | 已对齐 |
| 备份与恢复 | `BackupPanel.js` | `backup/BackupPanel.jsx` | 已对齐 |
| 全局预设 | `PresetPanel.js` | `settings/GlobalPresetCard.jsx` | 已对齐 |
| 位置（手写坐标 + 分享/感知开关） | `worldMap/RealMapView.js` + `storage/location.js` | `settings/LocationCard.jsx` | 已对齐 |
| 工作区（文件/终端/GitHub/历史） | `workspace/screen/WorkspaceScreen.js` | 无 | Agent 排除 |
| GitHub 连接 | `settings/sections/GithubSection.js` | 无 | Agent 排除 |
| MCP 服务器 / 内置 MCP Server | `settings/sections/McpServersSection.js` + `McpServerCard.js` | 无 | Agent 排除 |
| 本地模型中心 | `LocalModelPanel.js` | 无 | Agent 排除 |

## 7. 仍然存在的真实差距（待补 5 项）

按「补起来的成本」排序。**这 5 项清零之前，不能说没有功能差距。**

**都需要新写一块逻辑（成本中）**
1. 角色库多选批量删除（有逐卡删除编排，缺选择态）
2. 音乐播放完整控制（进度拖动/倍速/上一首/下一首/前后 15 秒/播放模式）
3. 音乐陪伴的切片与自动评论（桌面目前只能手动生成短评）
4. DOCX 导入（zip + XML 解析；当前明确拒绝并给出替代路径）
5. 制卡单字段头像/背景重生成（当前只有「图片制卡」整卡生成）

### 明确不做的（已在表中标为不适用 / Agent 排除，不属待补）

- 阅读器翻页手势（RN 文本测量专属，桌面是滚动阅读）
- 屏幕注视的悬浮窗 / 无障碍 / 悬浮球（Android 系统能力）
- 主动消息的系统权限区（通知/精确闹钟/电池优化/自启动）
- 应用锁（生物识别是手机唯一解锁路径，桌面提供了会锁死用户）
- 定时任务 / 插件运行时 / 工作区 / MCP / 本地模型（Agent 能力，按范围排除）
