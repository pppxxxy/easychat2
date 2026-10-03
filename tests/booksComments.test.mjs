// 段落评论与「接话」链路的源码断言（与 musicComments.test.mjs 同一套回归点）：
// - 评论走 buildRequestMessages + sendChatMessage(stream:false) 且带配置切换守卫；
// - 评论摘录来自「当前页」的行文本（pageText），带块号与锚文本，方便回溯位置；
// - 接话先 ensureCharacterSession 再 setPendingQuote + navigate('聊天')，
//   payload.id 为空（评论不是会话内消息，点引用块不定位）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('useBookComments：评论链路与守卫齐全', () => {
  const source = readSource('src/books/useBookComments.js');
  assert.ok(source.includes('buildRequestMessages'), '复用与聊天同口径的消息组装');
  assert.ok(/stream:\s*false/.test(source), '评论一次性生成，不流式');
  assert.ok(source.includes('expectedConfigId') && source.includes('expectedConfigFingerprint'),
    '必须带配置切换守卫');
  assert.ok(source.includes('appendBookComment') && source.includes('getBookComments'),
    '评论落库/读取走 comments.js 分键');
  assert.ok(source.includes('buildPassageCommentPrompt'), 'prompt 走 commentPrompts 纯函数');
  assert.ok(source.includes('EMPTY_REPLY_TEXT'), '空响应占位文本必须按失败处理');
  assert.ok(/if \(!currentBook \|\| generatingRef\.current\) return false/.test(source),
    '生成必须串行（在途时跳过）');
});

test('BookReaderView：页面摘录与接话接线', () => {
  const source = readSource('src/books/BookReaderView.js');
  assert.ok(source.includes('pageText(reader.lines, reader.page'), '评论摘录必须取当前页行文本');
  assert.ok(source.includes('blockIndex: reader.blockIndex') && source.includes('anchorText'),
    '请求必须带位置（块号+锚文本）');
  assert.ok(source.includes('ensureCharacterSession'), '接话前必须确保该角色会话存在');
  assert.ok(source.includes("navigation.navigate('聊天')"), '接话切到聊天页');
  assert.ok(source.includes('让TA聊聊这一页'), '生成入口存在');
  assert.ok(source.includes('setShowComments(false)'), '接话离开前关闭评论面板');
});

test('AppContext 消费端一致性（与听歌共用 pendingQuote）', () => {
  const chat = readSource('src/ChatScreen.js');
  assert.ok(chat.includes('pendingQuote.sessionId !== activeSessionId'),
    '聊天页按 sessionId 戳消费，两个面板共用同一机制');
  const context = readSource('src/context/AppContext.js');
  assert.ok(context.includes('setPendingQuote') && context.includes('consumePendingQuote'));
});
