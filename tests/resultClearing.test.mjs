// K1：工具结果清除（resultClearing）——unseen/recent-3/120 门槛/驱逐顺序/落盘分支/配对/钩子。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESULT_CLEARING_BUDGET_BYTES,
  RESULT_CLEARING_MIN_CHARS,
  applyResultClearing,
  buildClearedPlaceholder,
  collectClearableResults,
  estimateContextBytes,
  findOrphanToolMessages,
  isToolResultConsumed,
  planResultClearing,
  resolveContextBudgetBytes,
} from '../src/agent/resultClearing.js';

// 一轮：assistant(tool_call) → tool(content) → assistant(回复，使该结果被消费)
function round(id, content) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content },
    { role: 'assistant', content: `done ${id}` },
  ];
}

function build(contents) {
  const out = [{ role: 'user', content: 'go' }];
  contents.forEach((content, index) => out.push(...round(`c${index}`, content)));
  return out;
}

test('isToolResultConsumed：其后有 assistant 才算消费', () => {
  const messages = [
    { role: 'tool', tool_call_id: 'a', content: 'x' },
    { role: 'assistant', content: 'ok' },
    { role: 'tool', tool_call_id: 'b', content: 'y' },
  ];
  assert.equal(isToolResultConsumed(messages, 0), true);
  assert.equal(isToolResultConsumed(messages, 2), false, '末尾无 assistant = unseen');
});

test('collectClearableResults：unseen 排除 / recent-3 窗口保护 / ≤120 门槛', () => {
  const contents = ['A'.repeat(500), 'B'.repeat(500), 'C'.repeat(500), 'D'.repeat(500), 'E'.repeat(500)];
  const messages = build(contents);
  const candidates = collectClearableResults(messages);
  // 5 轮，最近 3 条工具结果受保护 → 只剩前 2 条候选
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(item => item.length === 500));

  // 门槛：全部 ≤120 → 无候选
  const small = build(['x'.repeat(50), 'y'.repeat(50), 'z'.repeat(50), 'w'.repeat(50), 'v'.repeat(50)]);
  assert.equal(collectClearableResults(small).length, 0);
  assert.ok(RESULT_CLEARING_MIN_CHARS === 120);

  // unseen：末尾工具结果无后续 assistant → 即使不在窗口内也不清（这里构造最近一条为 unseen）
  const unseen = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'u', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'u', content: 'Z'.repeat(500) },
  ];
  assert.equal(collectClearableResults(unseen).length, 0, 'unseen 永不清除');
});

test('planResultClearing：预算内不动；超预算按批内从大到小驱逐', () => {
  // 候选 = 前 2 轮（后 3 轮受窗口保护）；大小 1000 / 300
  const messages = build(['A'.repeat(1000), 'B'.repeat(300), 'C'.repeat(5000), 'D'.repeat(5000), 'E'.repeat(5000)]);
  const bytesBefore = estimateContextBytes(messages);

  const noop = planResultClearing(messages, { budgetBytes: bytesBefore + 1 });
  assert.equal(noop.cleared, 0);
  assert.deepEqual(noop.indices, []);

  // 只需释放 1 字节 → 选最大的候选（index=2，1000 字符）先清
  const one = planResultClearing(messages, { budgetBytes: bytesBefore - 1 });
  assert.equal(one.cleared, 1);
  assert.equal(one.indices[0], 2, '批内从大到小：先清 1000 字符那条');

  // 预算 0 → 两个候选都清
  const all = planResultClearing(messages, { budgetBytes: 0 });
  assert.deepEqual([...all.indices].sort((a, b) => a - b), [2, 5]);
  assert.ok(all.bytesAfter <= all.bytesBefore);
});

test('applyResultClearing：落盘成功替换为占位符；失败保原文；钩子触发；配对完整', async () => {
  const messages = build(['A'.repeat(500), 'B'.repeat(500), 'C'.repeat(500), 'D'.repeat(500), 'E'.repeat(500)]);
  const plan = planResultClearing(messages, { budgetBytes: 0 });
  assert.ok(plan.indices.length > 0);

  // 落盘成功
  const clearedPaths = [];
  const result = await applyResultClearing(messages, plan.indices, {
    persist: async (content, meta) => ({ path: `.task_outputs/tool-results/${meta.toolCallId}.txt` }),
    onCleared: path => clearedPaths.push(path),
  });
  assert.equal(result.cleared.length, plan.indices.length);
  assert.equal(clearedPaths.length, plan.indices.length);
  for (const item of result.cleared) {
    assert.match(String(result.messages[item.index].content), /此前工具结果已存至 .*tool-results/);
  }
  assert.equal(findOrphanToolMessages(result.messages).length, 0, '配对完整（无孤儿）');
  // 原数组未被改动（浅拷贝）
  assert.equal(String(messages[plan.indices[0]].content).length, 500);

  // 落盘返回 null → 保原文
  const kept = await applyResultClearing(messages, plan.indices, { persist: async () => null });
  assert.equal(kept.cleared.length, 0);
  assert.equal(kept.messages[plan.indices[0]].content, messages[plan.indices[0]].content);

  // 落盘抛错 → 保原文
  const errored = await applyResultClearing(messages, plan.indices, { persist: async () => { throw new Error('disk'); } });
  assert.equal(errored.cleared.length, 0);

  // 无 persist → 不清除
  const none = await applyResultClearing(messages, plan.indices, {});
  assert.equal(none.cleared.length, 0);
});

