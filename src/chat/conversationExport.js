// 对话导出纯逻辑：把当前会话消息转成人类可读的导出内容。
// 三种出口共用同一套「可导出消息 → 条目」提取：长图（ShareCard 渲染 entries）、
// Markdown、HTML。不依赖 RN / 存储，可在 Node 直测。
// 文件写出与截图在 UI/存储层（ConversationExportModal / storage/chatExport.js）。

import { messageCopyText } from './plainText.js';
import { maskSecrets } from '../storage/secrets.js';

// 单次导出的消息上限：长图渲染会占内存，超长会话取最近 N 条并提示已截断。
export const EXPORT_MAX_MESSAGES = 300;

const MEDIA_PLACEHOLDER = {
  sticker: '【表情包】',
  video: '【视频】',
  image: '【图片】',
  voice: '【语音】',
};

// 可导出消息：user/assistant 的已提交消息。pending（生成中占位）与 transient
// （工具状态等临时气泡）不落导出（需求 5.1）。
export function isExportableMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.pending || message.transient) return false;
  return message.role === 'user' || message.role === 'assistant';
}

// 取最近 max 条可导出消息；truncated 为 true 时 omitted 是被丢弃的更早条数。
export function collectExportMessages(messages, { max = EXPORT_MAX_MESSAGES } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter(isExportableMessage);
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : EXPORT_MAX_MESSAGES;
  if (list.length <= limit) return { messages: list, truncated: false, omitted: 0 };
  return {
    messages: list.slice(list.length - limit),
    truncated: true,
    omitted: list.length - limit,
  };
}

// 单条消息的可读正文：有正文取纯文本（富 HTML 转纯文本）；无正文按媒体类型给占位。
export function messageBodyText(message) {
  const raw = message && message.text;
  const text = raw ? messageCopyText(raw).trim() : '';
  if (text) return text;
  const kind = message && message.kind;
  if (message && message.audio) return MEDIA_PLACEHOLDER.voice;
  if (message && message.image) {
    const stickerName = String(message.image.stickerName || '').trim();
    if (kind === 'sticker' || message.image.stickerId) {
      return stickerName ? `【表情包：${stickerName}】` : MEDIA_PLACEHOLDER.sticker;
    }
    if (kind === 'video') return MEDIA_PLACEHOLDER.video;
    return MEDIA_PLACEHOLDER.image;
  }
  return '';
}

// 说话人展示名：用户→用户名；角色/群成员→speakerName 或角色名。
export function messageSpeaker(message, { userName = '', characterName = '' } = {}) {
  if (message && message.role === 'user') return String(userName || '').trim() || '用户';
  const speaker = String((message && message.speakerName) || '').trim();
  return speaker || String(characterName || '').trim() || 'AI';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

// 时间戳 → `YYYY-MM-DD HH:mm`；非法/缺失返回空串。
export function formatExportTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// 构建导出条目：{ role, speaker, time, body }。正文与说话人均脱敏（需求 5.4）。
export function buildExportEntries(messages, meta = {}) {
  const { userName = '', characterName = '' } = meta;
  return (Array.isArray(messages) ? messages : [])
    .filter(isExportableMessage)
    .map(message => ({
      role: message.role,
      speaker: maskSecrets(messageSpeaker(message, { userName, characterName })),
      time: formatExportTime(message.timestamp),
      body: maskSecrets(messageBodyText(message)),
    }))
    .filter(entry => entry.body);
}

function escapeHtml(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeMeta(meta = {}) {
  return {
    title: maskSecrets(String(meta.title || '').trim()) || '对话记录',
    exportedAt: String(meta.exportedAt || '').trim(),
    truncated: meta.truncated === true,
    omitted: Number(meta.omitted) || 0,
    count: Number(meta.count) || 0,
  };
}

// 导出为 Markdown 文本。
export function toMarkdown(entries, meta = {}) {
  const info = normalizeMeta(meta);
  const lines = [`# ${info.title}`, ''];
  lines.push(`> 导出时间：${info.exportedAt}`);
  lines.push(`> 共 ${info.count} 条消息${info.truncated ? `（已截断，省略更早 ${info.omitted} 条）` : ''}`);
  lines.push('');
  (Array.isArray(entries) ? entries : []).forEach(entry => {
    const head = [entry.speaker, entry.time].filter(Boolean).join(' · ');
    lines.push(`**${head}**`);
    lines.push('');
    lines.push(entry.body);
    lines.push('');
    lines.push('---');
    lines.push('');
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// 导出为自包含 HTML：内容全部转义，气泡排版内联，可直接在浏览器打开。
export function toHtml(entries, meta = {}) {
  const info = normalizeMeta(meta);
  const rows = (Array.isArray(entries) ? entries : []).map(entry => {
    const isUser = entry.role === 'user';
    const meta2 = [entry.speaker, entry.time].filter(Boolean).map(escapeHtml).join(' · ');
    return `
      <div class="row ${isUser ? 'right' : 'left'}">
        <div class="bubble ${isUser ? 'bubble-user' : 'bubble-assistant'}">
          <div class="meta">${meta2}</div>
          <div class="body">${escapeHtml(entry.body).replace(/\n/g, '<br/>')}</div>
        </div>
      </div>`;
  }).join('');
  const truncNote = info.truncated
    ? `<span class="trunc">已截断，省略更早 ${info.omitted} 条</span>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(info.title)}</title>
<style>
  body { margin: 0; background: #1a1a2e; color: #ffffff; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8a8aa3; font-size: 13px; margin-bottom: 20px; }
  .trunc { margin-left: 8px; color: #f2c14e; }
  .row { display: flex; margin: 12px 0; }
  .row.right { justify-content: flex-end; }
  .row.left { justify-content: flex-start; }
  .bubble { max-width: 78%; padding: 10px 12px; border-radius: 14px; }
  .bubble-user { background: #6c63ff; color: #ffffff; }
  .bubble-assistant { background: #2d2d44; color: #ffffff; }
  .meta { font-size: 11px; opacity: 0.7; margin-bottom: 4px; }
  .body { font-size: 15px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(info.title)}</h1>
    <div class="sub">导出时间：${escapeHtml(info.exportedAt)} · 共 ${info.count} 条消息${truncNote}</div>
    ${rows}
  </div>
</body>
</html>
`;
}

// 文件名净化：去掉路径分隔与非法字符，压缩空白，限制长度。
export function sanitizeFileName(name, fallback = 'chat') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60)
    .trim();
  return cleaned || fallback;
}

// 导出文件名：`<标题>-<日期时间>.<ext>`。
export function exportFileName(meta = {}, ext = 'txt') {
  const info = normalizeMeta(meta);
  const stamp = String(info.exportedAt || '').replace(/[^0-9]/g, '').slice(0, 12) || 'export';
  return `${sanitizeFileName(info.title, 'chat')}-${stamp}.${String(ext || 'txt').replace(/[^a-z0-9]/gi, '')}`;
}
