// 记忆冲突纯逻辑：候选对收敛 / 提示词构造 / 判定与合并结果的防御性解析。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConflictPrompt,
  buildMergePrompt,
  candidatePairs,
  CANDIDATE_MIN_SCORE,
  conflictIndex,
  conflictPairKey,
  judgedPairKeys,
  MAX_CANDIDATE_PAIRS,
  parseConflictResponse,
  parseMergeResponse,
  pendingConflicts,
  RESOLUTION_IGNORED,
} from '../src/memory/conflict.js';

function seg(overrides = {}) {
  return {
    id: 'seg-1',
    sessionId: 's1',
    messageId: 'm1',
    role: 'user',
    at: 1,
    text: '用户：我喜欢猫',
    vector: [1, 0],
    ...overrides,
  };
}

test('conflictPairKey：与传入顺序无关，同一对永远同一个键', () => {
  const a = seg({ sessionId: 's1', id: 'a' });
  const b = seg({ sessionId: 's2', id: 'b' });
  assert.equal(conflictPairKey(a, b), conflictPairKey(b, a));
  assert.notEqual(conflictPairKey(a, b), conflictPairKey(a, seg({ sessionId: 's2', id: 'c' })));
});

test('candidatePairs：向量接近的才成为候选，按相似度降序', () => {
  const index = [
    seg({ id: 'a', messageId: 'm1', text: '用户：我喜欢猫', vector: [1, 0] }),
    seg({ id: 'b', messageId: 'm2', text: '用户：我讨厌猫', vector: [0.98, 0.02] }),
    seg({ id: 'c', messageId: 'm3', text: '用户：今天下雨', vector: [0, 1] }),
  ];
  const pairs = candidatePairs(index);
  assert.equal(pairs.length, 1, '只有同主题的一对');
  assert.equal(pairs[0].left.id, 'a');
  assert.equal(pairs[0].right.id, 'b');
  assert.ok(pairs[0].score >= CANDIDATE_MIN_SCORE);
});

test('candidatePairs：同一条消息的不同分片不算冲突', () => {
  const index = [
    seg({ id: 'a-0', messageId: 'm1', text: '用户：前半段', vector: [1, 0] }),
    seg({ id: 'a-400', messageId: 'm1', text: '用户：后半段', vector: [1, 0] }),
  ];
  assert.deepEqual(candidatePairs(index), [], '同一消息切出的分片天然相似，不是矛盾');
});

test('candidatePairs：跨会话的同名 messageId 不当作同一消息（无 id 历史数据会撞名）', () => {
  // chunkMessages 对没有 id 的消息用 `msg-<序号>` 兜底，跨会话必然撞名；
  // 若只比 messageId 不看会话，就会把两条无关记忆误判成「同一条消息的分片」而漏检。
  const index = [
    seg({ id: 'a', sessionId: 's1', messageId: 'msg-3', text: '甲', vector: [1, 0] }),
    seg({ id: 'b', sessionId: 's2', messageId: 'msg-3', text: '乙', vector: [1, 0] }),
  ];
  assert.equal(candidatePairs(index).length, 1, '不同会话的同名兜底 id 仍要参与比对');
});

test('candidatePairs：文本完全相同的重复条目不算冲突', () => {
  const index = [
    seg({ id: 'a', messageId: 'm1', text: '用户：重复内容', vector: [1, 0] }),
    seg({ id: 'b', messageId: 'm2', text: '用户：重复内容', vector: [1, 0] }),
  ];
  assert.deepEqual(candidatePairs(index), []);
});

test('candidatePairs：excludeKeys 排除已判过的对；无向量的条目不参与', () => {
  const a = seg({ id: 'a', messageId: 'm1', text: '甲', vector: [1, 0] });
  const b = seg({ id: 'b', messageId: 'm2', text: '乙', vector: [1, 0] });
  const key = conflictPairKey(a, b);
  assert.equal(candidatePairs([a, b]).length, 1);
  assert.deepEqual(candidatePairs([a, b], { excludeKeys: [key] }), []);
  assert.deepEqual(
    candidatePairs([a, seg({ id: 'c', messageId: 'm3', text: '丙', vector: [] })]),
    [],
    '没有向量的记忆无法算相似度'
  );
});

test('candidatePairs：数量上限生效', () => {
  const index = Array.from({ length: 12 }, (unused, i) => seg({
    id: `seg-${i}`,
    messageId: `m${i}`,
    text: `文本${i}`,
    vector: [1, i * 0.001],
  }));
  assert.ok(candidatePairs(index).length <= MAX_CANDIDATE_PAIRS);
});

