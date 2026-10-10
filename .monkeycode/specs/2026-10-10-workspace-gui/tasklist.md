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

- [ ] P1-1 宽度判定纯函数（`宽 >= N` 才允许两栏）+ 持久化偏好。
- [ ] P1-2 `WorkspaceScreen` 宽屏布局：对话常驻 + 右侧一个可停靠面板（文件/终端/GitHub 三选一）+ 拖动分隔条。
- [ ] P1-3 窄屏行为**逐字不变**（回归测试钉死）。

## P2 检索与导航

- [ ] P2-1 聊天消息搜索（面板内搜索条 + 命中跳转）。
- [ ] P2-2 会话历史搜索 + 排序。
- [ ] P2-3 本地文件搜索（照抄 `GithubPanel.js:1262-1281` 的形状）。

## P3 扩展点 GUI 补齐

- [ ] P3-1 子代理档案：计数 + 逐条列表（与技能行对齐）。
- [ ] P3-2 技能：从「只有数量」升级为逐条列表。
- [ ] P3-3 MCP：工作区里给一条指向主设置页的入口。
- [ ] P3-4 会话事件流只读视图（DSH `trajectory` 的轻量对位）。

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
- [ ] P4-4 确认类 `Alert.alert` 逐步换面板内确认条（分批，先做破坏性操作）。

## P5 手势与极简键盘（低优先）

- [ ] P5-1 移动端手势：面板间横滑切换 / 列表滑动操作 / 长按菜单。
- [ ] P5-2 平板 + 外接键盘极小子集（发送 / 停止 / 切换面板）。

## 明确不做（沿用既有裁决）

LSP 集成（物理不可行）｜53 包插件化 UI｜完整键位录制系统｜Electron 内嵌浏览器｜Plan DAG｜
工具结果向量检索｜上下文老化淘汰｜重做 MCP 泛化 / `run_subagent` / SKILL.md 基础格式。
