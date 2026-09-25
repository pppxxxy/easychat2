import test from 'node:test';
import assert from 'node:assert/strict';

import { getCachedDisplayText } from '../src/displayTextCache.js';

test('同一消息与脚本只计算一次展示文本', () => {
  const message = { id: 'm1', text: '原文' };
  const scripts = [];
  let calls = 0;
  const compute = () => {
    calls += 1;
    return '结果';
  };
  assert.equal(getCachedDisplayText(message, scripts, 1, 0, compute), '结果');
  assert.equal(getCachedDisplayText(message, scripts, 1, 0, compute), '结果');
  assert.equal(calls, 1);
});

test('脚本引用、depth 或消息对象变化时重新计算', () => {
  const message = { id: 'm1', text: '原文' };
  const scripts = [];
  let calls = 0;
  const compute = () => {
    calls += 1;
    return `结果${calls}`;
  };
  getCachedDisplayText(message, scripts, 1, 0, compute);
  getCachedDisplayText(message, [], 1, 0, compute);
  getCachedDisplayText(message, [], 1, 2, compute);
  getCachedDisplayText({ id: 'm1', text: '原文' }, [], 1, 2, compute);
  assert.equal(calls, 4);
});
