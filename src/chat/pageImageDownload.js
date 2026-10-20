// 图片下载编排（纯逻辑，依赖注入——Node 直测）。
//
// 两条路径：
//   1. **直链**：URL 本身就是图片 → 原下载通道（downloadImage）。
//   2. **页面兜底**：直链下载返回「不是图片」→ 抓 HTML → 提取 og:image 等主图
//      候选 → 逐个尝试下载（用户说的「丢一个作品页，它自己找出图」）。
//
// 安全边界（与设置里的「图片来源」白名单配合）：
// - 页面主机必须在名单内（名单为空 = 不限制，但仍拒绝本机/内网）；
// - 候选图片主机**继承页面授权**：用户授权的是「这个站点的内容」，图片常来自
//   该站 CDN（如 pixiv 页面 → i.pximg.net），要求用户再配一遍 CDN 不现实；
// - 候选图片主机**永远拒绝本机/内网**（页面 HTML 可能是恶意构造的 SSRF 跳板）；
// - 候选没命中来源时，把**页面最终 URL** 作为 Referer（防盗链最常见的一档）。
//
// 依赖注入：
//   downloadImage(url, headers) → Promise<image>；返回错误带 code
//   fetchPage(url, headers)     → Promise<{ html, finalUrl }>
// 本模块不 import RN / XHR，保证纯 Node 可测。

import {
  buildImageDownloadHeaders,
  hostFromImageUrl,
  isImageDownloadHostAllowed,
  isPrivateDownloadHost,
  matchImageSource,
} from './imageDownloadSources.js';
import { extractPageImageCandidates } from './pageImageExtract.js';

// 与 chat/attachments.js 的 DOWNLOAD_IMAGE_NOT_IMAGE 保持一致（不 import 它：
// attachments 依赖 expo-file-system，会把 RN 拖进本模块的测试）。
export const CODE_NOT_IMAGE = 'DOWNLOAD_IMAGE_NOT_IMAGE';
export const MAX_PAGE_IMAGE_ATTEMPTS = 2;

function blockedError(t, host) {
  const message = typeof t === 'function'
    ? t('chat.downloadImage.blocked', { host: host || '?' })
    : 'DOWNLOAD_IMAGE_BLOCKED';
  const error = new Error(message);
  error.code = 'DOWNLOAD_IMAGE_BLOCKED';
  return error;
}

// 页面兜底：返回下载结果；没有候选/全部失败时抛出「不是图片」原错误。
async function downloadFromPage(url, {
  sources,
  downloadImage,
  fetchPage,
  directError,
}) {
  let page = null;
  try {
    page = await fetchPage(url, buildImageDownloadHeaders(hostFromImageUrl(url), sources));
  } catch (error) {
    throw directError; // 页面抓取失败：按原「不是图片」失败处理（不泄露旁路细节）
  }
  const html = String((page && page.html) || '');
  const finalUrl = String((page && page.finalUrl) || url);
  const candidates = extractPageImageCandidates(html, finalUrl);
  let lastError = directError;
  let attempts = 0;
  for (const candidate of candidates) {
    if (attempts >= MAX_PAGE_IMAGE_ATTEMPTS) break;
    if (candidate === url) continue;
    const host = hostFromImageUrl(candidate);
    if (!host) continue;
    // 候选图主机永远拒绝本机/内网（页面内容不可信，可能被构造成 SSRF 跳板）。
    if (isPrivateDownloadHost(host)) continue;
    attempts += 1;
    const matched = matchImageSource(host, sources);
    const headers = {
      ...buildImageDownloadHeaders(host, sources),
      // 没命中来源时用页面地址当 Referer（pixiv 等站的 i.pximg.net 就吃这一档）。
      ...(matched ? {} : { Referer: finalUrl }),
    };
    try {
      return await downloadImage(candidate, headers);
    } catch (error) {
      lastError = error;
      // 候选不是图片（例如返回了 HTML 错误页）→ 试下一个；其它错误同样记录后
      // 继续（候选常来自不同 CDN，单个挂掉不代表全挂）。
      continue;
    }
  }
  throw lastError;
}

export async function downloadImageOrPage(url, {
  sources = [],
  downloadImage,
  fetchPage = null,
  t = null,
} = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const pageHost = hostFromImageUrl(url);
  if (!pageHost || !isImageDownloadHostAllowed(pageHost, list)) {
    throw blockedError(t, pageHost);
  }
  const headers = buildImageDownloadHeaders(pageHost, list);
  try {
    return await downloadImage(url, headers);
  } catch (error) {
    if (!error || error.code !== CODE_NOT_IMAGE) throw error;
    // 页面兜底只在注入 fetchPage 时启用（老宿主/测试不传 = 行为与旧版一致）。
    if (typeof fetchPage !== 'function' || typeof downloadImage !== 'function') throw error;
    return downloadFromPage(url, {
      sources: list,
      downloadImage,
      fetchPage,
      directError: error,
    });
  }
}
