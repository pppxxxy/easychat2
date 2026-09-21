import { runWebSearch } from './webSearch';

export const TRIGGER_KEYWORDS = [
  '最新', '今天', '今日', '现在', '当前', '新闻', '时事', '热点',
  '股价', '股票', '天气', '汇率', '比赛', '发布会', '政策', '实时', '最近',
];

const SEARCH_COOLDOWN_MS = 30000;
const lastSearchAt = new Map();
const reportedFailures = new Set();

export function hasTrigger(userText, keywords = TRIGGER_KEYWORDS) {
  const text = String(userText || '');
  if (!text) return false;
  const list = Array.isArray(keywords) && keywords.length ? keywords : TRIGGER_KEYWORDS;
  return list.some(keyword => text.includes(keyword));
}

export function formatContext(results, now = Date.now()) {
  if (!Array.isArray(results) || results.length === 0) return '';
  const date = new Date(now);
  const pad = number => String(number).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const lines = results.map((item, index) => {
    const link = item.url || item.link || '';
    const parts = [`${index + 1}. ${item.title || '未命名结果'}`];
    if (link) parts.push(`来源：${link}`);
    if (item.snippet) parts.push(`摘要：${item.snippet}`);
    return parts.join('\n');
  });
  return `[背景资料（联网搜索 ${stamp}）]\n${lines.join('\n\n')}`;
}

export function shouldSearch({ userText, plugin, sessionId, now = Date.now() }) {
  if (!plugin || plugin.enabled !== true) return false;
  if (plugin.type !== 'web-search') return false;
  if (!hasTrigger(userText)) return false;
  const last = lastSearchAt.get(sessionId) || 0;
  return (now - last) >= SEARCH_COOLDOWN_MS;
}

export async function runPlugins({ userText, plugins, sessionId, now = Date.now(), onError }) {
  const list = Array.isArray(plugins) ? plugins : [];
  for (const plugin of list) {
    if (!shouldSearch({ userText, plugin, sessionId, now })) continue;
    try {
      const results = await runWebSearch({
        query: userText,
        config: plugin.config,
        maxResults: plugin.config && plugin.config.maxResults,
      });
      lastSearchAt.set(sessionId, Date.now());
      return formatContext(results, Date.now());
    } catch (error) {
      lastSearchAt.set(sessionId, Date.now());
      // 静默失败最误导人：用户以为联网搜索开着，其实一直在失败。
      // 每个会话只上报一次，避免每条消息都打扰。
      const failureKey = String(sessionId || '');
      if (typeof onError === 'function' && !reportedFailures.has(failureKey)) {
        reportedFailures.add(failureKey);
        onError(error);
      }
      return '';
    }
  }
  return '';
}

export function resetSearchCooldown() {
  lastSearchAt.clear();
}
