// 动态评论的形状与线程化（桌面侧）。
//
// 为什么需要这条：桌面早先自己编了一个评论形状（author / byUser），而共享层
// commentThread 读的是 name / by / replyToId —— 于是「回复某条评论」会被平铺成
// 两条独立评论，用户看不出谁在答谁，而角色回复也永远挂不到正确的父评论下。
//
// 这里直接对**共享层**的 flattenCommentThread 断言我们写出的形状能被它正确分线程，
// 而不是自己实现一份分组逻辑再对拍（那样两边一起错也测不出来）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { flattenCommentThread, countDirectReplies } from '../../../src/moments/commentThread.js';

// 与 MomentsScreen 写出的形状逐字段一致（改那边必须同步改这里，测试会红）。
const userComment = (id, text, replyToId = '') => ({
  id,
  by: 'user',
  characterId: '',
  name: '我',
  text,
  createdAt: 1,
  likedByCharacter: false,
  replyToId,
});

const characterComment = (id, text, replyToId = '', characterId = 'c1', name = '甲') => ({
  id,
  by: 'character',
  characterId,
  name,
  text,
  createdAt: 2,
  likedByCharacter: false,
  replyToId,
});

test('角色回复挂在我那条评论下：depth=1 且 parentName 是我的名字', () => {
  const list = [userComment('u1', '哈哈'), characterComment('r1', '嗯嗯', 'u1')];
  const flat = flattenCommentThread(list);
  assert.equal(flat.length, 2);
  const reply = flat.find(entry => entry.comment.id === 'r1');
  assert.equal(reply.depth, 1, '回复必须缩进一层');
  assert.equal(reply.parentName, '我', '要能显示「回复谁」');
  // 顶层评论仍是 depth=0。
  assert.equal(flat.find(entry => entry.comment.id === 'u1').depth, 0);
});

test('顶层评论（replyToId 为空）不缩进', () => {
  const flat = flattenCommentThread([userComment('u1', 'a'), userComment('u2', 'b')]);
  assert.equal(flat.filter(entry => entry.depth === 0).length, 2);
});

test('旧形状（author/byUser、无 replyToId）会被当成两条独立顶层评论', () => {
  // 反面证据：这正是修复前的实际表现——回复不会缩进、也看不出答的是谁。
  const legacy = [
    { id: 'a', author: '我', text: 'x', byUser: true },
    { id: 'b', author: '甲', text: 'y', byUser: false },
  ];
  const flat = flattenCommentThread(legacy);
  assert.equal(flat.length, 2);
  assert.equal(flat.every(entry => entry.depth === 0), true);
  // name 读不到 → 界面只能回落兜底名（这条断言解释为什么必须改用 name）。
  assert.equal(flat[0].comment.name, undefined);
});

test('countDirectReplies：只数直接回复，不把孙回复算进去', () => {
  const list = [
    userComment('u1', 'a'),
    characterComment('r1', 'b', 'u1'),
    userComment('u2', 'c', 'r1'),
  ];
  assert.equal(countDirectReplies(list, 'u1'), 1);
  assert.equal(countDirectReplies(list, 'r1'), 1);
  assert.equal(countDirectReplies(list, 'nope'), 0);
});

test('他人回复的回复会归到同一根，但仍是 depth=1（只支持一层）', () => {
  const list = [
    userComment('u1', 'a'),
    characterComment('r1', 'b', 'u1'),
    characterComment('r2', 'c', 'r1'),
  ];
  const flat = flattenCommentThread(list);
  const replies = flat.filter(entry => entry.depth === 1);
  assert.equal(replies.length, 2, '两条回复都归到 u1 之下');
  assert.equal(flat.filter(entry => entry.depth === 0).length, 1);
});
