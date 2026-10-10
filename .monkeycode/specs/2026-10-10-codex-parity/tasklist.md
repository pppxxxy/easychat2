# I 系：Codex 产品功能对照落地（spec 2026-10-10-codex-parity）

> **状态：I1/I2/I5 完成 + I3 纯函数层完成 + I4 行为核实报告交付**（2026-10-10，
> 分支 c1009c26；测试 +8，全量 2154 全通过）。I3 投递接线与 I4 实现登记为独立迭代。
>
> **先纠正任务书两处过时信息**：①「G1 仍未修」——G1 已在 c1009c24 修复；
> ② 总序里的 E1/E5/H1-H3 也已全部完成（c1009c23-c1009c25）。本系直接从 I1 开工。
>
> 外部调研的 12 项对照经核实：5 项已有等价实现（编辑/分支/搜索/Skill/模式白名单），
> 真缺口 4 项（Steer/Plan 批准衔接/定时提醒/任务不阻塞）+ 归档收尾。

## 现状基线（c1009c25 已核验，勿按外部调研的"零实现"前提重做）

- ✅ 编辑消息 / 分支树（branchTree + sessionBranches + BranchForkRow）/ 会话内搜索
  （ChatSearchBar + useChatSearch）/ Skill（T4 渐进披露 + D1 allowed-tools）/
  模式白名单（capabilities read/write）——都已在 main。
- ✅ G1 推送删除安全已修（c1009c24，三态 diff + 端到端测试钉死无 sha:null）。
- ✅ 6MB 痛点：D3 compaction + E4 jsonl 事件流已覆盖；**SQLite 全量迁移不做**（裁决 1）。
- ✅ schedule.js 是角色作息，与 agent 定时提醒无关（裁决：不混用）。

## I1 Steer 中途追加指令 ✅

- [x] 新模块 `src/agent/steering.js`：createSteeringQueue()——push（trim + 500 字
  截断；最多 5 条满则挤最旧）/ drain（取出即清空）。
- [x] loop.js：options.steering（约定 { drain() }）——**每轮模型请求前** drain，
  以 system 小段注入（「用户中途补充：…」硬编码中文不进 i18n）；**不打断工具链**
  （注入在轮与轮之间，tool_calls 与 tool 结果配对结构完整）。
- [x] 收束预警标记化：budgetWarned 从轮号判断改为标记式——Steering 注入重置标记
  （新目标下旧收束判断误导，允许再提醒一次；测试钉住顺序：先指令后提醒）。
- [x] UI：运行中发送按钮不再禁用——handleSend 开头分流：sending ∧ 有文字 → 入队 +
  清输入 + 状态行「已收到补充指令」；带附件 → 明确提示等本轮结束。turn 结束清理。
- [x] 测试：队列纯函数 + 注入时机（onRound 钩子基建）+ warning 重置 + 无 steering
  逐字节不变。

## I2 Plan 批准流程衔接 ✅

- [x] 判据纯函数：shouldOfferPlanApproval({ mode, plan })——read ∧ 计划非空 ∧
  有未完成项（全 done 没有可执行的；write 自己能执行不提议）。
- [x] UI：计划进度条内出现「批准并切换到可改模式执行」。
- [x] **时序攻坚（本轮最重要的设计决策）**：不能「切模式后立即 sendMessage」——
  ① ChatPanel 发送链自实现（无 sendMessage），handleSend 闭包带着定义时的
  mode（read），切模式后立即调用仍走 read 工具集；② 确认消息属于 overrideText，
  不得清用户正在输入的草稿。**解法**：handleSend 加 overrideText 参数（override
  路径不碰输入框/草稿/附件）；approvePlan 只做「切模式 + 确认文本挂
  pendingPlanRun state」；effect 在新渲染（mode==='write'）里用**新的 handleSend**
  发起——新闭包 = write 工具集/预算/提示词全正确。
- [x] 拒绝按钮不提供——不理会即视为不批准（任务书原文）。
- [x] 测试：判据纯函数 + 接线契约（pendingPlanRun/effect/overrideText 草稿保护）。

