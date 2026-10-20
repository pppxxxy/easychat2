// 页面抓取（图片下载的「页面兜底」用）：取回 HTML 交给纯函数提取主图。
//
// 复用 plugins/webFetch.js 的安全骨架（不另造一套）：
// - normalizeFetchUrl：只允许 http(s)、**拒绝本机/内网**（fail-closed，十进制/
//   八进制/十六进制 IPv4 与 IPv4-mapped IPv6 都能识别）；
// - isPrivateRedirectTarget：重定向落到内网时丢弃响应（请求已发出，但内容不采用）；
// - WEB_FETCH_HTML_MAX_CHARS：响应体上限 2MB（超出只取前段——og:image 都在 <head>）。
//
// 与 web_fetch 插件的区别：不走「未知域名弹窗授权」。图片下载的授权口径是
// 「设置里的图片来源白名单」（用户已显式配置），页面主机在进入本函数前已由
// 编排层校验过，这里只负责传输与私网复核。
//
// 错误用 code 区分（页面抓取是旁路，失败最终回落为「图片下载失败」通用文案）：
// PAGE_FETCH_URL / PAGE_FETCH_TIMEOUT / PAGE_FETCH_NETWORK / PAGE_FETCH_HTTP /
// PAGE_FETCH_REDIRECT_PRIVATE / PAGE_FETCH_ABORTED。

import xhrRequest from '../network/vendorHttp.js';
import {
  isPrivateRedirectTarget,
  normalizeFetchUrl,
  WEB_FETCH_HTML_MAX_CHARS,
} from '../plugins/webFetch.js';

export const PAGE_IMAGE_TIMEOUT_MS = 15000;

function codedError(code, extra = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export async function fetchPageHtml(url, { headers = {}, signal = null } = {}) {
  const normalized = normalizeFetchUrl(url);
  if (!normalized.ok) {
    throw codedError('PAGE_FETCH_URL', { reason: normalized.reason });
  }
  const redirectGuard = { finalUrl: '' };
  let html = '';
  try {
    html = await xhrRequest({
      method: 'GET',
      url: normalized.url,
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
      signal,
      timeoutMs: PAGE_IMAGE_TIMEOUT_MS,
      defaultTimeoutMs: PAGE_IMAGE_TIMEOUT_MS,
      onTimeoutError: () => codedError('PAGE_FETCH_TIMEOUT'),
      onAbortError: () => codedError('PAGE_FETCH_ABORTED'),
      onAbortEventError: () => codedError('PAGE_FETCH_ABORTED'),
      onNetworkError: () => codedError('PAGE_FETCH_NETWORK'),
      onHttpError: status => codedError('PAGE_FETCH_HTTP', { status }),
      parse: xhr => {
        redirectGuard.finalUrl = String((xhr && xhr.responseURL) || '');
        if (isPrivateRedirectTarget(redirectGuard.finalUrl)) {
          throw codedError('PAGE_FETCH_REDIRECT_PRIVATE');
        }
        return String((xhr && xhr.responseText) || '');
      },
      onParseError: error => error,
    });
  } catch (error) {
    // 兜底：任何未编码的异常也带 code 出去（编排层据此判断是否继续尝试候选图）。
    if (error && error.code) throw error;
    throw codedError('PAGE_FETCH_NETWORK');
  }
  const source = String(html || '');
  return {
    html: source.length > WEB_FETCH_HTML_MAX_CHARS ? source.slice(0, WEB_FETCH_HTML_MAX_CHARS) : source,
    finalUrl: redirectGuard.finalUrl || normalized.url,
  };
}
