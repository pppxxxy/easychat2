import test from 'node:test';
import assert from 'node:assert/strict';

import { detectMilestone, evaluateTurn, clampAffinity } from '../src/moments/affinity.js';

test('detectMilestone：识别里程碑事件，无命中返回 null', () => {
  assert.equal(detectMilestone('今天是我生日'), 'birthday');
  assert.equal(detectMilestone('我们在一起吧'), 'confession');
  assert.equal(detectMilestone('这是我们的约定'), 'promise');
  assert.equal(detectMilestone('再也不见'), 'farewell');
  assert.equal(detectMilestone('今天天气不错'), null);
  assert.equal(detectMilestone(''), null);
  assert.equal(detectMilestone(null), null);
});

test('evaluateTurn：正负情绪抵消后给出受限增量，含双方文本', () => {
  const positive = evaluateTurn({ userText: '谢谢，我很开心', assistantText: '真棒' });
  assert.equal(positive.delta, 3);
  const negative = evaluateTurn({ userText: '我讨厌你，滚', assistantText: '别烦' });
  assert.equal(negative.delta, -4);
  const balanced = evaluateTurn({ userText: '喜欢讨厌', assistantText: '' });
  assert.equal(balanced.delta, 0);
});

test('evaluateTurn：增量不超过上限 ±5', () => {
  const many = '喜欢 开心 谢谢 感谢 爱 真棒 厉害 温柔 可爱 抱抱';
  const result = evaluateTurn({ userText: many, assistantText: many });
  assert.equal(result.delta, 5);
});

test('evaluateTurn：无情绪词但用户长文本给 +1，并附带里程碑', () => {
  const long = '今天出门遇到一只小猫，它在阳光下打着哈欠，看起来非常放松。';
  const result = evaluateTurn({ userText: long, assistantText: '' });
  assert.equal(result.delta, 1);
  assert.equal(result.milestone, null);
  const withMilestone = evaluateTurn({ userText: '生日快乐', assistantText: '' });
  assert.equal(withMilestone.milestone, 'birthday');
});

test('evaluateTurn：空输入安全，不抛错', () => {
  assert.deepEqual(evaluateTurn(), { delta: 0, milestone: null });
  assert.deepEqual(evaluateTurn({}), { delta: 0, milestone: null });
});

test('clampAffinity：取整并夹在 [-100,100]，非法输入归零', () => {
  assert.equal(clampAffinity(42.6), 43);
  assert.equal(clampAffinity(-42.6), -43);
  assert.equal(clampAffinity(999), 100);
  assert.equal(clampAffinity(-999), -100);
  assert.equal(clampAffinity('12'), 12);
  assert.equal(clampAffinity(NaN), 0);
  assert.equal(clampAffinity(undefined), 0);
});
