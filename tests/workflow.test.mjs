// 依赖式工作流：归一 / 拓扑分层 / 环检测 / 执行与前置注入（纯逻辑）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKFLOW_MAX_STEPS,
  normalizeWorkflowSteps,
  planWorkflow,
  runWorkflow,
} from '../src/agent/workflow.js';

test('normalizeWorkflowSteps：归一字段 + 过滤空 task + 上限', () => {
  const steps = normalizeWorkflowSteps([
    { task: 'x' },
    { id: 'b', task: 'y', dependsOn: ['a'], mode: 'WRITE' },
    { task: '' },
    { id: 'c', task: 'z', mode: 'weird' },
  ]);
  assert.equal(steps.length, 3, '空 task 被过滤');
  assert.equal(steps[0].id, 'step-1', '缺 id 自动补');
  assert.equal(steps[1].mode, 'write', 'mode 归一（大小写）');
  assert.equal(steps[2].mode, 'read', '未知 mode 回落 read');
  const many = normalizeWorkflowSteps(Array.from({ length: WORKFLOW_MAX_STEPS + 5 }, (_, i) => ({ id: `s${i}`, task: `t${i}` })));
  assert.equal(many.length, WORKFLOW_MAX_STEPS, '超上限截断');
});

test('planWorkflow：线性 / 菱形分层；环 / 未知依赖 / 自依赖 / 重复 id 报错', () => {
  const diamond = planWorkflow([
    { id: 'a', task: 'x' },
    { id: 'b', task: 'y', dependsOn: ['a'] },
    { id: 'c', task: 'z', dependsOn: ['a'] },
    { id: 'd', task: 'w', dependsOn: ['b', 'c'] },
  ]);
  assert.equal(diamond.ok, true);
  assert.deepEqual(diamond.waves, [['a'], ['b', 'c'], ['d']]);
  assert.deepEqual(diamond.order, ['a', 'b', 'c', 'd']);

  assert.equal(planWorkflow([{ id: 'a', task: 'x', dependsOn: ['b'] }, { id: 'b', task: 'y', dependsOn: ['a'] }]).ok, false, '环');
  assert.equal(planWorkflow([{ id: 'a', task: 'x', dependsOn: ['z'] }]).ok, false, '未知依赖');
  assert.equal(planWorkflow([{ id: 'a', task: 'x', dependsOn: ['a'] }]).ok, false, '自依赖');
  assert.equal(planWorkflow([{ id: 'a', task: 'x' }, { id: 'a', task: 'y' }]).ok, false, '重复 id');
});

test('runWorkflow：按层执行，前置结论注入依赖步骤的 task；结果按 id 归位', async () => {
  const calls = [];
  const result = await runWorkflow({
    steps: [
      { id: 'a', task: '任务A' },
      { id: 'b', task: '任务B' },
      { id: 'c', task: '任务C', dependsOn: ['a'] },
    ],
    runStep: async step => {
      calls.push(step.id);
      const gotDep = step.task.includes('前置步骤 a');
      return `结论-${step.id}${gotDep ? '-带A' : ''}`;
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.order, ['a', 'b', 'c']);
  assert.equal(result.results.a, '结论-a');
  assert.equal(result.results.b, '结论-b');
  assert.equal(result.results.c, '结论-c-带A', 'c 的 task 带上前置 a 的结论');
  assert.ok(calls.indexOf('c') > calls.indexOf('a'), 'c 在前置之后执行');
});

test('runWorkflow：非法图 / 缺执行器 → ok=false 且如实报错', async () => {
  const bad = await runWorkflow({ steps: [{ id: 'a', task: 'x', dependsOn: ['b'] }, { id: 'b', task: 'y', dependsOn: ['a'] }], runStep: async () => 'x' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
  const noRunner = await runWorkflow({ steps: [{ id: 'a', task: 'x' }] });
  assert.equal(noRunner.ok, false);
});
