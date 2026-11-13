// 富 HTML 消息的 iframe 文档构造（纯函数，Node 可测）。
//
// 设计口径（design.md 安全决策）：使用 `sandbox` iframe 渲染角色卡，**不启用
// allow-scripts**。没有脚本执行，就无需清洗正文里的 on* 属性；iframe 内的交互
// （<details> 折叠、命令按钮、链接）由父页面在 contentDocument 上以事件委托接管，
// 因为 sandbox 只开了 allow-same-origin（保留同源，父页面才能读文档、量高度）。
//
// 文档来自共享层 buildRichHtmlDocument（与 Android WebView 同一套排版复位样式），
// 再做两处桌面化处理：
//   1. 删除全部 <script>：CSP 与 sandbox 已禁脚本，删掉是纵深防御；
//   2. 把共享层的宽松 CSP meta 换成桌面专用收紧版（script-src 'none'）。
import { buildRichHtmlDocument } from '../../../src/chat/richHtml.js';
import { mediaUrl } from '../platform/mediaUrl.js';

// 父页面 CSP 已含 default-src 'self'；srcdoc 会**继承**父 CSP，两份策略取交集，
// 因此这里列的来源必须同时在 electron/main.js 的 CSP 里放行（img/media 的 https:）。
export const IFRAME_CSP = [
  "default-src 'none'",
  "img-src data: blob: https: easychat2-media:",
  "media-src data: blob: https: easychat2-media:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const SCRIPT_BLOCK_PATTERN = /<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi;
const CSP_META_PATTERN = /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i;
const ONCLICK_ATTRIBUTE_PATTERN = /onclick\s*=\s*("[^"]*"|'[^']*')/i;
const SLASH_SEND_PATTERN = /\/send\s+([^'"]+)/i;
const BUTTON_TAG_PATTERN = /<button\b([^>]*)>/gi;

export function stripScripts(html) {
  return String(html || '').replace(SCRIPT_BLOCK_PATTERN, '');
}

// 卡片作者常用 onclick="triggerSlash('/send 内容')" 做按钮。桌面禁用脚本，
// 这里把命令提取成 data-command，由父页面委托点击后写入输入区。
export function extractSendCommand(onclick) {
  const match = String(onclick || '').match(SLASH_SEND_PATTERN);
  return match ? match[1].trim() : '';
}

export function prepareIframeHtml(raw) {
  const html = String(raw || '');
  if (!/<button\b/i.test(html)) return html;
  return html.replace(BUTTON_TAG_PATTERN, (full, attrs) => {
    if (/\sdata-command\s*=/i.test(attrs)) return full;
    const onclickMatch = attrs.match(ONCLICK_ATTRIBUTE_PATTERN);
    if (!onclickMatch) return full;
    const command = extractSendCommand(onclickMatch[1].slice(1, -1));
    if (!command) return full;
    const encoded = encodeURIComponent(command).replace(/"/g, '&quot;');
    return `<button${attrs} data-command="${encoded}">`;
  });
}

// 卡片里常见的本地图片是 file:// URI：渲染进程只能通过媒体协议访问 documents/，
// 这里把能映射的 src/poster 改写成 easychat2-media://，映射不到的原样保留（由 CSP 拦下）。
const MEDIA_SOURCE_PATTERN = /(<(?:img|video|audio|source)\b[^>]*?\s(?:src|poster)\s*=\s*)(["'])(file:[^"']*)\2/gi;

export function rewriteLocalMediaSources(raw) {
  return String(raw || '').replace(MEDIA_SOURCE_PATTERN, (full, prefix, quote, url) => {
    const mapped = mediaUrl(url);
    return mapped ? `${prefix}${quote}${mapped}${quote}` : full;
  });
}

// 共享层排版复位样式给 html/body 设了 min-height:100%：在 Android WebView 里
// 这是「卡片至少铺满视图」的正确行为，但在桌面 iframe 里会让测高闭环永远量到
// 当前 iframe 高度（只能变大、不能变小，短卡片下方留一片空白）。桌面文档补一条
// min-height:0 覆盖，让 scrollHeight 如实反映内容高度。
const DESKTOP_LAYOUT_OVERRIDE = '<style data-easychat2-desktop="true">html,body{min-height:0!important;}</style>';

export function buildIframeDocument({
  html = '',
  textColor = '#ffffff',
  linkColor = '#8b85ff',
  fontSize = 15,
} = {}) {
  const document = buildRichHtmlDocument({
    bodyHtml: rewriteLocalMediaSources(prepareIframeHtml(html)),
    textColor,
    linkColor,
    fontSize,
  });
  const hardened = stripScripts(document).replace(
    CSP_META_PATTERN,
    `<meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}">`
  );
  return /<\/head>/i.test(hardened)
    ? hardened.replace(/<\/head>/i, `${DESKTOP_LAYOUT_OVERRIDE}</head>`)
    : `${DESKTOP_LAYOUT_OVERRIDE}${hardened}`;
}

export default buildIframeDocument;
