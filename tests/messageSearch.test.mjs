// 聊天消息检索（chat/messageSearch.js）——纯函数行为测试。
// 背景：工作区聊天面板此前没有搜索，消息一多只能一路滚。
import test from 'node:test';
import assert from 'node:assert/strict';

import { messageSearchText, searchChatMessages } from '../src/chat/messageSearch.js';

const msg = (id, content, extra = {}) => ({ id, role: 'user', content, at: 0, ...extra });

test('messageSearchText：认 content / text / 多模态数组三种形态；认不出给空串不抛', () => {
  assert.equal(messageSearchText(msg('a', '你好')), '你好');
  assert.equal(messageSearchText({ id: 'b', text: '旧形态' }), '旧形态');
  // content 优先于 text（展示消息以 content 为准）
  assert.equal(messageSearchText({ content: '新', text: '旧' }), '新');
  // 多模态数组：只取文本片段，图片对象不进搜索文本
  assert.equal(
    messageSearchText({ content: [{ type: 'text', text: '看图' }, { type: 'image', url: 'x' }, '裸串'] }),
    '看图 裸串'
  );
  assert.equal(messageSearchText(null), '');
  assert.equal(messageSearchText('nope'), '');
  assert.equal(messageSearchText({}), '');
});

test('searchChatMessages：空查询不返回结果（界面该显示正常消息流，不是全量平铺）', () => {
  const list = [msg('a', '一'), msg('b', '二')];
  assert.deepEqual(searchChatMessages(list, ''), { matches: [], total: 0, truncated: false });
  assert.deepEqual(searchChatMessages(list, '   '), { matches: [], total: 0, truncated: false });
  assert.deepEqual(searchChatMessages(list, null), { matches: [], total: 0, truncated: false });
  assert.deepEqual(searchChatMessages(null, 'x'), { matches: [], total: 0, truncated: false });
});

test('searchChatMessages：大小写不敏感；命中带 index（要能定位回那条消息）', () => {
  const list = [msg('a', 'Hello World'), msg('b', '无关'), msg('c', 'hello again')];
  const { matches, total } = searchChatMessages(list, 'HELLO');
  assert.equal(total, 2);
  // 倒序：最近的在最前
  assert.deepEqual(matches.map(m => m.id), ['c', 'a']);
  assert.deepEqual(matches.map(m => m.index), [2, 0]);
  assert.equal(matches[0].role, 'user');
});

test('searchChatMessages：预览折叠空白并截断（长消息不能把结果行撑爆）', () => {
  const long = `开头\n\n${'x'.repeat(200)}`;
  const { matches } = searchChatMessages([msg('a', long)], '开头');
  assert.ok(matches[0].preview.startsWith('开头 x'));
  assert.ok(matches[0].preview.length <= 60);
  assert.ok(matches[0].preview.endsWith('…'));
});

test('searchChatMessages：多模态消息的文本片段可被搜到', () => {
  const list = [{ id: 'a', role: 'user', content: [{ type: 'text', text: '这张图里的报错' }] }];
  assert.equal(searchChatMessages(list, '报错').total, 1);
  // 图片 URL 不该被当成文本搜出来
  assert.equal(searchChatMessages(list, 'http').total, 0);
});

test('searchChatMessages：limit 只截显示，total 报全量；坏 limit 退化为默认', () => {
  const list = Array.from({ length: 12 }, (_, i) => msg(`m${i}`, `含关键词 ${i}`));
  const limited = searchChatMessages(list, '关键词', { limit: 5 });
  assert.equal(limited.matches.length, 5);
  assert.equal(limited.total, 12);
  assert.equal(limited.truncated, true);
  assert.equal(limited.matches[0].id, 'm11', '截的是最旧的，最新的必须还在');
  assert.equal(searchChatMessages(list, '关键词', { limit: 0 }).matches.length, 12);
  assert.equal(searchChatMessages(list, '关键词', { limit: 50 }).truncated, false);
});

test('searchChatMessages：没有文本的消息被跳过（不产生空预览的假命中）', () => {
  const list = [msg('a', ''), { id: 'b', role: 'assistant' }, msg('c', '有字')];
  const { matches, total } = searchChatMessages(list, '有字');
  assert.equal(total, 1);
  assert.equal(matches[0].id, 'c');
  // 空消息不会因为 needle 为空串的 includes 而误命中
  assert.equal(searchChatMessages(list, ' ').total, 0);
});
