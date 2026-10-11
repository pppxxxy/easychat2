// 助手回复 → 消息分段（从 ChatScreen.js 外提并扩展图片下载指令）。
//
// 纯逻辑、零 RN 依赖、Node 可直测：把一条助手回复拆成「文字消息 + 表情包媒体消息」，
// 同时剥离并收集 <download_image:URL> 指令（下载由调用方异步执行，见 imageDownloadRunner）。
// 表情包名称必须命中白名单；图片下载只在开关开启时解析。

import { ASSISTANT_ID } from './chatConstants.js';
import { STICKER_MESSAGE_KIND, createMediaMessage } from './chatMedia.js';
import { extractStickerDirectives, resolveStickerNames } from './stickerDirectives.js';
import { extractDownloadImageDirectives } from './imageDownloadDirectives.js';

// 返回 { parts, imageDownloads }：
//  · parts —— 可直接替换占位符的消息数组（文字在前，表情包依次在后）；
//  · imageDownloads —— 需异步下载的图片 URL（最多 MAX_DOWNLOAD_IMAGES 个）。
export function buildAssistantReplyParts({ replyText, stickers, downloadEnabled = false } = {}) {
  const list = Array.isArray(stickers) ? stickers : [];
  const names = resolveStickerNames(list);
  const { text: afterStickers, stickers: hitNames } = extractStickerDirectives(replyText || '', names);
  const { text, urls } = downloadEnabled
    ? extractDownloadImageDirectives(afterStickers)
    : { text: afterStickers, urls: [] };

  const byName = new Map(list.map(item => [item.name, item]));
  const now = Date.now();
  const items = [];
  const body = String(text || '').trim();
  if (body) {
    items.push({ id: `${now}-assistant`, role: ASSISTANT_ID, text: body, timestamp: now });
  }
  hitNames.forEach((name, index) => {
    const sticker = byName.get(name);
    if (!sticker) return;
    items.push(createMediaMessage({
      id: `${now}-assistant-sticker-${index}`,
      kind: STICKER_MESSAGE_KIND,
      role: ASSISTANT_ID,
      uri: sticker.uri,
      mime: sticker.mime,
      name,
      stickerName: name,
      stickerId: sticker.id,
      width: sticker.width,
      height: sticker.height,
      timestamp: now + index + 1,
    }));
  });
  // createMediaMessage 固定 role:'user'（用户发表情包用），助手表情包需覆盖为 assistant。
  const parts = items.map(item => (
    item.kind === STICKER_MESSAGE_KIND ? { ...item, role: ASSISTANT_ID } : item
  ));
  return { parts, imageDownloads: urls };
}
