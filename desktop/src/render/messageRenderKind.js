// 消息 → 渲染分支的判定（纯函数，Node 可测）。
//
// 口径与 Android 端 MessageBubble 对齐：
//   · 用户消息纯文本（不跑 Markdown，保持换行原文）；
//   · 助手消息含 HTML 标签走 iframe，其余走 Markdown；
//   · 错误气泡走独立样式，媒体消息走媒体组件。
import { containsHtml } from '../../../src/chat/plainText.js';

export const RENDER_KIND = Object.freeze({
  EMPTY: 'empty',
  PENDING: 'pending',
  PLAIN: 'plain',
  MARKDOWN: 'markdown',
  HTML: 'html',
  MEDIA: 'media',
  ERROR: 'error',
});

export function resolveMessageRenderKind(message) {
  if (!message || typeof message !== 'object') return RENDER_KIND.EMPTY;
  if (message.role === 'system-error') return RENDER_KIND.ERROR;
  if (message.image) return RENDER_KIND.MEDIA;
  const text = String(message.text || '');
  if (!text.trim()) {
    return message.pending ? RENDER_KIND.PENDING : RENDER_KIND.EMPTY;
  }
  if (message.role === 'user') return RENDER_KIND.PLAIN;
  if (containsHtml(text)) return RENDER_KIND.HTML;
  return RENDER_KIND.MARKDOWN;
}

export default resolveMessageRenderKind;
