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

// 回归 2026-10-11 审查 P1-1：results 的键是**用户可控的步骤 id**，用普通对象字面量时
// Object.prototype 会参与进来。实测（node 24）：
//   const r = {}; r['__proto__'] = '结论';  → 赋值被原型 setter 静默丢弃，r 仍是 {}
//   读 r['__proto__']                      → Object.prototype，被 String() 拼成 '[object Object]'
// 后果：该步骤的结论无声消失，合并结果里变成一段乱码；依赖它的步骤拿到的是 '[object Object]'。
// 修法是 Object.create(null)（无原型对象），本测试用**危险 id** 表把这一整类钉死。
test('回归 P1-1：危险步骤 id 不参与原型链——结论不丢、依赖注入不串味', async () => {
  const dangerous = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'];
  const result = await runWorkflow({
    steps: dangerous.map(id => ({ id, task: `任务-${id}` })),
    runStep: async step => `结论-${step.id}`,
  });
  assert.equal(result.ok, true);
  // 1) 结果表没有原型——这是「任意字符串 id 都只是普通键」的结构保证。
  assert.equal(Object.getPrototypeOf(result.results), null, 'results 必须是无原型对象');
  // 2) 每个危险 id 的结论都能原样取回（__proto__ 是唯一在旧写法下真的丢值的那个）。
  for (const id of dangerous) {
    assert.equal(result.results[id], `结论-${id}`, `步骤 ${id} 的结论必须原样保留`);
  }
  // 3) 顺序表也不受污染（order 是数组，这里确认 id 没被改写）。
  assert.deepEqual([...result.order].sort(), [...dangerous].sort());
});

test('回归 P1-1：dependsOn 用危险 id 时，下一步拿到的是结论而不是 [object Object]', async () => {
  const seen = [];
  const result = await runWorkflow({
    steps: [
      { id: '__proto__', task: '先调研' },
      { id: 'constructor', task: '再调研' },
      { id: 'sink', task: '综合', dependsOn: ['__proto__', 'constructor'] },
    ],
    runStep: async step => {
      seen.push({ id: step.id, task: step.task });
      return `结论-${step.id}`;
    },
  });
  assert.equal(result.ok, true);
  const sink = seen.find(item => item.id === 'sink');
  assert.ok(sink, '依赖步骤必须被执行');
  assert.ok(sink.task.includes('结论-__proto__'), '前置 __proto__ 的结论必须拼进下一步 task');
  assert.ok(sink.task.includes('结论-constructor'), '前置 constructor 的结论必须拼进下一步 task');
  // 旧写法下这里会出现 '[object Object]'（__proto__ 未赋值时的原型读取）——明确钉死它不再出现。
  assert.equal(sink.task.includes('[object Object]'), false, 'task 里不得出现 [object Object]');
  assert.equal(sink.task.includes('native code'), false, 'task 里不得出现原型链上的函数源码');
});

