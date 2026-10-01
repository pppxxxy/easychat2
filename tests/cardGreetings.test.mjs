import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGreetingImport,
  isGreetingMessage,
  listGreetingCandidates,
  removeGreetingDraftIndex,
} from '../src/cardGreetings.js';

test('整理候选：firstMes 在前，备用开场白在后，去空去空白', () => {
  const list = listGreetingCandidates({
    firstMes: '  主开场  ',
    alternateGreetings: ['备用一', '', '  ', '备用二'],
  });
  assert.deepEqual(list, [
    { text: '主开场', source: 'first' },
    { text: '备用一', source: 'alt' },
    { text: '备用二', source: 'alt' },
  ]);
});

test('没有开场白时返回空候选', () => {
  assert.deepEqual(listGreetingCandidates({}), []);
  assert.deepEqual(listGreetingCandidates(null), []);
});

test('选中某条：作为 firstMes，其余保留为备用', () => {
  const drafts = ['主开场', '备用一', '备用二'];
  assert.deepEqual(buildGreetingImport(drafts, 0), {
    firstMes: '主开场',
    alternateGreetings: ['备用一', '备用二'],
  });
  assert.deepEqual(buildGreetingImport(drafts, 1), {
    firstMes: '备用一',
    alternateGreetings: ['主开场', '备用二'],
  });
});

test('不使用开场白：firstMes 置空，全部保留为备用', () => {
  assert.deepEqual(buildGreetingImport(['主开场', '备用一'], -1), {
    firstMes: '',
    alternateGreetings: ['主开场', '备用一'],
  });
});

test('空草稿被丢弃，选中空草稿时 firstMes 为空', () => {
  assert.deepEqual(buildGreetingImport(['', '  '], 0), { firstMes: '', alternateGreetings: [] });
  assert.deepEqual(buildGreetingImport(['', '  '], -1), { firstMes: '', alternateGreetings: [] });
});

test('识别新旧开场白消息', () => {
  assert.equal(isGreetingMessage({ id: 'greeting-session-1', role: 'assistant' }, 'session-1'), true);
  assert.equal(isGreetingMessage({ id: 'other', role: 'assistant', kind: 'greeting' }, 'session-1'), true);
  assert.equal(isGreetingMessage({ id: 'other', role: 'assistant' }, 'session-1'), false);
});

test('删除草稿后选中下标：删中回落第一条，删空回 -1', () => {
  // 删中的那条：还有剩余则选中第一条，删空则 -1
  assert.equal(removeGreetingDraftIndex(1, 1, 2), 0);
  assert.equal(removeGreetingDraftIndex(0, 0, 0), -1);
});

test('删除草稿后选中下标：删除项之后的选中位左移，之前的保持不变', () => {
  // 选中第 2 条，删第 0 条 → 左移为 1
  assert.equal(removeGreetingDraftIndex(2, 0, 2), 1);
  // 选中第 0 条，删第 2 条 → 不变
  assert.equal(removeGreetingDraftIndex(0, 2, 2), 0);
});

test('删除草稿后选中下标：未选中（-1）保持 -1，非法输入归一为 -1', () => {
  assert.equal(removeGreetingDraftIndex(-1, 0, 2), -1);
  assert.equal(removeGreetingDraftIndex(undefined, 0, 2), -1);
  assert.equal(removeGreetingDraftIndex(null, 0, 2), -1);
});
