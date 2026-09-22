import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assignStableCharacterIds,
  makeCharacterId,
  uniqueCharacterId,
} from '../src/context/characterIdentity.js';

const DEFAULT_ID = 'default';
const isInitial = character => character.name === 'EasyChat2 助手';

test('空 id 不再变成 default，而是生成唯一 id', () => {
  const { list, changed } = assignStableCharacterIds(
    [{ id: '', name: '导入角色' }, { id: 'default', name: 'EasyChat2 助手' }],
    { defaultId: DEFAULT_ID, isInitial, now: 1000 }
  );
  assert.equal(changed, true);
  assert.notEqual(list[0].id, 'default');
  assert.ok(list[0].id.startsWith('card-'));
  assert.equal(list[1].id, 'default');
});

test('重复 default：初始卡保留 default，另一个换新 id', () => {
  const { list } = assignStableCharacterIds(
    [{ id: 'default', name: '导入角色' }, { id: 'default', name: 'EasyChat2 助手' }],
    { defaultId: DEFAULT_ID, isInitial, now: 2000 }
  );
  assert.equal(list[1].id, 'default');
  assert.notEqual(list[0].id, 'default');
  assert.equal(new Set(list.map(item => item.id)).size, 2);
});

test('重复 id 稳定分配：先到者保留，后来者加后缀', () => {
  const { list, changed } = assignStableCharacterIds(
    [{ id: 'x' }, { id: 'x' }, { id: 'x' }],
    { defaultId: DEFAULT_ID, isInitial }
  );
  assert.equal(changed, true);
  assert.deepEqual(list.map(item => item.id), ['x', 'x-1', 'x-2']);
});

test('已经唯一的 id 不会被改动，顺序变化也不影响归属', () => {
  const base = [{ id: 'a' }, { id: 'b' }];
  const r1 = assignStableCharacterIds(base, { defaultId: DEFAULT_ID, isInitial });
  const r2 = assignStableCharacterIds([...base].reverse(), { defaultId: DEFAULT_ID, isInitial });
  assert.equal(r1.changed, false);
  assert.equal(r2.changed, false);
  assert.deepEqual(r1.list.map(item => item.id), ['a', 'b']);
  assert.deepEqual(r2.list.map(item => item.id), ['b', 'a']);
});

test('持久化后再读取（顺序被 sortCharacters 改变）不再改动 id，身份不漂移', () => {
  const stored = [
    { id: '', name: '导入角色' },
    { id: 'default', name: 'EasyChat2 助手' },
  ];
  const first = assignStableCharacterIds(stored, { defaultId: DEFAULT_ID, isInitial, now: 3000 });
  assert.equal(first.changed, true);
  const assigned = first.list.find(item => item.name === '导入角色').id;
  assert.ok(assigned.startsWith('card-'));

  // 模拟置顶 / 最近使用导致列表顺序变化
  const reordered = [...first.list].reverse();
  const second = assignStableCharacterIds(reordered, { defaultId: DEFAULT_ID, isInitial, now: 4000 });
  assert.equal(second.changed, false);
  assert.equal(second.list.find(item => item.name === 'EasyChat2 助手').id, 'default');
  assert.equal(second.list.find(item => item.name === '导入角色').id, assigned);
});

test('uniqueCharacterId/makeCharacterId 产出可用 id', () => {
  const used = new Set(['x']);
  assert.equal(uniqueCharacterId('x', used), 'x-1');
  assert.ok(uniqueCharacterId('', used).startsWith('card-'));
  assert.ok(makeCharacterId(1).startsWith('card-'));
});
