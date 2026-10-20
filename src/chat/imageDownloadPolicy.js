// 图片下载的「来源策略 + 下载」编排（从 ChatScreen 外提，避免聊天页行数棘轮）。
//
// 职责：
// 1. 现读来源名单（设置页改完返回聊天即生效，不依赖跨页订阅）；
// 2. 交给 pageImageDownload：直链优先，失败且是页面时抓 HTML 提取 og:image；
// 3. 把来源请求头（UA / 防盗链 Referer）带进每一次下载。
//
// 只被 ChatScreen 的下载回调调用；判定/请求头/页面兜底全部收在纯逻辑模块里，
// 本文件只做「读存储 + 注入真实下载器与页面抓取器」的装配。

import { getImageDownloadSources } from '../storage/settings/imageDownloadSources.js';
import { downloadRemoteImage } from './attachments.js';
import { downloadImageOrPage } from './pageImageDownload.js';
import { fetchPageHtml } from './pageImageFetch.js';

export async function downloadImageWithSources(url, { t = null, sources = null } = {}) {
  let list = Array.isArray(sources) ? sources : null;
  if (list === null) {
    try {
      list = await getImageDownloadSources();
    } catch (error) {
      list = [];
    }
  }
  return downloadImageOrPage(url, {
    sources: list,
    t,
    downloadImage: (target, headers) => downloadRemoteImage(target, { headers }),
    fetchPage: (pageUrl, headers) => fetchPageHtml(pageUrl, { headers }),
  });
}
