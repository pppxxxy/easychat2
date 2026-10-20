// 页面 → 图片地址提取（纯函数，Node 直测）。
//
// 用户需求（2026-10-21）：「丢一个图片站首页/作品页，它自己找出图并发送」。
// 直链图片走原下载通道即可；**页面地址**需要先抓 HTML，再从页面里找主图。
//
// 提取口径（按优先级，取第一个能下载的）：
//   1. <meta property="og:image:secure_url">  ← 显式 https 版本，优先
//   2. <meta property="og:image">            ← Open Graph 标准字段
//   3. <meta property="og:image:url">
//   4. <meta name="twitter:image">           ← Twitter Card 兜底
//   5. <meta name="twitter:image:src">
//   6. <meta itemprop="image">
//   7. <link rel="image_src">
//   8. <img src>（仅常见图片扩展名，最多 5 个）——前 7 项全都没有时的最后兜底
//
// 为什么不用「找最大图」的启发式：没有 JS 渲染与真实布局，尺寸信息不可信；
// og/twitter 是站长显式声明的主图，语义最准。多候选按上面顺序交给下载层逐个试。
//
// 本模块只做解析与 URL 归一；网络、白名单、私网判定在下载编排层。

import { decodeHtmlEntities } from '../plugins/webFetch.js';

export const PAGE_IMAGE_MAX_CANDIDATES = 8;
const PAGE_IMAGE_MAX_IMG_FALLBACK = 5;

const META_PRIORITY = [
  'og:image:secure_url',
  'og:image',
  'og:image:url',
  'twitter:image',
  'twitter:image:src',
  'image',
];

const IMAGE_EXTENSION_RE = /\.(?:jpe?g|png|webp|gif|avif|bmp|heic|heif)(?:$|[?#])/i;

// 纯函数：URL 是否带常见图片扩展名（不含扩展名的 CDN 直链不在此列——它们走
// 「先当直链下载」那条路，失败后仍会走页面兜底）。
export function looksLikeImageUrl(url) {
  return IMAGE_EXTENSION_RE.test(String(url || '').trim());
}

// 纯函数：把页面里出现的地址解析成绝对 http(s) URL；解析不出来返回 ''。
// 手写解析（Hermes 的 URL 实现不完整）：支持绝对地址、协议相对（//host/x）、
// 根相对（/x）、相对路径（a.png、../a.png）与查询（?x）。
export function resolveResourceUrl(baseUrl, rawUrl) {
  const raw = String(rawUrl === undefined || rawUrl === null ? '' : rawUrl).trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  // 非 http(s) 的 scheme（data:/javascript:/blob:/file:）一律拒绝
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith('//')) return '';
  const base = String(baseUrl || '').trim();
  const match = /^(https?:\/\/[^/?#]+)([^?#]*)/i.exec(base);
  if (!match) return '';
  const origin = match[1];
  if (raw.startsWith('//')) {
    const scheme = /^(https?):/i.exec(base)[1].toLowerCase();
    return `${scheme}:${raw}`;
  }
  if (raw.startsWith('/')) return `${origin}${raw}`;
  if (raw.startsWith('?')) {
    const basePath = match[2] || '/';
    return `${origin}${basePath}${raw}`;
  }
  if (raw.startsWith('#')) return '';
  const basePath = match[2] || '/';
  const dir = basePath.slice(0, basePath.lastIndexOf('/') + 1) || '/';
  return `${origin}${dir}${raw}`;
}

// 解析一个标签的全部属性（小写键；值已解 HTML 实体）。用于 meta/link/img。
function parseTagAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match = re.exec(tag);
  while (match) {
    const key = String(match[1] || '').toLowerCase();
    const value = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : match[4]);
    if (key && !(key in attrs)) {
      attrs[key] = decodeHtmlEntities(String(value === undefined ? '' : value)).trim();
    }
    match = re.exec(tag);
  }
  return attrs;
}

function pushCandidate(list, seen, url) {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  list.push(value);
}

// 纯函数：从 HTML 里提取主图候选（绝对 URL，已去重、已按优先级排序）。
export function extractPageImageCandidates(html, pageUrl, { max = PAGE_IMAGE_MAX_CANDIDATES } = {}) {
  const source = String(html || '');
  if (!source.trim()) return [];
  const limit = Math.max(1, Math.floor(Number(max)) || PAGE_IMAGE_MAX_CANDIDATES);
  const seen = new Set();
  const byPriority = new Map(META_PRIORITY.map(key => [key, []]));
  const linkCandidates = [];
  const imgCandidates = [];
  const metaRe = /<meta\b[^>]*>/gi;
  let meta = metaRe.exec(source);
  while (meta) {
    const attrs = parseTagAttributes(meta[0]);
    const key = String(attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content !== undefined && byPriority.has(key)) {
      const resolved = resolveResourceUrl(pageUrl, attrs.content);
      if (resolved) byPriority.get(key).push(resolved);
    }
    meta = metaRe.exec(source);
  }
  // <link rel="image_src" href="...">
  const linkRe = /<link\b[^>]*>/gi;
  let link = linkRe.exec(source);
  while (link) {
    const attrs = parseTagAttributes(link[0]);
    const rel = String(attrs.rel || '').toLowerCase();
    if (rel.split(/\s+/).includes('image_src') && attrs.href) {
      const resolved = resolveResourceUrl(pageUrl, attrs.href);
      if (resolved) linkCandidates.push(resolved);
    }
    link = linkRe.exec(source);
  }
  // <img src>：只在前面全空时使用（由编排层决定是否消费；这里限制数量与扩展名）
  const imgRe = /<img\b[^>]*>/gi;
  let img = imgRe.exec(source);
  while (img && imgCandidates.length < PAGE_IMAGE_MAX_IMG_FALLBACK) {
    const attrs = parseTagAttributes(img[0]);
    const src = attrs.src || '';
    if (src) {
      const resolved = resolveResourceUrl(pageUrl, src);
      if (resolved && looksLikeImageUrl(resolved)) imgCandidates.push(resolved);
    }
    img = imgRe.exec(source);
  }
  const ordered = [];
  for (const key of META_PRIORITY) {
    for (const url of byPriority.get(key)) pushCandidate(ordered, seen, url);
  }
  for (const url of linkCandidates) pushCandidate(ordered, seen, url);
  // 页面没有声明主图时才用 <img> 兜底——否则正文里的装饰图会排在 og:image 前面。
  if (ordered.length === 0) {
    for (const url of imgCandidates) pushCandidate(ordered, seen, url);
  }
  return ordered.slice(0, limit);
}
