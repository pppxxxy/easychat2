// 段落评论与「接话」链路的源码断言（与 musicComments.test.mjs 同一套回归点）：
// - 评论走 buildRequestMessages + sendChatMessage(stream:false) 且带配置切换守卫；
// - 评论摘录来自「当前页」的行文本（pageText），带块号与锚文本，方便回溯位置；
// - 接话先 ensureCharacterSession 再 setPendingQuote + navigate('聊天')，
//   payload.id 为空（评论不是会话内消息，点引用块不定位）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localeSource } from './helpers/localeSource.mjs';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

// 剥掉注释再断言：源码注释里会**引用旧写法**（如 `.catch(() => {})`）说明「为什么改」，
// 不剥就会把解释文字当成代码命中。
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
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

test('useBookComments：读失败必须暴露给面板，不得吞成「还没有评论」', () => {
  const source = readSource('src/books/useBookComments.js');
  const code = stripComments(source);
  // 以前是 `.catch(() => {})`：读失败被演成「空列表」，面板显示「还没有评论」，
  // 用户以为评论丢了（数据其实还在存储里）。
  assert.equal(/\.catch\(\(\) => \{\}\)/.test(code), false, '读失败不得再被空 catch 吞掉');
  assert.ok(source.includes('commentsReadFailed'), '读路径失败要有独立错误态');
  assert.ok(source.includes('commentsError'), 'hook 要把读失败透出给面板');
  assert.ok(source.includes("t('books.comments.readFailed')"), '读失败文案与「生成失败」分开（不是 API 配置问题）');
  assert.ok(source.includes('error: error || commentsError'), '读失败要并进面板唯一读取的 error 通道才看得见');
  assert.ok(source.includes('if (commentsReadFailed) return loadComments()'),
    '重试要按失败类型走对分支（读失败 → 重新读盘）');

  // 语义必须是「数据还在，只是读不到」：读失败只标记错误，**不清空**已装载的评论。
  const loader = /const loadComments = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(source);
  assert.ok(loader, '读路径必须收口在 loadComments 一处');
  assert.ok(loader[1].includes('catch'), '必须显式接住读失败');
  assert.ok(loader[1].includes('setCommentsReadFailed(true)'), '读失败要如实标记');
  assert.equal(loader[1].includes('setComments([])'), false, '读失败不得清空列表（读不到 ≠ 没有）');

  // 错误条与「还没有评论」**不得同时出现**：错误条写着「评论还在，只是这次没读出来」，
  // 紧接一行「还没有评论」会把那句话当场取消掉（两句互相矛盾，闭环等于被抹平）。
  const panel = stripComments(readSource('src/books/BookReaderView.js'));
  assert.ok(/comments\.length === 0 && !generating && !commentError/.test(panel),
    '读失败时不得再渲染「还没有评论」');

  const zh = localeSource('src/i18n/locales/zh-CN');
  const en = localeSource('src/i18n/locales/en');
  assert.ok(zh.includes("'books.comments.readFailed'") && en.includes("'books.comments.readFailed'"),
    '读失败文案中英齐备');
});

test('BookReaderView：页面摘录与接话接线', () => {
  const source = readSource('src/books/BookReaderView.js');
  assert.ok(source.includes('pageText(reader.lines, reader.page'), '评论摘录必须取当前页行文本');
  assert.ok(source.includes('blockIndex: reader.blockIndex') && source.includes('anchorText'),
    '请求必须带位置（块号+锚文本）');
  assert.ok(source.includes('ensureCharacterSession'), '接话前必须确保该角色会话存在');
  assert.ok(source.includes('navigation.navigate(ROUTE_NAMES.chat)'), '接话切到聊天页（路由名走常量）');
  // 两个生成入口都要在，且文案里带的是具体角色名（原来是一句「让TA聊聊这一页」）
  assert.ok(/t\('books\.comments\.generate',\s*\{\s*character:/.test(source),
    '本页入口存在且带角色名');
  assert.ok(/t\('books\.comments\.generateChapter',\s*\{\s*character:/.test(source),
    '整章入口存在且带角色名');
  assert.ok(source.includes('handleCommentChapter'), '整章评论按当前章取摘录');
  assert.ok(source.includes('setShowComments(false)'), '接话离开前关闭评论面板');
});

test('AppContext 消费端一致性（与听歌共用 pendingQuote）', () => {
  const chat = readSource('src/ChatScreen.js');
  assert.ok(chat.includes('pendingQuote.sessionId !== activeSessionId'),
    '聊天页按 sessionId 戳消费，两个面板共用同一机制');
  const context = readSource('src/context/AppContext.js');
  assert.ok(context.includes('setPendingQuote') && context.includes('consumePendingQuote'));
});
