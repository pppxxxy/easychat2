// 时间感知：把当前时间格式化成人/模型可读的一行文本。
// 纯函数，便于单测；JS 聊天与主动消息共用同一格式，避免两处漂移。

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function pad(value) {
  return String(value).padStart(2, '0');
}

// 返回形如「2026-09-30 周三 15:04」的本地时间文本；非法日期返回空串。
export function formatCurrentTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const week = WEEKDAYS[d.getDay()] || '';
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `${y}-${m}-${day} 周${week} ${hh}:${mm}`;
}

// 组装注入系统提示的时间行；timeAware 关闭或无有效时间时返回空串。
export function buildTimeAwareText(enabled, date = new Date()) {
  if (!enabled) return '';
  const text = formatCurrentTime(date);
  return text ? `[当前时间] ${text}` : '';
}
