// 图片下载执行器：把 <download_image:URL> 解析出的 URL 逐个下载，作为独立图片消息追加到聊天。
// 失败（超时/非图片/过大）追加一条小提示。依赖全部注入（Node 直测）。
//
// 每张图下载前后都查一次 isCurrentSession：用户在下载途中切走会话时立即停手，
// 不把图片追加到错误的会话（已落屏的文字不受影响）。

import { ASSISTANT_ID } from './chatConstants.js';
import { IMAGE_MESSAGE_KIND, createMediaMessage } from './chatMedia.js';

export async function runImageDownloads({
  urls,
  isCurrentSession,
  download,
  appendMessage,
  failedText,
  now = () => Date.now(),
} = {}) {
  const list = Array.isArray(urls) ? urls : [];
  const alive = () => (typeof isCurrentSession === 'function' ? isCurrentSession() : true);
  let seq = 0;
  for (const url of list) {
    if (!alive()) return;
    seq += 1;
    const stamp = now();
    try {
      const image = await download(url);
      if (!alive()) return;
      appendMessage({
        ...createMediaMessage({
          id: `${stamp}-assistant-download-${seq}`,
          kind: IMAGE_MESSAGE_KIND,
          uri: image && image.uri,
          mime: image && image.mime,
          width: image && image.width,
          height: image && image.height,
          timestamp: stamp,
        }),
        role: ASSISTANT_ID,
      });
    } catch (error) {
      if (!alive()) return;
      // 来源白名单拒绝是「用户配置导致的确定性结果」，提示具体原因（哪个站点被拒）；
      // 其余失败（超时/非图片/网络）仍用通用文案——异常细节不往气泡里灌。
      const blocked = error && error.code === 'DOWNLOAD_IMAGE_BLOCKED' && error.message;
      appendMessage({
        id: `${stamp}-assistant-download-fail-${seq}`,
        role: ASSISTANT_ID,
        text: blocked
          ? String(error.message)
          : (typeof failedText === 'function' ? failedText(url) : String(failedText || '')),
        timestamp: stamp,
      });
    }
  }
}
