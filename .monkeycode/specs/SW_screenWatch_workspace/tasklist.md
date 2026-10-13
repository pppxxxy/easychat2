# SW：一起看屏幕·工作区版（任务书 SW1-SW3 落地记录）

> 依据：origin/main 6e093e0 的源码核验（screenWatch 全套 / WorkspaceScreen DOMAIN_PANELS /
> workspace agent 管线 tools.js + agentToolSetup）。用户额外要求：**悬浮窗内做 mini 聊天**
> （原任务书建议「不自嵌聊天 UI」，用户明确否决：要随手点开就下命令、说完收起）。

## 交付状态

| 期 | 内容 | 状态 |
|---|---|---|
| SW1 | 线程分 scope + 工作区左栏「看屏幕」面板 | ✅ 已完成（995798d6） |
| SW2 | 会话接工作区 agent 管线 + 命令确认 | ✅ 已完成（4fadadee） |
| SW3 | 悬浮窗 mini 聊天（原生） | ✅ 已完成（1e25e9f9 + d7c7292c 自查修 4 bug） |

## SW1：线程分类 + 左栏入口（纯 JS）

- `screenWatch/threads.js`：线程加 `scope`（'chat' 默认 | 'workspace'）。
  · `normalizeThreadScope`：非法/缺失 → 'chat'（旧数据无字段归聊天类，不丢线程）。
  · `getOrCreateActiveThread(characterId, name, now, scope)`：**续用判据同时匹配
    characterId 与 scope**——否则工作区看屏幕会接走聊天角色的线程（上下文串场）。
    签名向后兼容（旧调用点只传前三个参数，行为逐字不变）。
- `memory/memoryBuckets.js`：`groupScreenThreadsByScope` 纯函数（记忆界面按 scope 分组）。
- `workspace/screen/ScreenWatchPanel.js`（新）：左栏「看屏幕」领域面板——悬浮窗三态
  （支持性/权限/运行中）、开启关闭按钮、工作区线程列表。
- `WorkspaceScreen`：DOMAIN_KEYS 加 watch（放 history 与 settings 之间，同属「回看」性质）。
- 测试：`tests/screenWatchScope.test.mjs` 7 条（含续用隔离真行为测试 + 旧数据兼容）。

## SW2：接工作区 agent 管线（两条管线汇合）

**做法：复用既有 `headlessAgent.js`（工作区 agent 回合执行器），不另造一条。**

- `workspace/headlessAgent.js` 补三件事：
  · `confirm` 钩子（破坏性操作前确认；**不传 = 需要确认的工具被拒**，沿用 registry 纪律）；
  · `permissionRules` 透传（hooks.json + 用户存储合并入口——不接会让写工具上的手写
    deny 变成死键，P0-2 同款问题）；
  · `images` 多模态，走 `buildWorkspaceAgentMessages` 同一构造（避免两处格式漂移）。
- `screenWatch/workspaceWatchTurn.js`（新，纯逻辑 + 依赖注入）：回合编排——scope 分流、
  线程历史、本轮条目、失败文案。**不静态 import threads.js**（拉 expo 原生依赖，
  Node 测试进不来），role 字面量由测试与 threads.js 对齐。
- `ScreenWatchPanel`：加指令区（只读/可改模式 chips、输入、发送/停止、回复卡、
  「正在调用 X」）；确认走 `approveToolCall`，权限规则经 `storeRef` 读真实 store。
- 测试：`tests/workspaceWatchTurn.test.mjs` 13 条。

**自查修掉的真问题**：
1. `buildScreenWatchAgentHistory` 的 `limit=0` —— `slice(-0)` 等于 `slice(0)` 会返回
   **全部**历史（语义应是「不要历史」）；显式挡 0。
2. 权限规则最初漏接 → 写工具上的手写 deny 会变死键。
3. 面板最初用 `readHookPermissionRules(null, ...)` → 空 store 直接返回 `[]`（等于没规则）。

## SW3：悬浮窗 mini 聊天（原生）

**架构定死：原生只做嘴和眼**——LLM/工具/确认全在 JS 后台，原生只画结果。

- `OverlayService.kt`：展开态 = 标题行（含 scope 切换「工作区⇄聊天」）+ 消息区
  （ScrollView + 动态 TextView，上限 50 条）+ 输入行（EditText + 发送）。
- `ScreenOverlayModule.kt`：新增 `pushChatMessage` / `setImeInset`。
- JS：`overlayEvents` 加 `EVENT_CHAT_SEND` 与三个纯函数；`overlay.js` 加推送/inset/订阅
  （老构建安全降级）；`ScreenWatchScreen` 接监听按 scope 分流。
- 测试：`tests/screenOverlayChat.test.mjs` 11 条（纯逻辑 + Kotlin 静态契约）。

**悬浮窗场景的确认策略（如实收窄）**：不弹全屏 Alert（会盖住用户正在看的画面），
破坏性操作一律拒绝（`confirm: async () => false`）；想动手请到 App 面板（那里有确认卡）。

### ⚠️ 本机无法编译验证（重要）

本机**无 Android SDK / Java**（仓库 AGENTS.md 已记载该约束），Kotlin 改动只能靠
静态契约测试 + 人工审查兜底。逐行复查后修掉 4 个会在真机直接坏掉的 bug（d7c7292c）：

1. **`FLAG_ALT_FOCUSABLE_IM` 语义用反（最严重）**：它是**反转**语义——窗口可获焦点时
   置上它 = 宣告「不需要输入法」= **挡住 IME**。原写法「聚焦时置上」正好导致键盘弹不出来。
   改为聚焦时同时清掉 NOT_FOCUSABLE 与 ALT_FOCUSABLE_IM。
2. **`baseY` 用 0 当哨兵**：拖到顶部时 y 合法值就是 0，复位错位；拖拽后基准也不失效。
   改为可空 + 拖拽时清空。
3. **拖拽挂 rootView 抢走消息区滚动**：父级 OnTouchListener 先于子 View 拿到 touch。
   改为挂非滚动区（收起态挂球、展开态挂标题行）。
4. **收起态悬挂引用 + 消息丢失**：`showCollapsed` 摘除面板后没清引用，且消息随视图丢。
   补 `chatHistory` 留档 + 展开重画 + 收起清引用；删死字段 `panelContainer`。

### 真机验证清单（必须做，本环境做不了）

- [ ] 点输入框能否弹出键盘（部分 ROM 对 overlay 窗口输入法行为不一致；
      若某 ROM 仍不行，降级方案是「语音/快捷指令按钮 + 唤起 App 输入」）。
- [ ] 拖拽（标题行）与消息区滚动是否互不打架。
- [ ] scope 切换往返：切种类不清消息。
- [ ] 收起再展开：消息是否保留（chatHistory 重画）。
- [ ] 键盘弹起时面板是否上移（applyImeInset）、收起后是否复位。
- [ ] 工作区 scope：下一条只读命令（如「列一下文件」）能跑通。
- [ ] 聊天 scope：截屏问答仍正常。
- [ ] 后台约束：app 进程被杀 = 会话断（现状同款限制），文案需注明「加白名单/关电池优化可缓解」。

## 明确不做

- 悬浮窗内不渲染 AS2 的完整题卡（原生只画是/否/其他三按钮的简化形态）；复杂确认回 App 面板。
- 悬浮窗场景不执行破坏性操作（见上「确认策略」）。
