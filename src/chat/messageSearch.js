// 聊天消息检索（纯函数，Node 可直测）。
//
// 背景：工作区的**聊天面板**里没有搜索——消息一多只能一路滚。会话历史（P2-2）与本地文件
// （P2-3）都已经能搜，只剩消息本身。全仓唯一的搜索框在 GitHub 面板。
//
// 与 `workspace/fileSearch.js` 同构（同样返回 `{matches, total, truncated}`），
// 但对象是消息而不是路径——**命中要能定位回那条消息**，所以带 `index`。

// 消息的可搜文本。形态在不同路径下不一致：
// - 展示消息：`content`（字符串），也可能是多模态的数组（图片 + 文本）；
// - 历史消息：`text`。
// 三条都认，认不出就返回空串（不抛）。
export function messageSearchText(message) {
  if (!message || typeof message !== 'object') return '';
  const raw = message.content != null ? message.content : message.text;
  if (Array.isArray(raw)) {
    return raw
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return String(raw == null ? '' : raw);
}

function preview(text, max = 60) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1))}…`;
}

// 命中：**逐条消息**做不区分大小写的子串匹配。返回倒序（最近的在最前）——
// 找东西时最新的那条通常是想要的。
// 不返回空查询的结果：那时界面该显示正常消息流，而不是「全部消息」的平铺。
export function searchChatMessages(messages, query, { limit = 50 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const needle = String(query == null ? '' : query).trim().toLowerCase();
  if (!needle) return { matches: [], total: 0, truncated: false };

  const hits = [];
  list.forEach((message, index) => {
    const text = messageSearchText(message);
    if (!text) return;
    if (!text.toLowerCase().includes(needle)) return;
    hits.push({
      id: String((message && message.id) || `idx-${index}`),
      index,
      role: String((message && message.role) || ''),
      at: Number(message && message.at) || 0,
      preview: preview(text),
    });
  });

  const parsed = Number(limit);
  const safeLimit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 50;
  const newestFirst = hits.reverse();
  return {
    matches: newestFirst.slice(0, safeLimit),
    total: hits.length,
    truncated: hits.length > safeLimit,
  };
}
