// 记忆体检（Phase 4）纯函数测试：报告结构、问题判定、排序。
// 判定口径必须与 memoryRetire（启动对账）一致，否则会出现「体检说正常、对账在悄悄改」。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMemoryCheckup,
  singleChatSessionsOf,
  worldMemoryIssue,
} from '../src/memory/checkup.js';

const memoryEntry = (id, overrides = {}) => ({
  id,
  comment: '记忆总结 1',
  content: '一段记忆',
  enabled: true,
  boundary: 'm1',
  ...overrides,
});

test('singleChatSessionsOf：只算该角色的单聊会话（群聊不计）', () => {
  const sessions = [
    { id: 's1', characterId: 'a', type: 'single' },
    { id: 's2', characterId: 'a' },
    { id: 's3', characterId: 'b', type: 'single' },
    { id: 'g1', characterId: 'a', type: 'group' },
  ];
  assert.deepEqual(singleChatSessionsOf(sessions, 'a').map(item => item.id), ['s1', 's2']);
  assert.deepEqual(singleChatSessionsOf(sessions, 'b').map(item => item.id), ['s3']);
  assert.deepEqual(singleChatSessionsOf(sessions, ''), []);
});

test('worldMemoryIssue：内置助手 / 多会话 / 无会话各有问题码，唯一会话为正常', () => {
  assert.equal(worldMemoryIssue({ builtin: true }, 1), 'builtin');
  assert.equal(worldMemoryIssue({}, 2), 'multi');
  assert.equal(worldMemoryIssue({}, 0), 'orphan');
  assert.equal(worldMemoryIssue({}, 1), '');
});

test('buildMemoryCheckup：摊开两层记忆，问题条目排前', () => {
  const report = buildMemoryCheckup({
    sessions: [
      { id: 's1', characterId: 'ok', type: 'single' },
      { id: 's2', characterId: 'multi', type: 'single' },
      { id: 's3', characterId: 'multi', type: 'single' },
      { id: 'g1', type: 'group' },
    ],
    characters: [
      { id: 'ok', name: '正常角色', worldInfo: [memoryEntry('a')] },
      {
        id: 'multi',
        name: '多会话角色',
        worldInfo: [memoryEntry('b'), memoryEntry('c', { comment: '记忆总结 2' })],
      },
      { id: 'gone', name: '无会话角色', worldInfo: [memoryEntry('d')] },
      { id: 'default', name: '助手', builtin: true, worldInfo: [memoryEntry('e')] },
      { id: 'clean', name: '无记忆角色', worldInfo: [{ comment: '普通条目', content: 'x' }] },
    ],
  });

  assert.equal(report.totalSessions, 4);
  assert.equal(report.singleSessions, 3);
  assert.equal(report.groupSessions, 1);
  // 无记忆条目的角色不进表
  assert.equal(report.worldEntries.some(item => item.characterId === 'clean'), false);
  assert.equal(report.worldEntries.length, 4);
  // 有问题的排前面（4 个角色里 3 个有问题）
  assert.equal(report.issues.length, 3);
  assert.deepEqual(report.issues.map(item => item.issue).sort(), ['builtin', 'multi', 'orphan']);
  assert.equal(report.healthy, false);
  assert.equal(report.worldActiveTotal, 5);

  const okEntry = report.worldEntries.find(item => item.characterId === 'ok');
  assert.equal(okEntry.issue, '', '唯一会话且 boundary 命中的条目 = 正常');
  assert.equal(okEntry.sessionCount, 1);
});

test('buildMemoryCheckup：已停用条目只计数不算问题；全正常时 healthy', () => {
  const report = buildMemoryCheckup({
    sessions: [{ id: 's1', characterId: 'a', type: 'single' }],
    characters: [{
      id: 'a',
      name: '甲',
      worldInfo: [memoryEntry('a'), memoryEntry('b', { enabled: false, stale: true })],
    }],
  });
  assert.equal(report.healthy, true);
  assert.equal(report.issues.length, 0);
  assert.equal(report.worldActiveTotal, 1);
  assert.equal(report.worldRetiredTotal, 1);
  const entry = report.worldEntries[0];
  assert.equal(entry.retiredCount, 1);
  assert.equal(entry.issue, '', '停用条目不再构成问题');
});

test('buildMemoryCheckup：summaryStats 原样透传，缺省为 null', () => {
  const report = buildMemoryCheckup({ sessions: [], characters: [] });
  assert.equal(report.summaryStats, null);
  const withStats = buildMemoryCheckup({
    sessions: [],
    characters: [],
    summaryStats: { status: 'ok', withSummaries: 2, summariesCount: 5 },
  });
  assert.equal(withStats.summaryStats.summariesCount, 5);
});