test('buildConflictPrompt：逐组编号，含双方文本与判定要求', () => {
  const a = seg({ id: 'a', messageId: 'm1', text: '用户：我喜欢猫', vector: [1, 0] });
  const b = seg({ id: 'b', messageId: 'm2', text: '用户：我讨厌猫', vector: [1, 0] });
  const prompt = buildConflictPrompt(candidatePairs([a, b]));
  assert.equal(prompt.length, 2);
  assert.equal(prompt[0].role, 'system');
  assert.equal(prompt[1].role, 'user');
  assert.match(prompt[1].content, /^1\. A：用户：我喜欢猫/m);
  assert.match(prompt[1].content, /B：用户：我讨厌猫/);
  assert.match(prompt[0].content, /矛盾/);
});

test('parseConflictResponse：认出「矛盾 / 不矛盾」，不把否定读反', () => {
  const pairs = [
    { key: 'k1' }, { key: 'k2' }, { key: 'k3' }, { key: 'k4' },
  ];
  const verdicts = parseConflictResponse([
    '1. 矛盾｜后一条推翻了前一条。',
    '2. 不矛盾｜只是补充信息。',
    '3. 两者不矛盾，可以同时成立。',
    '4. 不认同 B 的说法，两者矛盾。',
  ].join('\n'), pairs);
  assert.deepEqual(verdicts.map(item => item.conflict), [true, false, false, true]);
  assert.ok(verdicts.every(item => item.parsed));
  assert.match(verdicts[0].reason, /推翻/);
});

test('parseConflictResponse：兼容只回「是 / 否」；认不出的行标记 parsed:false', () => {
  const pairs = [{ key: 'k1' }, { key: 'k2' }, { key: 'k3' }];
  const verdicts = parseConflictResponse('1. 是\n2. 否\n3. 说不清楚', pairs);
  assert.equal(verdicts[0].conflict, true);
  assert.equal(verdicts[1].conflict, false);
  assert.equal(verdicts[2].parsed, false, '认不出就不写结果，留给下次重试');
});

test('parseConflictResponse：越界序号与空响应不崩', () => {
  const pairs = [{ key: 'k1' }];
  const verdicts = parseConflictResponse('9. 矛盾\n\n乱写一行', pairs);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].parsed, false);
  assert.deepEqual(parseConflictResponse('', pairs).map(item => item.parsed), [false]);
  assert.deepEqual(parseConflictResponse(null, []), []);
});

test('buildMergePrompt / parseMergeResponse：剥掉列表符与前缀词', () => {
  const a = seg({ id: 'a', text: '用户：喜欢猫', vector: [1, 0] });
  const b = seg({ id: 'b', text: '用户：讨厌猫', vector: [1, 0] });
  const prompt = buildMergePrompt(a, b);
  assert.match(prompt[1].content, /A：用户：喜欢猫/);
  assert.match(prompt[1].content, /B：用户：讨厌猫/);
  assert.equal(parseMergeResponse('- 用户对猫的喜好发生了转变，从喜欢变成讨厌。'), '用户对猫的喜好发生了转变，从喜欢变成讨厌。');
  assert.equal(parseMergeResponse('合并后：用户现在讨厌猫。'), '用户现在讨厌猫。');
  assert.equal(parseMergeResponse('\n\n'), '');
});

test('conflictIndex / pendingConflicts：只统计未处理且判定为矛盾的记录', () => {
  const records = [
    { key: 'k1', aKey: 'A', bKey: 'B', conflict: true, resolution: '' },
    { key: 'k2', aKey: 'C', bKey: 'D', conflict: false, resolution: '' },
    { key: 'k3', aKey: 'E', bKey: 'F', conflict: true, resolution: RESOLUTION_IGNORED },
  ];
  const badges = conflictIndex(records);
  assert.deepEqual([...badges.keys()].sort(), ['A', 'B']);
  assert.equal(badges.get('A').length, 1);
  assert.deepEqual(pendingConflicts(records).map(item => item.key), ['k1']);
});

test('judgedPairKeys：判过的对（含判定为无关的）都要排除，避免重复花模型调用', () => {
  const records = [
    { key: 'k1', resolution: '' },
    { key: 'k2', resolution: RESOLUTION_IGNORED },
    { key: '' },
  ];
  assert.deepEqual(judgedPairKeys(records).sort(), ['k1', 'k2']);
});
