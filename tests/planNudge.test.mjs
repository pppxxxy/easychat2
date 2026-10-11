// O0.2：update_plan 的 nag reminder（纯逻辑）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_NAG_ROUNDS, hasUnfinishedPlanSteps, shouldNudgePlan } from '../src/agent/planNudge.js';

test('hasUnfinishedPlanSteps：存在非 done 步骤才算未完成', () => {
  assert.equal(hasUnfinishedPlanSteps({ plan: [{ step: 'A', status: 'pending' }] }), true);
  assert.equal(hasUnfinishedPlanSteps({ plan: [{ step: 'A', status: 'in_progress' }] }), true);
  assert.equal(hasUnfinishedPlanSteps({ plan: [{ step: 'A', status: 'done' }] }), false);
  assert.equal(hasUnfinishedPlanSteps({ plan: [] }), false);
  assert.equal(hasUnfinishedPlanSteps({}), false);
  assert.equal(hasUnfinishedPlanSteps(null), false);
});

test('shouldNudgePlan：达到阈值且有未完成步骤才提醒', () => {
  const plan = { plan: [{ step: 'A', status: 'in_progress' }] };
  assert.equal(shouldNudgePlan({ planArgs: plan, roundsSinceUpdate: PLAN_NAG_ROUNDS - 1 }), false);
  assert.equal(shouldNudgePlan({ planArgs: plan, roundsSinceUpdate: PLAN_NAG_ROUNDS }), true);
  assert.equal(
    shouldNudgePlan({ planArgs: { plan: [{ step: 'A', status: 'done' }] }, roundsSinceUpdate: 99 }),
    false,
    '全 done 不提醒'
  );
  assert.equal(shouldNudgePlan({ planArgs: null, roundsSinceUpdate: 99 }), false, '没有计划不提醒');
});
