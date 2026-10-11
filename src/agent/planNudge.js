// O0.2：update_plan 的「计划未更新」nag reminder（纯逻辑，零依赖，Node 可直测）。
//
// 教材纪律：模型列了计划却连续多轮不更新进度时，往工具结果后注入一行提醒（只进模型
// 上下文，不进用户消息流），打断「计划列完就忘」。与 A1 轮次预算提醒同款——轮末以
// system 小段注入，不打断 tool_calls 与 tool 结果的配对结构。
//
// 放在 src/agent（而非 workspace）：它是循环纪律，工作区只是恰好提供了 update_plan。
// 用最薄的形状判断（plan 是数组且存在 status !== 'done' 的项），不反向依赖工作区域。

export const PLAN_TOOL_NAME = 'update_plan';
// 连续多少轮未调用 update_plan 才提醒。
export const PLAN_NAG_ROUNDS = 3;
export const PLAN_NAG_TEXT = '提醒：计划里还有未完成步骤，但已连续多轮没有更新进度。'
  + '请调用 update_plan 更新各步状态（单步任务可忽略本提醒）。';

// plan 参数（update_plan 的 args）里是否还有未完成步骤。缺省/空/全 done → false。
export function hasUnfinishedPlanSteps(planArgs) {
  const plan = planArgs && Array.isArray(planArgs.plan) ? planArgs.plan : [];
  return plan.some(item => item && typeof item === 'object' && item.status !== 'done');
}

// 是否应当注入提醒：有未完成步骤 ∧ 距上次更新已达阈值轮。
export function shouldNudgePlan({ planArgs, roundsSinceUpdate, threshold = PLAN_NAG_ROUNDS } = {}) {
  if (!hasUnfinishedPlanSteps(planArgs)) return false;
  const rounds = Number(roundsSinceUpdate);
  return Number.isFinite(rounds) && rounds >= threshold;
}
