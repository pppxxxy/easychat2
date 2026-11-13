// 桌面分支导航映射（branchNav）与角色库派生（libraryView）的行为测试。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBranchNav } from '../../src/chat/branchNav.js';
import {
  characterMatchesQuery,
  characterSummary,
  filterCharacters,
  sortCharacters,
} from '../../src/character/libraryView.js';

const branch = (id, time) => ({ id, forkMessageId: 'm1', createdAt: time, versionTime: time, messageCount: 2, preview: id });

function forkMapOf(entries) {
  return new Map(entries);
}

test('buildBranchNav：只在分叉点之后的助手消息上挂版本号', () => {
  const messages = [
    { id: 'm1', role: 'user', text: '第一问' },
    { id: 'm2', role: 'assistant', text: '第一版回复', timestamp: 200 },
    { id: 'm3', role: 'user', text: '第二问' },
    { id: 'm4', role: 'assistant', text: '第二版回复', timestamp: 400 },
  ];
  const forkMap = forkMapOf([['m1', [branch('b1', 100)]]]);
  const nav = buildBranchNav(messages, forkMap);
  assert.deepEqual([...nav.keys()], ['m2']);
  assert.equal(nav.get('m2').total, 2);
  assert.equal(nav.get('m2').index, 2, '当前版本按自身时间戳插到旧版本之后');
  assert.equal(nav.get('m2').prevId, 'b1');
  assert.equal(nav.get('m2').nextId, '');
  assert.equal(nav.get('m2').branches.length, 1);
});

test('buildBranchNav：用户消息不挂切换器，单分支/无分支不挂', () => {
  const messages = [
    { id: 'u1', role: 'user', text: '问', timestamp: 100 },
    { id: 'a1', role: 'assistant', text: '答', timestamp: 200 },
    { id: 'u2', role: 'user', text: '再问', timestamp: 300 },
  ];
  // 分叉点 u1 只有一条归档分支 → 总数仍是 2？不是：buildForkVersions 的 total = 归档数 + 1。
  const nav = buildBranchNav(messages, forkMapOf([['u1', [branch('b1', 100)]]]));
  assert.deepEqual([...nav.keys()], ['a1']);
  // 分叉点是 u2 但没有分支：不挂。
  const none = buildBranchNav(messages, forkMapOf([]));
  assert.equal(none.size, 0, '没有分支时整条时间线都不显示切换器');
});

test('buildBranchNav：forkMap 缺失或非 Map 时安全返回空表', () => {
  const messages = [{ id: 'm1', role: 'user' }, { id: 'm2', role: 'assistant' }];
  assert.equal(buildBranchNav(messages, null).size, 0);
  assert.equal(buildBranchNav(null, forkMapOf([])).size, 0);
});

test('characterMatchesQuery：名称/描述/场景/标签都参与匹配，大小写与空白不敏感', () => {
  const character = {
    name: 'Luna',
    description: '一位星海向导',
    scenario: 'Night city',
    tags: ['SciFi', '温柔'],
  };
  assert.equal(characterMatchesQuery(character, ''), true, '空查询返回全部');
  assert.equal(characterMatchesQuery(character, '   '), true);
  assert.equal(characterMatchesQuery(character, 'luna'), true);
  assert.equal(characterMatchesQuery(character, '星海'), true);
  assert.equal(characterMatchesQuery(character, 'night'), true);
  assert.equal(characterMatchesQuery(character, 'scifi'), true);
  assert.equal(characterMatchesQuery(character, '温柔'), true);
  assert.equal(characterMatchesQuery(character, '不存在'), false);
});

test('filterCharacters：null 条目不会误导匹配，空数组安全', () => {
  const list = [{ name: 'A' }, null, { name: 'B' }];
  assert.equal(filterCharacters(list, 'a').length, 1);
  assert.equal(filterCharacters(list, '').length, 2, '空查询只保留真实条目');
  assert.deepEqual(filterCharacters(null, 'x'), []);
});

test('sortCharacters：置顶在前、其余保持原顺序（稳定）', () => {
  const list = [
    { id: 'a' },
    { id: 'b', pinned: true },
    { id: 'c' },
    { id: 'd', pinned: true },
  ];
  assert.deepEqual(sortCharacters(list).map(item => item.id), ['b', 'd', 'a', 'c']);
  // 不修改入参顺序（纯函数约定）。
  assert.deepEqual(list.map(item => item.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sortCharacters(null), []);
});

test('characterSummary：优先描述，压成单行并截断', () => {
  assert.equal(characterSummary({ description: '  第一行\n第二行  ' }), '第一行 第二行');
  assert.equal(characterSummary({ description: '', personality: '人设' }), '人设');
  assert.equal(characterSummary({ description: '', personality: '', scenario: '场景' }), '场景');
  assert.equal(characterSummary({}), '');
  const long = 'x'.repeat(200);
  const summary = characterSummary({ description: long }, 40);
  assert.equal(summary.length, 41, '截断后带一个省略号');
  assert.ok(summary.endsWith('…'));
  // 极限参数不会把上限压到 0 或负数。
  assert.ok(characterSummary({ description: long }, 0).length > 8);
});