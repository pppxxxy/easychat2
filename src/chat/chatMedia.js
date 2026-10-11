export const IMAGE_MESSAGE_KIND = 'image';
export const STICKER_MESSAGE_KIND = 'sticker';
export const VIDEO_MESSAGE_KIND = 'video';

export function isMediaMessage(message) {
  return !!(message && message.image && (
    !message.kind
    || message.kind === IMAGE_MESSAGE_KIND
    || message.kind === STICKER_MESSAGE_KIND
    || message.kind === VIDEO_MESSAGE_KIND
  ));
}

// 「这张图值不值得带 OCR 描述」：只有**普通图片**才有（表情包本身有名字，描述它没有
// 意义；视频不走图片识别）。判据收在这里，避免每个消费点各写一套条件而漂移。
export function isImageDescriptionEligible(message) {
  if (!isMediaMessage(message)) return false;
  if (message.kind === STICKER_MESSAGE_KIND || message.kind === VIDEO_MESSAGE_KIND) return false;
  const image = message.image || {};
  return !image.stickerId;
}

export function getMediaPrompt(message, imageDescriptionPrompts = null) {
  if (!isMediaMessage(message)) return String(message && message.text || '');
  const image = message.image || {};
  const name = String(image.stickerName || image.name || '').trim().slice(0, 80);
  const base = (() => {
    if (message.kind === STICKER_MESSAGE_KIND || image.stickerId) {
      return `【表情包：${name || '未命名'}】`;
    }
    if (message.kind === VIDEO_MESSAGE_KIND) {
      return `【视频：${name || '未命名'}】`;
    }
    return `【图片：${name || '未命名'}】`;
  })();
  // 图片识别（OCR）结果：把文字描述拼在图片占位符之前，让**看不到图的模型**也能
  // 通过这段文本理解画面。只在识别真的跑过时才有这些字段（description 非空表示
  // 识别成功；descriptionFailed 表示识别失败——失败也如实告诉模型，不静默省略）。
  // 提示词文本由调用方注入（imageDescriptionPrompt.js），避免本模块反向依赖引擎。
  const prompts = imageDescriptionPrompts || {};
  if (isImageDescriptionEligible(message) && (message.description || message.descriptionFailed)) {
    const described = String(message.description || '').trim();
    if (described) {
      const prefix = String(prompts.prefix || '').trim();
      return `${prefix ? `${prefix}\n` : ''}${described}\n${base}`;
    }
    const failed = String(prompts.failed || '').trim();
    return `${failed ? `${failed}\n` : ''}${base}`;
  }
  return base;
}

// 上下文投影统一入口：语音消息（有转写用转写、空则占位）优先于文本；
// 图片/表情包沿用既有投影；其余按纯文本。
// 语音投影逻辑定义在 voiceMessages.js，这里内联等价判断，避免引入循环依赖。
// imageDescriptionPrompts：图片识别（OCR）描述的前缀/失败说明（由 chatPipeline 注入，
// 见 imageDescriptionPrompt.js）；不传时退化为不带描述前缀的既有行为。
export function getMessagePromptText(message, imageDescriptionPrompts = null) {
  if (message && message.kind === 'voice' && message.audio) {
    const text = String(message.text || '').trim();
    return text || '[用户发来一段语音]';
  }
  return isMediaMessage(message)
    ? getMediaPrompt(message, imageDescriptionPrompts)
    : String(message && message.text || '');
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
    kind: kind === STICKER_MESSAGE_KIND
      ? STICKER_MESSAGE_KIND
      : (kind === VIDEO_MESSAGE_KIND ? VIDEO_MESSAGE_KIND : IMAGE_MESSAGE_KIND),
    text: '',
    image,
    timestamp,
  };
}
