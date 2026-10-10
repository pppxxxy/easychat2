// K1：工具结果清除（resultClearing）——unseen/recent-3/120 门槛/驱逐顺序/落盘分支/配对/钩子。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESULT_CLEARING_MIN_CHARS,
  applyResultClearing,
  buildClearedPlaceholder,
  collectClearableResults,
  estimateContextBytes,
  findOrphanToolMessages,
  isToolResultConsumed,
  planResultClearing,
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
