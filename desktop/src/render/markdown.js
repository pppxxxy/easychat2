// 桌面 Markdown 渲染：marked 生成 HTML，再由**本文件自己的 renderer** 收口安全边界。
//
// 为什么不用 DOMPurify：它的运行需要真实 DOM（渲染进程里可以，但 Node 测试里不行），
// 而 marked 的输出完全由 renderer 决定。这里把三条危险通道逐一焊死，产物即安全：
//   1. 原始 HTML（含内联 <img onerror>）由 renderer.html 转义成文本——助手正文里
//      真正的 HTML 消息本来就走沙箱 iframe（见 richHtmlDoc.js），不进这条路径；
//   2. 链接 href 只放行 http/https/mailto/tel，javascript:/data: 等一律降级为纯文本；
//   3. 图片 src 只放行 http/https/data:image/easychat2-media，本地 file:// 先经
//      mediaUrl() 改写成媒体协议（渲染进程 CSP 只允许这个协议）。
// 由于入口只剩「转义后的文本 + 白名单属性」，React 侧可以安全地 innerHTML。
//
// 长度上限复用共享层 clampMarkdownText（防 linkify 类 ReDoS 的既有口径），
// 截断提示由共享层词条给出。
import { Marked } from 'marked';

import { clampMarkdownText } from '../../../src/chat/markdownGuard.js';
import { mediaUrl } from '../platform/mediaUrl.js';

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[&<>"']/g, character => ESCAPE_MAP[character]);
}

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

function normalizeUrl(raw) {
  // 控制字符（含 HTML 里常见的换行/制表）会让 "java\nscript:" 绕过 scheme 判定。
  return String(raw === null || raw === undefined ? '' : raw).replace(/[\u0000-\u0020]+/g, '');
}

function schemeOf(url) {
  const match = url.match(SCHEME_PATTERN);
  return match ? `${match[1].toLowerCase()}:` : '';
}

// 返回可用 href；不可用时返回空串（调用方降级为纯文本）。
export function safeLinkHref(raw) {
  const url = normalizeUrl(raw);
  if (!url) return '';
  const scheme = schemeOf(url);
  // 无 scheme（相对地址/页内锚点）在桌面聊天里没有可导航的目标，直接降级。
  if (!scheme) return '';
  return LINK_SCHEMES.has(scheme) ? url : '';
}

const DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif)[;,]/i;

// 返回可用图片 src；不可用时返回空串。
export function safeImageSrc(raw) {
  const url = normalizeUrl(raw);
  if (!url) return '';
  if (DATA_IMAGE_PATTERN.test(url)) return url;
  const scheme = schemeOf(url);
  if (scheme === 'http:' || scheme === 'https:' || scheme === 'easychat2-media:') return url;
  if (scheme === 'file:') return mediaUrl(url) || '';
  return '';
}

function createParser() {
  const parser = new Marked({ gfm: true, breaks: false });
  parser.use({
    renderer: {
      // 原始 HTML 一律按文本显示：Markdown 路径不允许任何标签穿过去。
      html(token) {
        return escapeHtml(token.text);
      },
      link(token) {
        const label = this.parser ? this.parser.parseInline(token.tokens || []) : escapeHtml(token.text);
        const href = safeLinkHref(token.href);
        if (!href) return label;
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        return `<a href="${escapeHtml(href)}"${title} rel="noreferrer noopener">${label}</a>`;
      },
      image(token) {
        const src = safeImageSrc(token.href);
        const alt = escapeHtml(token.text || '');
        if (!src) return alt;
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        return `<img src="${escapeHtml(src)}" alt="${alt}"${title} loading="lazy" referrerpolicy="no-referrer">`;
      },
    },
  });
  return parser;
}

let sharedParser = null;
function getParser() {
  if (!sharedParser) sharedParser = createParser();
  return sharedParser;
}

// 供单测注入解析器（生产路径始终用模块级单例）。
export function renderMarkdownWith(parser, text, max) {
  const { text: safeText, truncated } = clampMarkdownText(text, max);
  return { html: parser.parse(safeText), truncated };
}

export function renderMarkdownHtml(text, max) {
  return renderMarkdownWith(getParser(), text, max);
}

export default renderMarkdownHtml;