test('buildClearedPlaceholder / findOrphanToolMessages', () => {
  assert.match(buildClearedPlaceholder('.task_outputs/tool-results/x.txt'), /offset 取回/);

  const orphanTool = [{ role: 'tool', tool_call_id: 'ghost', content: 'x' }];
  assert.equal(findOrphanToolMessages(orphanTool).length, 1);
  assert.equal(findOrphanToolMessages(orphanTool)[0].reason, 'tool-without-call');

  const orphanCall = [{ role: 'assistant', content: '', tool_calls: [{ id: 'c9' }] }];
  assert.equal(findOrphanToolMessages(orphanCall)[0].reason, 'call-without-tool');
});

// ---- resolveContextBudgetBytes：把 token 阈值换算成 K1 的字符预算 ----
// 背景（2026-10-10 实测）：K1 的默认预算是 2MB，而它量的是**本次请求**的 history；
// 请求上下文的上限是模型窗口（200k token 的中文 ≈ 0.4MB 字符），2MB 永远够不到，
// 于是 K1 在生产里一次都不触发。修法是宿主按模型窗口算出真实预算传进来。

test('预算换算：中文与英文内容各按自己的字符/token 比换算（不写死常数）', () => {
  // 纯中文：1 字 ≈ 1 token → 字符预算 ≈ token 阈值
  const zh = [{ role: 'user', content: '中'.repeat(10000) }];
  const zhBudget = resolveContextBudgetBytes(zh, { thresholdTokens: 10000 });
  assert.ok(zhBudget >= 9000 && zhBudget <= 12000, `中文预算应≈token 数，实际 ${zhBudget}`);

  // 纯英文：4 字符 ≈ 1 token → 同样 token 阈值下，字符预算应显著更大（约 4 倍）
  const en = [{ role: 'user', content: 'a'.repeat(40000) }];
  const enBudget = resolveContextBudgetBytes(en, { thresholdTokens: 10000 });
  assert.ok(enBudget > zhBudget * 3, `英文预算应远大于中文（实际 ${enBudget} vs ${zhBudget}）`);
});

test('预算换算：坏输入一律返回 0（调用方据此不传预算 = 保持旧行为）', () => {
  const msgs = [{ role: 'user', content: 'x'.repeat(100) }];
  assert.equal(resolveContextBudgetBytes(msgs, { thresholdTokens: 0 }), 0);
  assert.equal(resolveContextBudgetBytes(msgs, { thresholdTokens: -5 }), 0);
  assert.equal(resolveContextBudgetBytes(msgs, { thresholdTokens: Number.NaN }), 0);
  assert.equal(resolveContextBudgetBytes(msgs, {}), 0);
  assert.equal(resolveContextBudgetBytes([], { thresholdTokens: 1000 }), 0);
  assert.equal(resolveContextBudgetBytes(null, { thresholdTokens: 1000 }), 0);
  // 不可序列化（循环引用）不抛，返回 0
  const cyclic = { role: 'user', content: 'x' };
  cyclic.self = cyclic;
  assert.equal(resolveContextBudgetBytes([cyclic], { thresholdTokens: 1000 }), 0);
});

test('接通后 K1 真的会触发：满窗口上下文在真实预算下清除，在 2MB 默认下一条都不清', () => {
  // 造一个「塞满 200k 窗口」的中文上下文 + 12 轮工具结果（每轮 16KB，K1 的逐条上限量级）。
  const messages = [{ role: 'system', content: '系'.repeat(20000) }];
  for (let i = 0; i < 20; i += 1) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', content: '字'.repeat(9000) });
  }
  for (let r = 1; r <= 12; r += 1) {
    messages.push(...round(`t${r}`, '内'.repeat(16384)));
  }

  // 旧行为：2MB 默认 → 够不到 → 清除 0 条（这正是生产里发生的事）
  const withDefault = planResultClearing(messages);
  assert.equal(withDefault.cleared, 0, '2MB 默认下 K1 永不触发');
  assert.ok(estimateContextBytes(messages) < RESULT_CLEARING_BUDGET_BYTES / 2);

  // 新行为：按 200k 窗口换算出的预算 → 真的开始清除（且只清「已消费 + 非工作台」的旧结果）
  const budget = resolveContextBudgetBytes(messages, { thresholdTokens: 102500 });
  assert.ok(budget > 0 && budget < RESULT_CLEARING_BUDGET_BYTES);
  const withBudget = planResultClearing(messages, { budgetBytes: budget });
  assert.ok(withBudget.cleared > 0, '接通预算后 K1 应当清除旧工具结果');
  assert.ok(withBudget.bytesAfter < withBudget.bytesBefore, '清除后体积必须下降');
  // 注意：本例里**不可清除的散文**（系统提示 + 20 条长消息 ≈ 20 万字符）本身就超预算，
  // 所以驱逐到「没有候选可清」也回不到预算内。这是 K1 的边界而非 bug：它只退役工具结果，
  // 剩下的压力交给 N2/D3 压缩。所以这里只钉「确实清了、体积确实降了」。
  assert.equal(withBudget.indices.length, withBudget.cleared);
});
