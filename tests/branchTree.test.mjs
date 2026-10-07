// 对话树 / 分支回溯纯逻辑测试（P1）。行为测试：import 真实现直接跑。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  branchFromTail,
  buildBranchDescriptor,
  createBranchId,
  findDuplicateBranch,
  groupBranchesByFork,
  planCheckout,
  sameMessageSequence,
} from '../src/chat/branchTree.js';

const msg = (id, role, text, timestamp = 0) => ({ id, role, text, timestamp });

test('branchFromTail：切出分叉点之后的尾段，forkMessageId 为保留段最后一条', () => {
  const messages = [msg('a', 'user', '1', 1), msg('b', 'assistant', '2', 2), msg('c', 'user', '3', 3)];
  const plan = branchFromTail(messages, 1);
  assert.deepEqual(plan.kept.map(m => m.id), ['a']);
  assert.deepEqual(plan.tail.map(m => m.id), ['b', 'c']);
  assert.equal(plan.forkMessageId, 'a');
});

test('branchFromTail：从会话最前分叉时 forkMessageId 为空串', () => {
  const plan = branchFromTail([msg('a', 'user', '1'), msg('b', 'assistant', '2')], 0);
  assert.deepEqual(plan.kept, []);
  assert.equal(plan.forkMessageId, '');
  assert.deepEqual(plan.tail.map(m => m.id), ['a', 'b']);
});

test('branchFromTail：空尾段返回 null（不建空分支）', () => {
  assert.equal(branchFromTail([msg('a', 'user', '1')], 1), null);
  assert.equal(branchFromTail([], 0), null);
});

test('buildBranchDescriptor：只含轻量字段，preview 取最后一条可展示文本', () => {
  const descriptor = buildBranchDescriptor('branch-1', 'a', [msg('b', 'assistant', '剧情一'), msg('c', 'assistant', '剧情二')], 1234);
  assert.equal(descriptor.id, 'branch-1');
  assert.equal(descriptor.forkMessageId, 'a');
  assert.equal(descriptor.messageCount, 2);
  assert.equal(descriptor.preview, '剧情二');
  assert.equal(descriptor.createdAt, 1234);
  assert.equal('messages' in descriptor, false);
});

test('planCheckout：替换为分叉点及其之前 + 目标分支尾段', () => {
  const active = [msg('a', 'user', '1'), msg('b', 'assistant', '旧'), msg('c', 'assistant', '旧2')];
  const branch = { id: 'br', forkMessageId: 'a', messages: [msg('x', 'assistant', '新')] };
  const plan = planCheckout(active, branch);
  assert.equal(plan.stale, false);
  assert.deepEqual(plan.prefix.map(m => m.id), ['a']);
  assert.deepEqual(plan.activated.map(m => m.id), ['x']);
  assert.deepEqual(plan.removedTail.map(m => m.id), ['b', 'c']);
});

test('planCheckout：forkMessageId 为空串时 prefix 为空', () => {
  const plan = planCheckout([msg('a', 'user', '1')], { id: 'br', forkMessageId: '', messages: [msg('x', 'assistant', '新')] });
  assert.equal(plan.stale, false);
  assert.deepEqual(plan.prefix, []);
  assert.deepEqual(plan.removedTail.map(m => m.id), ['a']);
});

test('planCheckout：分叉点不在活动时间线上返回 stale', () => {
  const plan = planCheckout([msg('a', 'user', '1')], { id: 'br', forkMessageId: 'gone', messages: [] });
  assert.equal(plan.stale, true);
});

test('groupBranchesByFork：按分叉点分组计数', () => {
  const map = groupBranchesByFork([
    { id: '1', forkMessageId: 'a' },
    { id: '2', forkMessageId: 'a' },
    { id: '3', forkMessageId: '' },
  ]);
  assert.equal(map.get('a').length, 2);
  assert.equal(map.get('').length, 1);
  assert.equal(groupBranchesByFork([]).size, 0);
});

test('sameMessageSequence / findDuplicateBranch：内容一致才算重复', () => {
  const tail = [msg('b', 'assistant', '剧情', 10)];
  assert.equal(sameMessageSequence(tail, [{ ...tail[0] }]), true);
  assert.equal(sameMessageSequence(tail, [msg('b', 'assistant', '改过', 10)]), false);
  assert.equal(sameMessageSequence(tail, []), false);
  const dup = findDuplicateBranch(
    [{ descriptor: { id: 'old' }, messages: [{ ...tail[0] }] }],
    tail
  );
  assert.equal(dup.id, 'old');
  assert.equal(findDuplicateBranch([], tail), null);
});

test('createBranchId：注入 random 时结果确定且带 branch- 前缀', () => {
  assert.equal(createBranchId(100, () => 0), 'branch-100-0');
  assert.match(createBranchId(100), /^branch-100-/);
});
