// 记忆体检（Phase 4）纯函数测试：报告结构、问题判定、排序。
// 判定口径必须与 memoryRetire（启动对账）一致，否则会出现「体检说正常、对账在悄悄改」。
// 唯一会话角色还多一个条件：条目 boundary 必须属于那个会话——所以这里显式传消息 id。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildMemoryCheckup,
  singleChatSessionsOf,
  worldMemoryIssue,
} from '../src/memory/checkup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

test('worldMemoryIssue：内置助手 / 多会话 / 无会话各有问题码，唯一会话要 boundary 命中才算正常', () => {
  assert.equal(worldMemoryIssue({ builtin: true }, 1), 'builtin');
  assert.equal(worldMemoryIssue({}, 2), 'multi');
  assert.equal(worldMemoryIssue({}, 0), 'orphan');
  // 唯一会话这一档以前只断言 ''（正常），但代码里根本没有 boundary 比较——断言描述的是
  // 一个不存在的行为。这里补上真的边界比对（与 planWorldMemoryRetire 同口径）。
  const character = { worldInfo: [memoryEntry('a', { boundary: 'm1' })] };
  assert.equal(worldMemoryIssue(character, 1, new Set(['m1', 'm2'])), '', 'boundary 命中该会话 = 正常');
  assert.equal(worldMemoryIssue(character, 1, new Set(['m2'])), 'boundary', 'boundary 不在该会话 = 会被对账退休');
  assert.equal(worldMemoryIssue(character, 1, new Set()), 'boundary', '会话里没有消息 = boundary 不可能命中');
  // 读不出消息（null / 根本没传）= 无法判定，绝不显示为正常。
  assert.equal(worldMemoryIssue(character, 1), 'unknown');
  assert.equal(worldMemoryIssue(character, 1, null), 'unknown');
});

test('buildMemoryCheckup：摊开两层记忆，问题条目排前', () => {
  const report = buildMemoryCheckup({
    sessions: [
      { id: 's1', characterId: 'ok', type: 'single' },
      { id: 's2', characterId: 'multi', type: 'single' },
      { id: 's3', characterId: 'multi', type: 'single' },
      { id: 's4', characterId: 'stale', type: 'single' },
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
      // 唯一会话，但 boundary 指向的消息不在这个会话里（消息被删 / 跨卡流通的残留）：
      // 启动对账会把它 enabled:false，体检必须同口径，不能给绿勾。
      { id: 'stale', name: '边界失效角色', worldInfo: [memoryEntry('f', { boundary: 'm9' })] },
      { id: 'clean', name: '无记忆角色', worldInfo: [{ comment: '普通条目', content: 'x' }] },
    ],
    // 只有「恰好 1 个单聊会话」的角色需要消息 id：ok 命中，stale 不命中。
    messageIdsByCharacter: new Map([
      ['ok', new Set(['m1'])],
      ['stale', new Set(['m1'])],
    ]),
  });

  assert.equal(report.totalSessions, 5);
  assert.equal(report.singleSessions, 4);
  assert.equal(report.groupSessions, 1);
  // 无记忆条目的角色不进表
  assert.equal(report.worldEntries.some(item => item.characterId === 'clean'), false);
  assert.equal(report.worldEntries.length, 5);
  // 有问题的排前面（5 个角色里 4 个有问题）
  assert.equal(report.issues.length, 4);
  assert.deepEqual(report.issues.map(item => item.issue).sort(), ['boundary', 'builtin', 'multi', 'orphan']);
  assert.equal(report.healthy, false);
  assert.equal(report.worldActiveTotal, 6);

  const okEntry = report.worldEntries.find(item => item.characterId === 'ok');
  assert.equal(okEntry.issue, '', '唯一会话且 boundary 命中该会话的条目 = 正常');
  assert.equal(okEntry.sessionCount, 1);
  const staleEntry = report.worldEntries.find(item => item.characterId === 'stale');
  assert.equal(staleEntry.issue, 'boundary', '唯一会话但 boundary 不属于它 = 下次启动会被对账退休');
});

