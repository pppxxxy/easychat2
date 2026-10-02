import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutoSummaryInput,
  buildReplyErrorMessage,
  classifyReplyError,
  mergeErrorMessage,
  mergeStreamedReasoning,
  mergeStreamedText,
  replacePendingWithReply,
  trimHistoryByBoundary,
} from '../src/chat/replyFlow.js';
import { SYSTEM_ERROR_ID } from '../src/chat/chatConstants.js';

const pending = id => ({
  id,
  role: 'assistant',
  text: '正在思考...',
  reasoning: '',
  pending: true,
  waitingForResponse: true,
});

test('trimHistoryByBoundary：boundary 之后为已发送原文，sentIds 与裁剪一致', () => {
  const history = [
    { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
  ];
  const { trimmedHistory, sentIds } = trimHistoryByBoundary(history, 'b');
  assert.deepEqual(trimmedHistory.map(item => item.id), ['c', 'd']);
  assert.deepEqual([...sentIds].sort(), ['c', 'd']);
  // 无 boundary：全量保留
  const full = trimHistoryByBoundary(history, null);
  assert.equal(full.trimmedHistory.length, 4);
  assert.deepEqual([...full.sentIds].sort(), ['a', 'b', 'c', 'd']);
  // boundary 不在列表中：全量保留（findIndex 为 -1）
  const missing = trimHistoryByBoundary(history, 'zz');
  assert.equal(missing.trimmedHistory.length, 4);
  // 非数组入参兜底
  assert.deepEqual(trimHistoryByBoundary(null, 'b').trimmedHistory, []);
});

test('mergeStreamedText：只更新 pending 占位符并落地 waitingForResponse', () => {
  const p = pending('x');
  const other = { id: 'y', pending: true, text: 'old', waitingForResponse: true };
  const next = mergeStreamedText([other, p, { id: 'z', text: 'done', pending: false }], 'x', '第一段');
  assert.equal(next[0], other, '非目标消息原引用返回');
  assert.deepEqual(
    { ...next[1] },
    { id: 'x', role: 'assistant', text: '第一段', reasoning: '', pending: true, waitingForResponse: false }
  );
  // 已完成（非 pending）的消息不被改写
  assert.equal(next[2].text, 'done');
  // null 入参兜底
  assert.deepEqual(mergeStreamedText(null, 'x', 't'), []);
});

test('mergeStreamedReasoning：不检查 pending，占位符期间持续覆写', () => {
  const p = pending('x');
  const next = mergeStreamedReasoning([p], 'x', '思考中……');
  assert.equal(next[0].reasoning, '思考中……');
  assert.equal(next[0].pending, true, 'reasoning 更新不改 pending');
  // 非 pending 的消息也能被 reasoning 更新（与原实现一致）
  const done = { id: 'd', reasoning: '', pending: false };
  assert.equal(mergeStreamedReasoning([done], 'd', 'r')[0].reasoning, 'r');
});

test('replacePendingWithReply：分段替换占位符；空回复落「没有收到回复。」', () => {
  const p = pending('x');
  const before = [{ id: 'u', text: 'hi' }, p, { id: 'a2', text: 'earlier' }];
  const parts = [
    { role: 'assistant', id: 'r1', text: '你好' },
    { role: 'assistant', id: 'r2', kind: 'sticker', text: '' },
  ];
  const next = replacePendingWithReply(before, 'x', parts);
  assert.equal(next.length, 4);
  assert.equal(next[1].id, 'r1');
  assert.equal(next[1].pending, false);
  assert.equal(next[1].waitingForResponse, false);
  assert.equal(next[2].id, 'r2');
  assert.equal(next[3].text, 'earlier');
  // 空回复
  const empty = replacePendingWithReply(before, 'x', []);
  assert.equal(empty[1].text, '没有收到回复。');
  assert.equal(empty[1].pending, false);
  // replyParts 非数组按空处理
  const nullParts = replacePendingWithReply(before, 'x', null);
  assert.equal(nullParts[1].text, '没有收到回复。');
  // 未命中占位符：仍返回新数组（保持原重渲染节奏），内容不变
  const miss = replacePendingWithReply(before, 'nope', parts);
  assert.notEqual(miss, before);
  assert.deepEqual(miss.map(i => i.id), before.map(i => i.id));
});

test('classifyReplyError：配置变更 / 取消 / 真失败 三分类（判定器注入）', () => {
  // 判定器由调用方注入（api.js 的实现依据 message 常量 / canceled / AbortError），
  // 这里以内联等价实现验证分类路由本身。
  const isConfigChangedError = error => !!error && error.message === '模型来源已切换，请重新发送';
  const isCanceledError = error => !!error && (error.canceled === true || error.name === 'AbortError');
  assert.equal(classifyReplyError({ message: '模型来源已切换，请重新发送' }, isConfigChangedError, isCanceledError), 'config-changed');
  assert.equal(classifyReplyError({ canceled: true }, isConfigChangedError, isCanceledError), 'canceled');
  assert.equal(classifyReplyError({ name: 'AbortError' }, isConfigChangedError, isCanceledError), 'canceled');
  assert.equal(classifyReplyError(new Error('普通错误'), isConfigChangedError, isCanceledError), 'failure');
  assert.equal(classifyReplyError(null, isConfigChangedError, isCanceledError), 'failure');
  // 未注入判定器时按真失败处理（防御）
  assert.equal(classifyReplyError({ canceled: true }), 'failure');
});

test('buildReplyErrorMessage：气泡 id/role/脱敏 detail 与 rawText 透传', () => {
  const err = new Error('密钥 sk-abc1234567890 已泄露');
  const { message, rawText } = buildReplyErrorMessage('p1', err);
  assert.equal(message.id, 'p1-error');
  assert.equal(message.role, SYSTEM_ERROR_ID);
  assert.equal(message.text, '请求失败，点击查看详情');
  assert.ok(typeof message.timestamp === 'number');
  // rawText 是未脱敏原文，detail 是脱敏产物（可能等值，但必须是字符串）
  assert.ok(typeof rawText === 'string');
  assert.ok(typeof message.detail === 'string');
});

test('mergeErrorMessage：有部分内容则追加，否则整条替换', () => {
  const p = pending('x');
  const errBubble = { id: 'x-error', role: 'system_error', text: '请求失败，点击查看详情' };
  // 占位符仍被 settle 保留（有部分正文）→ 追加
  const partial = [{ id: 'u' }, { ...p, text: '已经生成的一半', waitingForResponse: false }];
  const appended = mergeErrorMessage(partial, 'x', errBubble);
  assert.equal(appended.length, 3);
  assert.equal(appended[1].id, 'x');
  assert.equal(appended[1].pending, false);
  assert.equal(appended[2].id, 'x-error');
  // 占位符无内容（settle 后被移除）→ 整条替换
  const bare = [{ id: 'u' }, p];
  const replaced = mergeErrorMessage(bare, 'x', errBubble);
  assert.equal(replaced.length, 2);
  assert.equal(replaced[1].id, 'x-error');
  assert.equal(replaced[1].role, 'system_error');
});

test('buildAutoSummaryInput：空回复以「没有收到回复。」参与摘要', () => {
  const p = pending('x');
  const base = [{ id: 'u', text: 'hi' }];
  const withParts = buildAutoSummaryInput(base, [{ role: 'assistant', id: 'r1', text: '答' }], p);
  assert.deepEqual(withParts.map(i => i.id), ['u', 'r1']);
  const withEmpty = buildAutoSummaryInput(base, [], p);
  assert.equal(withEmpty[1].text, '没有收到回复。');
  assert.equal(withEmpty[1].pending, false);
});
