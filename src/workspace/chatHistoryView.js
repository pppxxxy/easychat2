// 工作区会话历史的**检索与排序**（纯函数，Node 可直测）。
//
// 背景：历史面板此前只能滚动——没有搜索，排序也固定成存储层的「最近更新」。
// 会话一多就只能一条条翻（`WorkspaceHistorySheet.js` 原来连预览文本都在渲染里现算）。
//
// 这里把三件事收成一处：
//   1) `chatPreview`——列表上那一行预览（末条消息首行）。过滤要用它、渲染也要用它，
//      两处各算一遍迟早会漂移（搜得到的和看到的不一致）。
//   2) `filterChats`——归档视图 + 关键词过滤。关键词匹配**标题与预览**，因为用户记得的
//      往往是「那句话」而不是标题。
//   3) `sortChats`——排序。只提供两种**基于时间**的顺序：两者都是数字比较，
//      不依赖 `localeCompare` 的 ICU 数据（Hermes 上中文按码位排，给用户看会像乱序，
//      宁可不提供「按标题排」这种看起来有、实际不可靠的选项）。

export const CHAT_SORT_MODES = ['updated', 'created'];
export const DEFAULT_CHAT_SORT = 'updated';

function messageText(message) {
  if (!message) return '';
  const value = message.content != null ? message.content : message.text;
  return String(value == null ? '' : value);
}

// 末条消息的首行，作为列表预览。
export function chatPreview(chat) {
  const messages = Array.isArray(chat && chat.messages) ? chat.messages : [];
  if (messages.length === 0) return '';
  return messageText(messages[messages.length - 1]).split('\n')[0].trim();
}

export function chatMessageCount(chat) {
  return (Array.isArray(chat && chat.messages) ? chat.messages : []).length;
}

function normalizeQuery(query) {
  return String(query == null ? '' : query).trim().toLowerCase();
}

// 归档视图 + 关键词过滤。返回新数组，不改入参。
export function filterChats(chats, { query = '', archived = false } = {}) {
  const list = Array.isArray(chats) ? chats.filter(Boolean) : [];
  const inView = list.filter(chat => (archived ? chat.archived === true : chat.archived !== true));
  const needle = normalizeQuery(query);
  if (!needle) return inView;
  return inView.filter(chat => {
    const title = String(chat.title || '').toLowerCase();
    if (title.includes(needle)) return true;
    return chatPreview(chat).toLowerCase().includes(needle);
  });
}

// 排序：两种时间序，都带稳定的兜底比较（同值时用另一个时间、再用 id），
// 保证同一份数据每次渲染的顺序一致——否则列表会在重渲染时跳动。
export function sortChats(chats, mode = DEFAULT_CHAT_SORT) {
  const list = Array.isArray(chats) ? chats.filter(Boolean).slice() : [];
  const key = CHAT_SORT_MODES.includes(mode) ? mode : DEFAULT_CHAT_SORT;
  const primary = key === 'created' ? 'createdAt' : 'updatedAt';
  const secondary = key === 'created' ? 'updatedAt' : 'createdAt';
  return list.sort((a, b) => {
    const diff = (Number(b[primary]) || 0) - (Number(a[primary]) || 0);
    if (diff !== 0) return diff;
    const tie = (Number(b[secondary]) || 0) - (Number(a[secondary]) || 0);
    if (tie !== 0) return tie;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

// 面板一次算完：过滤 → 排序。界面只渲染结果。
export function buildChatHistoryView(chats, { query = '', archived = false, sort = DEFAULT_CHAT_SORT } = {}) {
  return sortChats(filterChats(chats, { query, archived }), sort);
}
