// 对话导出纯逻辑测试（P1）。行为测试：import 真实现直接跑。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExportEntries,
  collectExportMessages,
  EXPORT_MAX_MESSAGES,
  exportFileName,
  formatExportTime,
  isExportableMessage,
  messageBodyText,
  messageSpeaker,
  sanitizeFileName,
  toHtml,
  toMarkdown,
} from '../src/chat/conversationExport.js';

const msg = (id, role, text, extra = {}) => ({ id, role, text, timestamp: 1700000000000, ...extra });

test('isExportableMessage：仅 user/assistant 且非 pending/transient', () => {
  assert.equal(isExportableMessage(msg('1', 'user', 'hi')), true);
  assert.equal(isExportableMessage(msg('2', 'assistant', 'yo')), true);
  assert.equal(isExportableMessage(msg('3', 'assistant', 'x', { pending: true })), false);
  assert.equal(isExportableMessage(msg('4', 'assistant', 'x', { transient: true })), false);
  assert.equal(isExportableMessage(msg('5', 'system-error', 'x')), false);
  assert.equal(isExportableMessage(null), false);
});

test('collectExportMessages：超上限取最近 N 条并报告截断', () => {
  const messages = Array.from({ length: 5 }, (_, index) => msg(`m${index}`, 'user', `t${index}`));
  const small = collectExportMessages(messages, { max: 3 });
  assert.equal(small.truncated, true);
  assert.equal(small.omitted, 2);
  assert.deepEqual(small.messages.map(m => m.id), ['m2', 'm3', 'm4']);

  const all = collectExportMessages(messages, { max: 10 });
  assert.equal(all.truncated, false);
  assert.equal(all.omitted, 0);
  assert.equal(all.messages.length, 5);
  assert.equal(collectExportMessages([], { max: 3 }).messages.length, 0);
});

test('messageBodyText：正文优先，富文本转纯文本，媒体给占位', () => {
  assert.equal(messageBodyText(msg('1', 'assistant', 'hello')), 'hello');
  assert.equal(messageBodyText(msg('2', 'assistant', '<p>富<b>文本</b></p>')), '富文本');
  assert.equal(messageBodyText(msg('3', 'user', '', { image: { uri: 'a' } })), '【图片】');
  assert.equal(messageBodyText(msg('4', 'user', '', { kind: 'sticker', image: { uri: 'a', stickerName: '猫猫' } })), '【表情包：猫猫】');
  assert.equal(messageBodyText(msg('5', 'user', '', { kind: 'sticker', image: { uri: 'a' } })), '【表情包】');
  assert.equal(messageBodyText(msg('6', 'user', '', { kind: 'video', image: { uri: 'a' } })), '【视频】');
  assert.equal(messageBodyText(msg('7', 'user', '', { audio: { uri: 'a' } })), '【语音】');
});

test('messageSpeaker：用户取用户名，角色取 speakerName/角色名', () => {
  assert.equal(messageSpeaker(msg('1', 'user', 'x'), { userName: '小明' }), '小明');
  assert.equal(messageSpeaker(msg('1', 'user', 'x'), {}), '用户');
  assert.equal(messageSpeaker(msg('2', 'assistant', 'x', { speakerName: 'A' }), { characterName: 'B' }), 'A');
  assert.equal(messageSpeaker(msg('2', 'assistant', 'x'), { characterName: 'B' }), 'B');
  assert.equal(messageSpeaker(msg('2', 'assistant', 'x'), {}), 'AI');
});

test('formatExportTime：合法时间戳格式化，非法返回空串', () => {
  assert.match(formatExportTime(1700000000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatExportTime(0), '');
  assert.equal(formatExportTime('abc'), '');
});

test('buildExportEntries：过滤、映射、媒体占位、脱敏', () => {
  const entries = buildExportEntries([
    msg('1', 'user', 'sk-abcdefgh12345678 你好'),
    msg('2', 'assistant', '回复', { pending: true }),
    msg('3', 'assistant', '收到'),
  ], { userName: '我', characterName: '角色' });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].role, 'user');
  assert.equal(entries[0].speaker, '我');
  assert.ok(entries[0].body.includes('[API_KEY已隐藏]'), '密钥被脱敏');
  assert.equal(entries[1].speaker, '角色');
});

test('toMarkdown：含标题/时间/条数与逐条正文', () => {
  const entries = buildExportEntries([msg('1', 'user', 'hi'), msg('2', 'assistant', 'yo')], { characterName: 'C' });
  const md = toMarkdown(entries, { title: '与 C 的对话', exportedAt: '2026-10-07 12:00', count: 2 });
  assert.ok(md.startsWith('# 与 C 的对话'));
  assert.ok(md.includes('导出时间：2026-10-07 12:00'));
  assert.ok(md.includes('共 2 条消息'));
  assert.ok(md.includes('hi'));
  assert.ok(md.includes('yo'));
  const truncated = toMarkdown(entries, { title: 't', exportedAt: 'x', count: 5, truncated: true, omitted: 3 });
  assert.ok(truncated.includes('省略更早 3 条'));
});

test('toHtml：自包含、内容转义、气泡区分左右', () => {
  const entries = buildExportEntries([
    msg('1', 'user', '5 < 3 & 2 > 1 "引号"'),
    msg('2', 'assistant', '<script>alert(1)</script>'),
  ], { userName: '我', characterName: 'C' });
  const html = toHtml(entries, { title: 'T & T', exportedAt: '2026-10-07', count: 2 });
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('bubble-user'));
  assert.ok(html.includes('bubble-assistant'));
  assert.equal(html.includes('<script>alert(1)</script>'), false, '脚本被剥离');
  assert.ok(html.includes('5 &lt; 3 &amp; 2 &gt; 1'), '特殊字符被转义');
  assert.ok(html.includes('T &amp; T'));
});

test('sanitizeFileName / exportFileName：净化非法字符并带扩展名', () => {
  assert.equal(sanitizeFileName('a/b:c*d?'), 'a b c d');
  assert.equal(sanitizeFileName('   '), 'chat');
  assert.equal(sanitizeFileName('...hidden'), 'hidden');
  const name = exportFileName({ title: '与 C 的对话', exportedAt: '2026-10-07 12:30' }, 'md');
  assert.match(name, /^与 C 的对话-202610071230\.md$/);
});

test('EXPORT_MAX_MESSAGES 为合理正数', () => {
  assert.ok(Number.isInteger(EXPORT_MAX_MESSAGES) && EXPORT_MAX_MESSAGES > 0);
});
