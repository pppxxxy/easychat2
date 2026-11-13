// messageDeletionPlan 的行为测试（纯逻辑）。
//
// 每条断言都对应一个真实后果：
//   · 删光全部消息却按普通删除处理 → 开场白选择没重置，下次进会话又回到「未选开场白」，
//     发送被共享层闸门静默拦下（与 S12 修的故障同源）；
//   · 连续尾段不归档 → 整段对话删掉后无法回溯，属于数据不可逆；
//   · 向量索引按会话清与按 id 清搞反 → 残留索引让已删内容继续被召回。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deletionConfirmBodyKey,
  planMessageDeletion,
} from '../../src/chat/messageDeletionPlan.js';

const m = (id, role = 'user') => ({ id, role, text: id });

test('planMessageDeletion：空输入返回 null（不做任何事）', () => {
  assert.equal(planMessageDeletion([], []), null);
  assert.equal(planMessageDeletion([m('a')], []), null);
  assert.equal(planMessageDeletion([], ['x']), null);
});

test('删光全部消息 ⇒ clearsAll 且向量按会话清、确认文案用 allBody', () => {
  const list = [m('a'), m('b')];
  const plan = planMessageDeletion(list, ['a', 'b']);
  assert.equal(plan.clearsAll, true);
  assert.deepEqual(plan.remaining, []);
  assert.deepEqual(plan.vector, { mode: 'session' });
  assert.equal(deletionConfirmBodyKey(plan), 'chat.deleteMessages.allBody');
  // 全删也是「连续到尾」的一整段：必须归档成分支（否则不可回溯）。
  assert.ok(plan.archive, '删光时应把整段归档');
  assert.equal(plan.archive.messages.length, 2);
  assert.equal(plan.archive.forkMessageId, '', '删到开头时没有分叉点');
});

test('删除中间一条 ⇒ 普通删除、向量按 id 清、不建分支', () => {
  const list = [m('a'), m('b'), m('c')];
  const plan = planMessageDeletion(list, ['b']);
  assert.equal(plan.clearsAll, false);
  assert.deepEqual(plan.remaining.map(item => item.id), ['a', 'c']);
  assert.deepEqual(plan.vector, { mode: 'messages', ids: ['b'] });
  assert.equal(deletionConfirmBodyKey(plan), 'chat.deleteMessages.body');
  assert.equal(plan.archive, null, '非连续尾段不建分支');
});

test('删除末尾连续两条 ⇒ 归档尾段并带分叉点', () => {
  const list = [m('a'), m('b'), m('c'), m('d')];
  const plan = planMessageDeletion(list, ['c', 'd']);
  assert.equal(plan.clearsAll, false);
  assert.ok(plan.archive);
  assert.equal(plan.archive.forkMessageId, 'b');
  assert.deepEqual(plan.archive.messages.map(item => item.id), ['c', 'd']);
});

test('删末尾但中间有洞（不连续）⇒ 不归档', () => {
  const list = [m('a'), m('b'), m('c'), m('d')];
  const plan = planMessageDeletion(list, ['b', 'd']);
  assert.equal(plan.archive, null, '跳着删不是「连续尾段」，不应建分支');
  assert.deepEqual(plan.remaining.map(item => item.id), ['a', 'c']);
});

test('不修改入参（调用方直接拿 messagesRef 传入）', () => {
  const list = [m('a'), m('b')];
  const snapshot = JSON.stringify(list);
  planMessageDeletion(list, ['a']);
  assert.equal(JSON.stringify(list), snapshot);
});