## I5 会话归档 ✅（半天收尾）

- [x] chats.js normalizeWorkspaceChat 加 archived（老数据缺字段 → false，零迁移）。
- [x] workspace.js 加 setWorkspaceChatArchived（幂等：重复设置直接成功）。
- [x] WorkspaceHistorySheet：「已归档（N）」切换 tab + 行内归档/恢复按钮 +
  空态文案区分；归档视图点行不切换（先恢复再选）。
- [x] ChatPanel：归档当前会话时顺带切到下一个未归档会话。
- [x] 归档会话不参与 D3 压缩扫描——D3 扫描消费主列表路径，列表层已过滤。
- [x] 测试：normalize 往返 + 存取 round-trip。

## I3 定时提醒（纯函数层完成，投递接线登记二期）

- [x] 新模块 `src/chat/reminders.js`（全纯函数 Node 直测）：parseReminderTime
  （HH:MM 严格校验）/ parseReminderSpec（单次 / 每日）/ reminderTargetAt /
  collectDueReminders（单次弹后消费、每日弹后留下、**lastFiredAt 防重复**——
  同窗轮询不重复弹；错过的单次补弹一次）/ nextOccurrenceAt / normalizeReminders
  （上限 10 + 字段收敛）。
- [x] **诚实边界**（裁决 3 落地）：只承诺「前台弹提示 + 不在前台下次打开补弹」；
  不承诺后台准点（Doze/ROM 限制）。
- [ ] 投递接线（二期）：宿主 notifier（当前 = 前台 Alert；接 expo-notifications
  后升级系统通知）+ 会话级「提醒我」设置入口 + AsyncStorage 存取。纯函数已备好，
  接线是纯组装。
- [x] 测试：解析越界/每日形态/到期收集（补弹、消费、防重复、跨天）/序列化上限。

## I4 任务不阻塞——行为核实报告（本轮交付），实现登记独立迭代

> 任务书要求先出报告再动手。以下为代码层核实（无真机，已标注推断边界）。

1. **切会话不取消 turn**（✅ 已是现状）：useChatSend 的 controller 挂 sendLockRef，
   切会话路径不调用 abort；activeSessionIdRef 只保护**回写目标**（切走后完成的
   回复不会写进错误的会话）。
2. **回来接续渲染缺失**（⚠️ 真缺口）：turn 进行中切走，流式回调因 sessionId
   guard 被跳过——回来后停留在切走那一刻的渲染；最终回复靠 turn 完成时的
   持久化补齐，但界面不自动刷新。I4 的「回来接续」就是补这个。
3. **后台行为**（⚠️ 平台限制，代码层判断）：发送链无 AppState 监听；RN 的 JS
   线程退后台后短期继续（Android 几十秒到几分钟不等），长 turn 大概率冻结在
   某个工具调用上——「turn 在后台跑完」不可承诺，与 I3 诚实边界同源。
4. **通知**：仓库无 expo-notifications 依赖；「完成通知」依赖该库（同 I3 投递层
   决策：装库后换 notifier）。
5. **I4 实现方案（已备好，独立迭代）**：turn registry（全局 Map 按 sessionId 索引，
   ChatPanel 挂全局单例）；回来接续 = 订阅 registry 的流式回调重挂；完成通知 =
   notifier 注入（仅 background 触发）；会话列表运行标记 = registry 查询。
   并发上限 1（裁决 4）；run_subagent 已覆盖并行读需求。

## 明确不做（防跑偏清单）

消息树重构 / SQLite 全量迁移 / Annotate / Side Chat / Chrome 插件 / PPT 插件系统 /
后台自动执行任务 / 多会话并行 turn / 桌面双栏 UI。

## 门禁

五门禁全绿（全量 2154）；纯函数 Node 直测先行（steering 队列、plan 判据、提醒
解析与到期、归档往返）；i18n 新词条对账通过（steering 3 条 + planApproval 1 条 +
归档 2 条，中英同步）；steering 注入语照旧不进 i18n。
