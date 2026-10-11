import test from 'node:test';
import assert from 'node:assert/strict';

import { filterCharactersByName } from '../src/settings/characterSearch.js';

const list = [
  { id: 'default', name: 'EasyChat2 助手' },
  { id: 'c1', name: '八重神子' },
  { id: 'c2', name: '慕魅' },
  { id: 'c3', name: 'Alice' },
];

test('空查询原样返回（保持引用与顺序）', () => {
  assert.equal(filterCharactersByName(list, ''), list);
  assert.equal(filterCharactersByName(list, '   '), list);
  assert.equal(filterCharactersByName(list, null), list);
});

test('按名字做大小写不敏感的子串过滤', () => {
  assert.deepEqual(filterCharactersByName(list, '神子').map(c => c.id), ['c1']);
  assert.deepEqual(filterCharactersByName(list, 'alice').map(c => c.id), ['c3']);
  assert.deepEqual(filterCharactersByName(list, 'ALICE').map(c => c.id), ['c3']);
  assert.deepEqual(filterCharactersByName(list, '助手').map(c => c.id), ['default']);
});

test('无名字时回退按 id 命中', () => {
  const unnamed = [{ id: 'card-42' }, { id: 'x', name: '' }];
  assert.deepEqual(filterCharactersByName(unnamed, 'card-42').map(c => c.id), ['card-42']);
});

test('无匹配返回空数组，非法输入安全兜底', () => {
  assert.deepEqual(filterCharactersByName(list, '不存在的名字'), []);
  assert.deepEqual(filterCharactersByName(null, 'a'), []);
  assert.deepEqual(filterCharactersByName(undefined, 'a'), []);
  assert.deepEqual(
    filterCharactersByName([null, 0, 'x', { id: 'ok', name: 'ok' }], 'ok').map(c => c.id),
    ['ok']
  );
});
