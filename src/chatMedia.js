export const IMAGE_MESSAGE_KIND = 'image';
export const STICKER_MESSAGE_KIND = 'sticker';

export function isMediaMessage(message) {
  return !!(message && message.image && (
    message.kind === IMAGE_MESSAGE_KIND
    || message.kind === STICKER_MESSAGE_KIND
  ));
}

export function getMediaPrompt(message) {
  if (!isMediaMessage(message)) return String(message && message.text || '');
  const image = message.image || {};
  const name = String(image.stickerName || image.name || '').trim().slice(0, 80);
  if (message.kind === STICKER_MESSAGE_KIND || image.stickerId) {
    return `【表情包：${name || '未命名'}】`;
  }
  return `【图片：${name || '未命名'}】`;
}

export function getMessagePromptText(message) {
  return isMediaMessage(message) ? getMediaPrompt(message) : String(message && message.text || '');
}

export function createMediaMessage({
  id,
  kind = IMAGE_MESSAGE_KIND,
  uri,
  mime = 'image/jpeg',
  name = '',
  width = 0,
  height = 0,
  stickerId = '',
  stickerName = '',
  timestamp = Date.now(),
} = {}) {
  const image = {
    uri: String(uri || ''),
    mime: String(mime || 'image/jpeg'),
    name: String(name || ''),
    width: Number(width) || 0,
    height: Number(height) || 0,
  };
  if (stickerId) image.stickerId = String(stickerId);
  if (stickerName) image.stickerName = String(stickerName);
  return {
    id: String(id || `${timestamp}-${kind}`),
    role: 'user',
    kind: kind === STICKER_MESSAGE_KIND ? STICKER_MESSAGE_KIND : IMAGE_MESSAGE_KIND,
    text: '',
    image,
    timestamp,
  };
}
