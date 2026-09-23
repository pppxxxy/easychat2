import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGreetingImport, listGreetingCandidates } from '../src/cardGreetings.js';

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
