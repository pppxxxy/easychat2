// 长程上下文模式 + 一键回滚（差距 #5）——纯逻辑行为测试。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LONG_HORIZON_PRESET,
  resolveLongHorizonPolicy,
  shouldSuggestLongHorizon,
} from '../src/chat/longHorizon.js';
import {
  planRewind,
  rewindMessages,
  rewindCode,
  rewindSession,
} from '../src/workspace/gitRewind.js';
import { buildCheckpointMessage } from '../src/workspace/gitCheckpoint.js';

const MESSAGES = [
  { id: 'u1', role: 'user', content: '第一轮问题' },
  { id: 'a1', role: 'assistant', content: '第一轮回答' },
  { id: 'u2', role: 'user', content: '第二轮问题' },
  { id: 'a2', role: 'assistant', content: '第二轮回答' },
];

test('longHorizon：未开启原样透传；开启抬到长程档', () => {
  const off = resolveLongHorizonPolicy({ enabled: false, base: { autoCompactRatio: 0.85, compactHintRatio: 0.7, keepRecent: 6 } });
  assert.deepEqual(off, { autoCompactRatio: 0.85, compactHintRatio: 0.7, keepRecent: 6, longHorizon: false });
  const on = resolveLongHorizonPolicy({ enabled: true, base: { autoCompactRatio: 0.85, compactHintRatio: 0.7, keepRecent: 6 } });
  assert.equal(on.autoCompactRatio, LONG_HORIZON_PRESET.autoCompactRatio);
  assert.equal(on.compactHintRatio, LONG_HORIZON_PRESET.compactHintRatio);
  assert.equal(on.keepRecent, LONG_HORIZON_PRESET.keepRecent);
  assert.equal(on.longHorizon, true);
  // 已有更高值时不降级
  const higher = resolveLongHorizonPolicy({ enabled: true, base: { autoCompactRatio: 0.99, compactHintRatio: 0.9, keepRecent: 20 } });
  assert.equal(higher.autoCompactRatio, 0.99);
  assert.equal(higher.keepRecent, 20);
});

test('longHorizon：缺省 base 用默认口径；大窗口建议开启', () => {
  const def = resolveLongHorizonPolicy({});
  assert.equal(def.autoCompactRatio, 0.85);
  assert.equal(shouldSuggestLongHorizon(1000000), true);
  assert.equal(shouldSuggestLongHorizon(200000), false);
});

test('planRewind：定位并切分，取出该轮用户请求', () => {
  const plan = planRewind(MESSAGES, { messageId: 'u2' });
  assert.equal(plan.ok, true);
  assert.equal(plan.index, 2);
  assert.deepEqual(plan.keep.map(m => m.id), ['u1', 'a1']);
  assert.deepEqual(plan.dropped.map(m => m.id), ['u2', 'a2']);
  assert.equal(plan.turnRequest, '第二轮问题');
});

test('planRewind：找不到 id / 空 id', () => {
  assert.equal(planRewind(MESSAGES, { messageId: 'zzz' }).ok, false);
  assert.equal(planRewind(MESSAGES, { messageId: 'zzz' }).reason, 'not-found');
  assert.equal(planRewind(MESSAGES, {}).reason, 'no-id');
});

test('rewindMessages：返回截断后的列表且不改动入参', () => {
  const kept = rewindMessages(MESSAGES, { messageId: 'u2' });
  assert.deepEqual(kept.map(m => m.id), ['u1', 'a1']);
  assert.equal(MESSAGES.length, 4);
});

// 假 git 句柄：log 返回「本轮提交 + 父提交」，changedInCommit 给一个文件。
function fakeGit({ hasParent = true, paths = ['src/a.js'] } = {}) {
  const calls = [];
  const commits = [
    { oid: 'c2', message: buildCheckpointMessage('第二轮问题') },
    ...(hasParent ? [{ oid: 'c1', message: buildCheckpointMessage('第一轮问题') }] : []),
  ];
  const handle = {
    async isRepo() { return true; },
    async log() { return commits; },
    async changedInCommit() { return paths.map(path => ({ path, status: 'modified' })); },
    async restorePathsFrom(oid, list) { calls.push(['restore', oid, list]); return { restored: list.length, removed: 0 }; },
    async commitAll(message) { calls.push(['commit', message]); return 'c3'; },
  };
  return { git: { open: () => handle }, calls };
}

test('rewindCode：按提交说明匹配本轮检查点并恢复其父提交', async () => {
  const { git, calls } = fakeGit();
  const result = await rewindCode({ git, request: '第二轮问题' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.paths, ['src/a.js']);
  assert.deepEqual(calls[0], ['restore', 'c1', ['src/a.js']]);
  assert.match(calls[1][1], /^回滚：/);
});

test('rewindCode：无检查点 / 无父提交 / 无 git', async () => {
  const none = await rewindCode({ git: fakeGit().git, request: '不存在的请求' });
  assert.equal(none.reason, 'no-checkpoint');
  const noParent = await rewindCode({ git: fakeGit({ hasParent: false }).git, request: '第二轮问题' });
  assert.equal(noParent.reason, 'no-parent');
  assert.equal((await rewindCode({ git: null })).reason, 'no-git');
  const noChange = await rewindCode({ git: fakeGit({ paths: [] }).git, request: '第二轮问题' });
  assert.equal(noChange.reason, 'no-change');
});

test('rewindSession：对话截断 + 代码回滚组合', async () => {
  const { git } = fakeGit();
  const result = await rewindSession({ messages: MESSAGES, messageId: 'u2', git, characterId: 'c' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.messages.map(m => m.id), ['u1', 'a1']);
  assert.equal(result.code.ok, true);
  // 无 git 时只截断对话
  const noGit = await rewindSession({ messages: MESSAGES, messageId: 'u2' });
  assert.equal(noGit.ok, true);
  assert.equal(noGit.code, null);
  // 找不到消息
  const bad = await rewindSession({ messages: MESSAGES, messageId: 'zzz' });
  assert.equal(bad.ok, false);
});
