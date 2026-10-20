// 图片下载来源（纯函数，Node 直测）。
//
// 产品语义（2026-10-21 用户要求「增加图片下载来源 + 真的能从来源发图」）：
// - 设置 → 功能扩展 → 图片下载 下可以维护一份**来源名单**；
// - **名单为空** = 不限制（保持旧行为），但仍拒绝本机/内网地址——模型给出的 URL
//   属于「被诱导的请求」，默认不该打到局域网（SSRF 面）；
// - **名单非空** = 只允许名单内主机（精确匹配或子域后缀匹配，口径与
//   plugins/webFetch.js 的 isDomainAllowed 一致：精确相等 或 `.域名` 后缀）；
// - 每个来源可带一个**引用页 Referer**：不少图片站（如 pixiv 的 i.pximg.net）
//   会校验 Referer 防盗链，没有它下载必 403。这是「加了来源却发不出图」的主因，
//   所以来源条目不是只做白名单，还要把请求头一起带下去。
//
// 为什么不做通配符：匹配语义是「精确 或 子域后缀」，`*.example.com` 会被当作
// 字面域名永远不命中——存进去等于骗用户，所以归一阶段直接拒绝（同 webFetch 白名单）。
//
// 本模块零 RN 依赖：存储壳在 storage/settings/imageDownloadSources.js，
// 下载执行在 chat/attachments.js，提示词注入在 prompt/chatPipeline.js。

import { isPrivateHost } from '../plugins/webFetch.js';

export const MAX_IMAGE_DOWNLOAD_SOURCES = 20;
export const MAX_IMAGE_SOURCE_HOST_CHARS = 120;
export const MAX_IMAGE_SOURCE_REFERER_CHARS = 500;

// 部分图片站会按 UA 拦截空 UA/非常规 UA；带一个常见移动浏览器 UA 成功率更高。
export const DEFAULT_IMAGE_DOWNLOAD_UA =
  'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// 纯函数：用户输入 → 可存储的主机名（小写、去协议/路径/端口/账号）；不接受返回 ''。
// 明确拒绝：通配符、空格、IPv6、纯 IP、无点主机名（localhost 等）、超长输入。
export function normalizeDownloadHost(raw) {
  let text = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (!text) return '';
  if (text.includes('*') || /\s/.test(text)) return '';
  // 去协议（http://、https://、其它 scheme 一律按「用户粘了链接」处理）
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  // 去 userinfo（https://user:pass@host/…）——下载时也不会带账号
  const at = text.lastIndexOf('@');
  if (at >= 0) text = text.slice(at + 1);
  // 去路径/查询/锚点
  text = text.split('/')[0].split('?')[0].split('#')[0];
  // 去端口（下载 URL 里的端口仍按原样请求，名单只按主机名匹配）
  text = text.replace(/:\d+$/, '');
  if (!text || text.length > MAX_IMAGE_SOURCE_HOST_CHARS) return '';
  // IPv6（[::1]）与其它含冒号的形态不支持；纯 IP 也不接受（应填域名）
  if (text.includes(':') || text.includes('[') || text.includes(']')) return '';
  if (!/^[a-z0-9.-]+$/.test(text)) return '';
  if (!text.includes('.')) return '';
  if (/^[0-9.]+$/.test(text)) return '';
  if (text.startsWith('.') || text.endsWith('.') || text.includes('..')) return '';
  return text;
}

// 纯函数：引用页 → 合法 http(s) URL；其余（含空）返回 ''。
export function normalizeDownloadReferer(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text || text.length > MAX_IMAGE_SOURCE_REFERER_CHARS) return '';
  if (!/^https?:\/\//i.test(text)) return '';
  return text;
}

// 纯函数：一条来源 → { host, referer? }；非法返回 null。
export function normalizeImageSource(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const host = normalizeDownloadHost(
    source.host !== undefined ? source.host : (source.domain !== undefined ? source.domain : raw)
  );
  if (!host) return null;
  const referer = normalizeDownloadReferer(source.referer !== undefined ? source.referer : source.referrer);
  return { host, ...(referer ? { referer } : {}) };
}

// 纯函数：整份名单 → 去重（按主机）+ 上限截断。
export function normalizeImageSources(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const source = normalizeImageSource(item);
    if (!source || seen.has(source.host)) continue;
    seen.add(source.host);
    out.push(source);
    if (out.length >= MAX_IMAGE_DOWNLOAD_SOURCES) break;
  }
  return out;
}

// 纯函数：主机是否命中某条名单（精确相等或子域后缀）。
export function hostMatchesPattern(host, pattern) {
  const h = String(host || '').toLowerCase();
  const p = String(pattern || '').toLowerCase();
  if (!h || !p) return false;
  return h === p || h.endsWith(`.${p}`);
}

// 纯函数：本机/内网地址判定。
// 复用 plugins/webFetch.js 的加固实现（先解析再判网段）——它覆盖十进制/八进制/
// 十六进制 IPv4 与 IPv4-mapped IPv6 等绕过写法；本模块自己维护一份简化正则
// 会漏掉「http://2130706433/」这类地址（直连回环地址的 SSRF 面）。
// webFetch 是 Node 安全的（无 RN import，测试直接 import 过），故可作为依赖。
export function isPrivateDownloadHost(host) {
  return isPrivateHost(host);
}

// 纯函数：该主机是否允许下载。
// 名单为空 ⇒ 不限制（兼容旧行为），但本机/内网一律拒绝（隐式放行不该包含局域网）。
// 名单非空 ⇒ 只放行命中项（用户显式添加即视为授权，哪怕它是内网域名——但
// normalizeDownloadHost 不接受纯 IP，域名形式的内部域仍可能通过，这是用户显式选择）。
export function isImageDownloadHostAllowed(host, sources) {
  const list = normalizeImageSources(sources);
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (list.length === 0) return !isPrivateDownloadHost(h);
  return list.some(item => hostMatchesPattern(h, item.host));
}

// 纯函数：命中哪条来源（多个后缀匹配时取最长的，例如 a.b.example.com 命中
// b.example.com 而不是 example.com——引用页按最具体的那条走）。
export function matchImageSource(host, sources) {
  const list = normalizeImageSources(sources);
  let best = null;
  for (const item of list) {
    if (!hostMatchesPattern(host, item.host)) continue;
    if (!best || item.host.length > best.host.length) best = item;
  }
  return best;
}

// 纯函数：下载请求头（UA 恒带；命中来源且有引用页时带 Referer）。
export function buildImageDownloadHeaders(host, sources) {
  const source = matchImageSource(host, sources);
  return {
    'User-Agent': DEFAULT_IMAGE_DOWNLOAD_UA,
    ...(source && source.referer ? { Referer: source.referer } : {}),
  };
}

// 纯函数：从图片 URL 里取主机名（无效返回 ''）。
export function hostFromImageUrl(url) {
  const text = String(url || '').trim();
  const match = text.match(/^https?:\/\/([^/?#]+)/i);
  if (!match) return '';
  return String(match[1]).replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
}
