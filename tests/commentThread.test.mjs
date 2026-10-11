// 动态评论线程化：解析「回复<名字>：」前缀 + 把扁平评论排成「顶层 + 一层回复」。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countDirectReplies,
  flattenCommentThread,
  parseCommentReplyTarget,
} from '../src/moments/commentThread.js';

const comment = (id, name, text, extra = {}) => ({ id, name, text, by: 'character', ...extra });

test('解析回复前缀：名字对得上时挂到那条评论下，并把前缀从正文里去掉', () => {
  const comments = [comment('c1', '宵宫', '在吗'), comment('c2', '镜流', '我也在')];
  assert.deepEqual(
    parseCommentReplyTarget('回复宵宫：好呀', comments),
    { text: '好呀', replyToId: 'c1' }
  );
  assert.deepEqual(
    parseCommentReplyTarget('@镜流 说得对', comments),
    { text: '说得对', replyToId: 'c2' }
  );
  assert.deepEqual(
    parseCommentReplyTarget('回复宵宫 好呀', comments),
    { text: '好呀', replyToId: 'c1' }
  );
});

test('解析回复前缀：名字对不上/同名取最后一条/无前缀都按顶层处理', () => {
  const comments = [comment('c1', '宵宫', '在吗'), comment('c2', '宵宫', '再说一句')];
  // 名字不存在：剥掉前缀但仍是顶层，避免指向不存在的评论
  assert.deepEqual(
    parseCommentReplyTarget('回复不存在的人：你好', comments),
    { text: '你好', replyToId: '' }
  );
  // 同名取最后一条
  assert.deepEqual(
    parseCommentReplyTarget('回复宵宫：嗯', comments),
    { text: '嗯', replyToId: 'c2' }
  );
  // 没有前缀：原样
  assert.deepEqual(
    parseCommentReplyTarget('今天天气不错', comments),
    { text: '今天天气不错', replyToId: '' }
  );
  // 「回复：」是普通前缀（normalizeMomentReply 负责剥），不算回复目标
  assert.deepEqual(
    parseCommentReplyTarget('回复：好的', comments),
    { text: '回复：好的', replyToId: '' }
  );
  assert.deepEqual(parseCommentReplyTarget('', comments), { text: '', replyToId: '' });
  assert.deepEqual(parseCommentReplyTarget(null, comments), { text: '', replyToId: '' });
});

test('线程展开：默认全是顶层，replyToId 指向已有评论时缩进一层并带上被回复人', () => {
  const comments = [
    comment('c1', '宵宫', '第一条'),
    comment('c2', '镜流', '第二条'),
    comment('c3', '慕魅', '接宵宫的', { replyToId: 'c1' }),
  ];
  const rows = flattenCommentThread(comments);
  assert.deepEqual(rows.map(row => [row.comment.id, row.depth, row.parentName]), [
    ['c1', 0, ''],
    ['c3', 1, '宵宫'],
    ['c2', 0, ''],
  ]);
});

test('线程展开：回复的回复挂到同一个顶层祖先下，标记写直接回复的人', () => {
  const comments = [
    comment('c1', '宵宫', '顶层'),
    comment('c2', '镜流', '接宵宫', { replyToId: 'c1' }),
    comment('c3', '慕魅', '接镜流', { replyToId: 'c2' }),
  ];
  const rows = flattenCommentThread(comments);
  assert.deepEqual(rows.map(row => [row.comment.id, row.depth, row.parentName]), [
    ['c1', 0, ''],
    ['c2', 1, '宵宫'],
    ['c3', 1, '镜流'],
  ]);
});

test('线程展开：悬空引用、自引用、互指环都不隐藏评论', () => {
  const orphan = flattenCommentThread([
    comment('c1', '宵宫', '顶层'),
    comment('c2', '镜流', '父评论已删', { replyToId: 'gone' }),
  ]);
  assert.deepEqual(orphan.map(row => [row.comment.id, row.depth]), [['c1', 0], ['c2', 0]]);

  const selfRef = flattenCommentThread([comment('c1', '宵宫', '自指', { replyToId: 'c1' })]);
  assert.deepEqual(selfRef.map(row => [row.comment.id, row.depth]), [['c1', 0]]);

  const cycle = flattenCommentThread([
    comment('c1', '宵宫', 'a', { replyToId: 'c2' }),
    comment('c2', '镜流', 'b', { replyToId: 'c1' }),
  ]);
  assert.deepEqual(cycle.map(row => [row.comment.id, row.depth]), [['c1', 0], ['c2', 0]]);
});

test('线程展开：空输入与非法项安全返回', () => {
  assert.deepEqual(flattenCommentThread(null), []);
  assert.deepEqual(flattenCommentThread([null, {}, { id: '' }]), []);
});

test('直接回复计数：只数直接挂在它下面的', () => {
  const comments = [
    comment('c1', '宵宫', '顶层'),
    comment('c2', '镜流', 'a', { replyToId: 'c1' }),
    comment('c3', '慕魅', 'b', { replyToId: 'c2' }),
  ];
  assert.equal(countDirectReplies(comments, 'c1'), 1);
  assert.equal(countDirectReplies(comments, 'c2'), 1);
  assert.equal(countDirectReplies(comments, 'c3'), 0);
  assert.equal(countDirectReplies(comments, ''), 0);
  assert.equal(countDirectReplies(null, 'c1'), 0);
});
