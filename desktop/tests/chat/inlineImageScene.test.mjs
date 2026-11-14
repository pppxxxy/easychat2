// 共享层「场景转写」编排（imageGen/inlineImagePrompt.resolveInlineImageSceneText）测试。
//
// 这段逻辑原本是 ChatScreen 的 useCallback（靠页面 refs），桌面要实现自动配图就得抄一遍。
// 抽成参数注入的纯编排后，两端调同一函数——本测试就是它的行为契约。
//
// 钉住四件事：
//   1. 关闭智能增强时直接用「回复段落原文」，不调模型（省一次请求）；
//   2. 开启时用上一条用户消息作上下文，产出清洗后的画面描述；
//   3. 空回复占位 / 模型抛错 / 中途取消 ⇒ 一律退回原文，不打断配图；
//   4. 位置语义（start/middle/end）与共享层 selectReplySegment 一致。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findPreviousUserText,
  resolveInlineImageSceneText,
  selectReplySegment,
} from '../../../src/imageGen/inlineImagePrompt.js';

const REPLY = '第一段。\n\n第二段是高潮。\n\n第三段结尾。';

test('关闭智能增强：直接用对应位置的原文，不调用模型', async () => {
  let called = 0;
  const scene = await resolveInlineImageSceneText({
    replyText: REPLY,
    settings: { enhance: false, imagePosition: 'end' },
    sendScene: async () => { called += 1; return '不该被调用'; },
  });
  assert.equal(called, 0, '关闭增强时不得发模型请求');
  assert.equal(scene, selectReplySegment(REPLY, 'end'));
});

test('位置语义：start/middle/end 取不同段落', async () => {
  const read = position => resolveInlineImageSceneText({
    replyText: REPLY,
    settings: { enhance: false, imagePosition: position },
  });
  assert.equal(await read('start'), '第一段。');
  assert.equal(await read('middle'), '第二段是高潮。');
  assert.equal(await read('end'), '第三段结尾。');
});

test('开启智能增强：带上一条用户消息，产出清洗后的描述', async () => {
  const calls = [];
  const scene = await resolveInlineImageSceneText({
    replyText: REPLY,
    settings: { enhance: true, imagePosition: 'middle' },
    messageId: 'a1',
    messages: [
      { id: 'u1', role: 'user', text: '我们去看海吧' },
      { id: 'a1', role: 'assistant', text: REPLY },
    ],
    charName: '小林',
    userName: '我',
    sendScene: async ({ prompt }) => {
      calls.push(prompt);
      // 模型常见的「画面前缀 + 引号」都要被清洗掉。
      return '画面：「小林站在海边望着远处，海风吹起她的头发。」';
    },
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('我们去看海吧'), '提示词应带上一条用户消息作上下文');
  assert.ok(calls[0].includes('第二段是高潮。'), '提示词应带上选中的段落');
  // 前缀与引号被剥掉，且不是原文。
  assert.equal(scene, '小林站在海边望着远处，海风吹起她的头发。');
  assert.notEqual(scene, selectReplySegment(REPLY, 'middle'));
});

test('空回复占位 / 模型抛错 / 已取消 ⇒ 一律退回原文', async () => {
  const base = {
    replyText: REPLY,
    settings: { enhance: true, imagePosition: 'end' },
    emptyReplyText: '[无回复]',
  };
  const fallback = selectReplySegment(REPLY, 'end');

  assert.equal(await resolveInlineImageSceneText({
    ...base,
    sendScene: async () => '[无回复]',
  }), fallback, '空回复占位应退回原文');

  assert.equal(await resolveInlineImageSceneText({
    ...base,
    sendScene: async () => { throw new Error('boom'); },
  }), fallback, '模型失败应退回原文（配图是增值步骤）');

  // 已取消：返回原文而不是抛。
  const controller = new AbortController();
  const cancelled = resolveInlineImageSceneText({
    ...base,
    signal: controller.signal,
    sendScene: async () => {
      controller.abort();
      return '取消前的输出';
    },
  });
  assert.equal(await cancelled, fallback, '取消后应退回原文');
});

test('没注入 sendScene 时等同关闭增强（桌面/测试都不必提供模型）', async () => {
  const scene = await resolveInlineImageSceneText({
    replyText: REPLY,
    settings: { enhance: true, imagePosition: 'start' },
  });
  assert.equal(scene, '第一段。');
});

test('findPreviousUserText：只找目标消息之前最近的用户消息', () => {
  const messages = [
    { id: 'u1', role: 'user', text: '早' },
    { id: 'a1', role: 'assistant', text: '早呀' },
    { id: 'u2', role: 'user', text: '  晚上吃什么  ' },
    { id: 'a2', role: 'assistant', text: '随便' },
    { id: 'u3', role: 'user', text: '之后的' },
  ];
  // 目标 a2：应取 u2（而不是 u3，也不是更早的 u1）。
  assert.equal(findPreviousUserText(messages, 'a2'), '晚上吃什么');
  // 找不到目标 id 时退化为「整个列表里最后一条用户消息」。
  assert.equal(findPreviousUserText(messages, 'missing'), '之后的');
  // 空列表 / 非数组都安全。
  assert.equal(findPreviousUserText(null, 'x'), '');
});