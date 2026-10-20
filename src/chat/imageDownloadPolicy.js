// 图片下载的「来源策略 + 下载」编排（从 ChatScreen 外提，避免聊天页行数棘轮）。
//
// 职责：
// 1. 现读来源名单（设置页改完返回聊天即生效，不依赖跨页订阅）；
// 2. 按名单判定主机（空名单 = 不限制，但仍拒绝本机/内网）；
// 3. 把来源请求头（UA / 防盗链 Referer）带进下载。
//
// 只被 ChatScreen 的下载回调调用；把「判定 + 头 + 下载」收在一处，
// 避免同一策略散落在页面与执行器两处。

import { getImageDownloadSources } from '../storage/settings/imageDownloadSources.js';
import { downloadRemoteImage } from './attachments.js';
import {
  buildImageDownloadHeaders,
  hostFromImageUrl,
  isImageDownloadHostAllowed,
} from './imageDownloadSources.js';

export async function downloadImageWithSources(url, { t = null, sources = null } = {}) {
  let list = Array.isArray(sources) ? sources : null;
  if (list === null) {
    try {
      list = await getImageDownloadSources();
    } catch (error) {
      list = [];
    }
  }
  const host = hostFromImageUrl(url);
  if (!isImageDownloadHostAllowed(host, list)) {
    const message = typeof t === 'function'
      ? t('chat.downloadImage.blocked', { host: host || '?' })
      : 'DOWNLOAD_IMAGE_BLOCKED';
    const denied = new Error(message);
    // 执行器按 code 决定是否展示具体原因（其它失败仍用通用文案）。
    denied.code = 'DOWNLOAD_IMAGE_BLOCKED';
    throw denied;
  }
  return downloadRemoteImage(url, { headers: buildImageDownloadHeaders(host, list) });
}