test('buildMemoryCheckup：唯一会话但消息读不出来 → issue=unknown，未知不当健康', () => {
  const base = {
    sessions: [{ id: 's1', characterId: 'a', type: 'single' }],
    characters: [{ id: 'a', name: '甲', worldInfo: [memoryEntry('a')] }],
  };
  // Map 里显式 null = 读盘失败（corrupt）
  const failed = buildMemoryCheckup({ ...base, messageIdsByCharacter: new Map([['a', null]]) });
  assert.equal(failed.worldEntries[0].issue, 'unknown');
  assert.equal(failed.healthy, false);
  // 完全不传 Map 也是同一结论：缺省不猜健康
  const noData = buildMemoryCheckup(base);
  assert.equal(noData.worldEntries[0].issue, 'unknown', '没读到消息就不能显示绿勾');
});

test('buildMemoryCheckup：已停用条目只计数不算问题；全正常时 healthy', () => {
  const report = buildMemoryCheckup({
    sessions: [{ id: 's1', characterId: 'a', type: 'single' }],
    characters: [{
      id: 'a',
      name: '甲',
      worldInfo: [memoryEntry('a'), memoryEntry('b', { enabled: false, stale: true })],
    }],
    messageIdsByCharacter: new Map([['a', new Set(['m1'])]]),
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

// P2-7 的守卫：singleChatSessionsOf 在 memory/checkup.js 与 storage/memoryOwnership.js
// 里曾逐字重复（连注释都一样），两处互不 import。任一侧改掉 type 判定或 characterId
// 归一规则，体检与启动对账就会变成两套标准——正是本文件头要防的事。
// 允许（且期望）的终局是 memoryOwnership.js 改为 import checkup.js 的实现；
// 在那之前，这条测试保证两份实现不会各自漂移。
test('singleChatSessionsOf：与 storage/memoryOwnership.js 不许各自漂移', () => {
  const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');
  const checkupSrc = read('src/memory/checkup.js');
  const ownershipSrc = read('src/storage/memoryOwnership.js');
  if (ownershipSrc.includes("from '../memory/checkup.js'")) return; // 已统一，无需比对
  const bodyOf = source => {
    const start = source.indexOf('export function singleChatSessionsOf');
    if (start < 0) return '';
    return source.slice(start, source.indexOf('\n}', start));
  };
  assert.equal(
    bodyOf(ownershipSrc),
    bodyOf(checkupSrc),
    '两处 singleChatSessionsOf 已不一致：请把 storage/memoryOwnership.js 改成从 '
    + '../memory/checkup.js 导入（单一实现），不要各改各的'
  );
});

// 弹层接线守卫（项目无 React 渲染器，UI 层按既有约定用源码锚点验证，见
// memoryProvenanceUi.test.mjs）：钉住这一批修的三件事——
//   P0-2 摘要读失败不能被当成「没有摘要」（partial 状态）；
//   P1-4 boundary 判定要真的读消息、读不出来记 unknown；
//   P1-5 清理只动面板列出的角色（逐角色 characterId），不做全库对账。
test('体检弹层：partial 状态、逐角色清理、unknown 不参与清理', () => {
  const modal = readFileSync(path.join(HERE, '..', 'src/memory/MemoryCheckupModal.js'), 'utf8');
  assert.ok(modal.includes("status: failedSessions > 0 ? 'partial' : 'ok'"));
  assert.ok(modal.includes("summaryStats.status === 'partial'"));
  assert.ok(modal.includes("t('memory.checkup.sessions.partial'"));
  // 摘要读失败（corrupt）要真的被记进 failedSessions，而不是只认 'ok'
  assert.ok(modal.includes("status.status === 'corrupt'"));
  assert.ok(modal.includes("status.status === 'missing' && String(target.summarizedUpTo || '')"));
  // 清理必须逐角色（characterId），不能全库对账
  assert.ok(modal.includes('reconcileWorldMemories({ characterId: item.characterId })'));
  assert.ok(!modal.includes('reconcileWorldMemories()'), '不得再做全库对账（会停用未列出的条目）');
  assert.ok(modal.includes("item.issue !== 'unknown'"), 'unknown 不参与清理');
  // boundary 判定要读消息（与 memoryOwnership.planRetireForCharacter 同口径）
  assert.ok(modal.includes('getMessagesBySessionStatus('));
  assert.ok(modal.includes('messageIdsByCharacter'));
});
