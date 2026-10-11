// 在线请求的配置侧上下文 + K1（旧工具结果退役）的字符预算。
// 背景：K1 的默认预算 2MB 是请求上下文到不了的量（200k token 中文 ≈ 0.4MB 字符），
// 不按模型窗口接通就等于永不触发——这里钉住「接通后真的会触发」与「未声明窗口保持旧行为」。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_ONLINE_REQUEST_CONTEXT,
  resolveOnlineRequestContext,
} from '../src/chat/onlineRequestContext.js';
import { resolveAgentContextBudget } from '../src/chat/agentContextBudget.js';
import { RESULT_CLEARING_BUDGET_BYTES, planResultClearing } from '../src/agent/resultClearing.js';

// 造一条「满 200k 窗口」的中文上下文 + 12 轮工具结果（每轮 16KB，K1 逐条上限量级）。
function fullWindowHistory() {
  const messages = [{ role: 'system', content: '系'.repeat(20000) }];
  for (let i = 0; i < 20; i += 1) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', content: '字'.repeat(9000) });
  }
  for (let r = 1; r <= 12; r += 1) {
    messages.push(
      { role: 'assistant', content: '', tool_calls: [{ id: `t${r}`, type: 'function', function: { name: 'read_workspace_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `t${r}`, content: '内'.repeat(16384) },
      { role: 'assistant', content: `done ${r}` }
    );
  }
  return messages;
}

test('resolveOnlineRequestContext：期望配置 > 活动配置 > 第一个；取不到给安全默认', () => {
  const configs = [
    { id: 'a', name: 'A', supportsVision: false, model: 'm-a' },
    { id: 'b', name: 'B', supportsVision: true, supportsAudio: true, model: 'm-b' },
  ];
  // 注入假查询：真实现来自 storage/apiConfigs.js（那条链 Node 里加载不了）。
  const helpers = {
    getModel: config => config.model,
    getCapabilities: (config, modelName) => ({ contextWindow: modelName === 'm-b' ? 200000 : 0 }),
  };

  const byExpected = resolveOnlineRequestContext(configs, 'a', 'b', helpers);
  assert.equal(byExpected.configLabel, 'B', '显式期望的配置优先');
  assert.equal(byExpected.media.allowVision, true);
  assert.equal(byExpected.modelName, 'm-b');
  assert.equal(byExpected.contextWindow, 200000, '窗口来自该配置的能力声明');

  const byActive = resolveOnlineRequestContext(configs, 'b', 'missing', helpers);
  assert.equal(byActive.configLabel, 'B', '期望的找不到 → 退到活动配置');

  const byFirst = resolveOnlineRequestContext(configs, 'missing', 'missing', helpers);
  assert.equal(byFirst.configLabel, 'A', '都找不到 → 第一个');
  assert.equal(byFirst.contextWindow, 0, '该配置没声明窗口 → 0（调用方据此不传 K1 预算）');

  // 空/坏输入 → 安全默认（什么都不支持），不抛
  for (const bad of [[], null, undefined, 'nope']) {
    const ctx = resolveOnlineRequestContext(bad, 'x', 'y', helpers);
    assert.deepEqual(ctx, { ...EMPTY_ONLINE_REQUEST_CONTEXT });
  }
  // 不注入查询函数也能跑（退化为无模型名、无窗口），不抛
  assert.deepEqual(
    resolveOnlineRequestContext(configs, 'a', 'a'),
    { media: { allowVision: false, allowAudio: false }, modelName: '', configLabel: 'A', contextWindow: 0 }
  );
});

test('resolveAgentContextBudget：未声明窗口 → 0（调用方据此不传，保持 K1 的 2MB 默认）', () => {
  const messages = fullWindowHistory();
  assert.equal(resolveAgentContextBudget(messages, 0), 0);
  assert.equal(resolveAgentContextBudget(messages, null), 0);
  assert.equal(resolveAgentContextBudget(messages, Number.NaN), 0);
  assert.equal(resolveAgentContextBudget([], 200000), 0);
});

test('接通后 K1 真的会触发：同一段上下文，未声明窗口时清除 0 条，声明 200k 窗口后开始清除', () => {
  const messages = fullWindowHistory();

  // 旧行为：不传预算 → 2MB 默认 → 够不到 → 一条都不清（这正是生产里发生的事）
  assert.equal(planResultClearing(messages).cleared, 0);

  // 新行为：按 200k 窗口算出真实预算 → 真的开始退役旧工具结果
  const budget = resolveAgentContextBudget(messages, 200000);
  assert.ok(budget > 0, '声明窗口后必须算出正预算');
  assert.ok(budget < RESULT_CLEARING_BUDGET_BYTES, '真实预算必须远小于 2MB，否则等于没接通');

  const plan = planResultClearing(messages, { budgetBytes: budget });
  assert.ok(plan.cleared > 0, '接通预算后 K1 应当清除旧工具结果');
  assert.ok(plan.bytesAfter < plan.bytesBefore, '清除后体积必须下降');
  // 配对纪律：只换 content，消息条数不变（tool_call_id 仍与 assistant 的 tool_calls 成对）
  assert.equal(plan.indices.length, plan.cleared);
});
