// 聊天发送路径的「视频附件预处理」。
//
// 从 src/chat/useChatSend.js 外提（该文件已顶到行数基线，棘轮只许收紧）：视频附件的
// 三重校验（能力/数量/大小）、独立 base64 预算、读成数据 URI 与建消息，是一段自足的
// 编排，抽出来既不改变行为也不动图片路径。
//
// 预算与图片**分列**：视频请求体大得多，共用一份额度会让一条视频把图片的额度连带
// 吃光（见 MAX_VIDEO_BASE64_BYTES 的说明）。
//
// 本模块不弹窗：失败以 { ok:false, reason } 返回，由调用方按自己的 i18n 词条提示
// （Hook 里拿 tRef.current 更顺手，且测试不必打桩 Alert）。

import { createMediaMessage } from './chatMedia.js';
import { MAX_VIDEO_BASE64_BYTES, readVideoDataUri } from './attachments.js';

// 按顺序把每条视频读成 data URI 并建消息。
// 返回 { ok:true, messages } 或 { ok:false, reason }，reason ∈
// 'missing' | 'too-large' | 'total-too-large' | 'read-failed' | 'canceled' | 'guard-changed'。
export async function prepareVideoMessages(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const {
    now = Date.now(),
    indexOffset = 0,
    getFileInfo,
    isCanceled = () => false,
    isGuardCurrent = () => true,
  } = options;
  const messages = [];
  let totalBase64Bytes = 0;
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    let size = Number(item.size || 0);
    let info;
    try {
      info = await getFileInfo(item.uri);
    } catch (error) {
      return { ok: false, reason: 'missing' };
    }
    if (!info || info.exists === false) return { ok: false, reason: 'missing' };
    size = info.size || size;
    if (size > options.maxVideoBytes) return { ok: false, reason: 'too-large' };

    let dataUri = '';
    const estimatedBase64Bytes = Math.ceil(size * 4 / 3);
    if (totalBase64Bytes + estimatedBase64Bytes > MAX_VIDEO_BASE64_BYTES) {
      return { ok: false, reason: 'total-too-large' };
    }
    totalBase64Bytes += estimatedBase64Bytes;
    try {
      dataUri = await readVideoDataUri(item.uri, item.mime);
    } catch (error) {
      return { ok: false, reason: 'read-failed' };
    }
    const separator = dataUri.indexOf(',');
    const base64Length = separator >= 0 ? dataUri.length - separator - 1 : dataUri.length;
    totalBase64Bytes = Math.max(
      totalBase64Bytes,
      totalBase64Bytes - estimatedBase64Bytes + Math.ceil(base64Length * 3 / 4)
    );
    if (totalBase64Bytes > MAX_VIDEO_BASE64_BYTES) return { ok: false, reason: 'total-too-large' };
    if (isCanceled()) return { ok: false, reason: 'canceled' };
    if (!isGuardCurrent()) return { ok: false, reason: 'guard-changed' };

    const message = createMediaMessage({
      id: `${now}-video-${index}`,
      kind: 'video',
      uri: item.uri,
      mime: item.mime,
      name: item.name,
      width: item.width,
      height: item.height,
      timestamp: now + indexOffset + index,
    });
    messages.push({ message, dataUri });
  }
  return { ok: true, messages };
}
