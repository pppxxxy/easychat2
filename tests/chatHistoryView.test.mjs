// 工作区会话历史的检索与排序（workspace/chatHistoryView.js）——纯函数行为测试。
// 背景：历史面板此前只能滚动（无搜索、排序固定为存储层的最近更新）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_SORT_MODES,
  DEFAULT_CHAT_SORT,
  buildChatHistoryView,
  chatMessageCount,
  chatPreview,
  filterChats,
  sortChats,
} from '../src/workspace/chatHistoryView.js';

const chat = (id, { title = '', updatedAt = 0, createdAt = 0, archived = false, texts = [] } = {}) => ({
  id,
  title,
  updatedAt,
  createdAt,
  archived,
  messages: texts.map(content => ({ content })),
});

test('chatPreview：取末条消息首行；无消息/坏输入给空串', () => {
  assert.equal(chatPreview(chat('a', { texts: ['第一句', '最后一句\n第二行'] })), '最后一句');
  assert.equal(chatPreview(chat('a', { texts: [] })), '');
  assert.equal(chatPreview({ id: 'a' }), '', 'messages 缺失不抛');
  assert.equal(chatPreview(null), '');
  // 兼容 text 字段（历史消息形态）
  assert.equal(chatPreview({ id: 'a', messages: [{ text: '旧形态' }] }), '旧形态');
});

test('chatMessageCount：缺 messages 记 0（原实现直接 .length 会抛）', () => {
  assert.equal(chatMessageCount(chat('a', { texts: ['x', 'y'] })), 2);
  assert.equal(chatMessageCount({ id: 'a' }), 0);
  assert.equal(chatMessageCount(null), 0);
});

test('filterChats：归档视图与主视图互斥', () => {
  const list = [
    chat('a', { title: '甲', texts: ['一'] }),
    chat('b', { title: '乙', archived: true, texts: ['二'] }),
  ];
  assert.deepEqual(filterChats(list).map(c => c.id), ['a']);
  assert.deepEqual(filterChats(list, { archived: true }).map(c => c.id), ['b']);
});

test('filterChats：关键词匹配标题与预览（用户记得的常是「那句话」而不是标题）', () => {
  const list = [
    chat('a', { title: '重构登录', texts: ['把 token 刷新抽出来'] }),
    chat('b', { title: '写周报', texts: ['本周完成三件事'] }),
  ];
  assert.deepEqual(filterChats(list, { query: '登录' }).map(c => c.id), ['a'], '命中标题');
  assert.deepEqual(filterChats(list, { query: 'token' }).map(c => c.id), ['a'], '命中预览');
  assert.deepEqual(filterChats(list, { query: '周报' }).map(c => c.id), ['b']);
  // 大小写不敏感 + 前后空白忽略
  assert.deepEqual(filterChats(list, { query: '  TOKEN  ' }).map(c => c.id), ['a']);
  assert.deepEqual(filterChats(list, { query: '不存在的词' }), []);
  assert.deepEqual(filterChats(list, { query: '' }).length, 2, '空查询 = 不过滤');
  assert.deepEqual(filterChats(null, { query: 'x' }), []);
});

test('sortChats：updated / created 两种时间序，默认 updated', () => {
  assert.deepEqual(CHAT_SORT_MODES, ['updated', 'created']);
  assert.equal(DEFAULT_CHAT_SORT, 'updated');
  const list = [
    chat('old', { updatedAt: 100, createdAt: 100 }),
    chat('new', { updatedAt: 300, createdAt: 200 }),
    chat('mid', { updatedAt: 200, createdAt: 300 }),
  ];
  assert.deepEqual(sortChats(list).map(c => c.id), ['new', 'mid', 'old'], '默认按最近更新');
  assert.deepEqual(sortChats(list, 'created').map(c => c.id), ['mid', 'new', 'old'], '按最近创建');
  // 未知模式回落到默认，而不是原样返回（否则界面传错值时顺序会「看起来没生效」）
  assert.deepEqual(sortChats(list, 'nonsense').map(c => c.id), ['new', 'mid', 'old']);
});

test('sortChats：同值时有稳定兜底（否则列表会在重渲染时跳动）', () => {
  const list = [
    chat('b', { updatedAt: 100, createdAt: 5 }),
    chat('a', { updatedAt: 100, createdAt: 9 }),
    chat('c', { updatedAt: 100, createdAt: 5 }),
  ];
  // 主键同值 → 比次键（createdAt 大的在前）
  assert.deepEqual(sortChats(list).map(c => c.id), ['a', 'b', 'c']);
  // 主次都同值 → 用 id 兜底，顺序确定
  const same = [chat('b', { updatedAt: 1, createdAt: 1 }), chat('a', { updatedAt: 1, createdAt: 1 })];
  assert.deepEqual(sortChats(same).map(c => c.id), ['a', 'b']);
  assert.deepEqual(sortChats(same).map(c => c.id), ['a', 'b'], '两次调用结果一致');
});

test('sortChats：不改入参（React 依赖不可变更新）', () => {
  const list = [chat('a', { updatedAt: 1 }), chat('b', { updatedAt: 2 })];
  const snapshot = list.map(item => item.id);
  const sorted = sortChats(list);
  assert.deepEqual(list.map(item => item.id), snapshot, '入参顺序未变');
  assert.notEqual(sorted, list, '返回新数组');
});

test('buildChatHistoryView：过滤 + 排序一次算完', () => {
  const list = [
    chat('a', { title: '登录重构', updatedAt: 100, texts: ['token'] }),
    chat('b', { title: '登录埋点', updatedAt: 300, texts: ['事件'] }),
    chat('c', { title: '周报', updatedAt: 200, archived: true, texts: ['登录相关'] }),
  ];
  assert.deepEqual(buildChatHistoryView(list).map(x => x.id), ['b', 'a']);
  assert.deepEqual(buildChatHistoryView(list, { query: '登录' }).map(x => x.id), ['b', 'a'],
    '归档会话不参与主视图，即使命中关键词');
  assert.deepEqual(buildChatHistoryView(list, { archived: true, query: '登录' }).map(x => x.id), ['c']);
  assert.deepEqual(buildChatHistoryView(list, { sort: 'created' }).map(x => x.id), ['b', 'a'],
    'createdAt 都为 0 时用次键 updatedAt 兜底');
});
