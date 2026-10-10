# O 系：可恢复性与防注入精度（spec 2026-10-10-recoverability）

> 依据 learn-claude-code（shareAI-lab）教材原文核验。上轮外部建议的 ②⑤⑦⑨ 引用系
> 捏造/错位（详见任务书勘误记录）。本 spec 记录 O0/O1/O2 的落地状态与裁决。
> **G1（P0 推送误删）仍在一切之前**（已在 main）。

## 现状基线（核验，勿重做）

- `messages.js` `serializeToolResult`：16KB 头尾保留，中段丢弃无落盘。
- `chat/compaction.js` `applyCompaction`：直接替换，无 transcript 归档、无权威分离、无防注入。
- `planTool`：纯回显不落盘，无单 in_progress 校验、无 nag reminder（本系 O0 修）。
- `memory.js` `workspaceMemorySection`：措辞「请按它工作」（记忆=指令源）。
- `subagent.js`：白名单防递归 + 6 轮上限已达标，勿动。
- 工作区系统提示不注入时间——保持（缓存友好）。

## O0 update_plan 纪律三件套（**已完成**，2026-10-10 分支 m1010m3）

- [x] **O0.1 单 in_progress 强校验**：`planTool.js` 新增 `buildPlanToolResult`——
      >1 个 in_progress 返回 `{ content: <回显>+[校验失败]…, isError: true }`，不静默接受。
- [x] **O0.2 nag reminder**：新增 `src/agent/planNudge.js`（纯函数 `hasUnfinishedPlanSteps`
      / `shouldNudgePlan`）；`loop.js` 跟踪最近一次 `update_plan` 参数与「距上次更新轮数」，
      连续 `PLAN_NAG_ROUNDS=3` 轮未更新且计划有未完成步骤时，轮末以 `role:'system'` 注入
      `PLAN_NAG_TEXT`（与 A1 预算提醒同款位置，不进用户消息流）。注入后重置计数。
- [x] **O0.3 plan 落盘**：新增会话旁路键 `@easychat2_session_plan::<sessionId>`
      （`storage/sessionCore.js` 的 `sessionPlanKey` + `storage/sessionPlan.js` 的
      get/save/clear）；`planTool` 经宿主注入的 `options.onPlan` 落盘（校验失败不落盘）；
      `tools.js`/`native.js` 透传 `onPlan`；`useChatSend` 在 read/write 模式接线
      `onPlan: steps => saveSessionPlan(sendSessionId, steps)`。压缩时注入 recap 段属 N2。
- [x] 测试：`workspacePlan.test.mjs`（校验拒绝 + onPlan 钩子）、`planNudge.test.mjs`
      （触发/抑制边界）、`agentLoop.test.mjs`（nag 注入 / 全 done 不注入）、
      `sessionPlan.test.mjs`（落盘 round-trip）。

## O1 超限结果落盘+预览+指针（**已完成**，2026-10-10 分支 m1010m3）

- [x] 新模块 `src/workspace/taskOutputs.js`：`.task_outputs/tool-results/<base36时间>-<白名单toolUseId>.txt`
      落盘（`persistToolResult`）、按文件名时间前缀 LRU 清理（`pruneToolResults`，上限 50）、
      `isTrustedTaskOutputPath`（纯前缀）/ `isTrustedTaskOutput`（前缀 + 可读）防伪造指针。
- [x] `messages.js`：`formatPersistedToolResult`（头尾各 2000 字符预览 + 中段省略标注 +
      `完整内容已存至 <path>…` 指针）、`serializeToolResultAsync`（超限先 persist，失败退回 D2 头尾）。
- [x] `loop.js`：`serializeToolResultAsync` + 宿主注入的 `options.persistToolResult`。
- [x] 宿主接线：`useChatSend` 在 read/write 模式注入 persist（绑 workspace store + characterId）。
- [x] 预算：落盘阈值 = 序列化上限 16KB（不新造 30K 常量）；预览 2000 字符/端。
- [x] 测试：`taskOutputs.test.mjs`（命名净化/伪造指针/落盘/LRU）、`agentMessages.test.mjs`
      （预览拼装 / persist 成功·失败·缺席）、`agentLoop.test.mjs`（超限结果落盘 → 历史留指针）。
- **备注**：O1 与 K1 共用「落盘占位管道」；本分支先建管道，K1 后续复用。

## O2 spec 修订包（**未做**，纯条款，随宿主任务合入）

- K1/N1/N2/K5/K6/M1 各自的追加条款（权威分离、摘要器防注入、transcript 归档、
  记忆段「非指令」措辞、search_workspace 超预算走 O1 落盘等）。
- **裁决**：条款随宿主工作流合入，不占独立档期；本分支不改 memory.js / compaction.js。

## 明确不做（防跑偏）

三级降级课/熔断课的「教材出处」考据 / 60 分钟阈值 / 压缩后自动重读文件 /
Stop hook 强制续跑 / 工具并行执行 / 抄教材桌面端常量 / 任务 DAG。
