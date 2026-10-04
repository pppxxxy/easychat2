// 语音消息的纯函数：消息构造与上下文投影。
// 用户录音转写后仍以普通文本进入上下文；音频仅作本机回放引用，历史消息不重新回传音频。
// 与 src/chat/chatMedia.js（图片/表情包）同构，便于 chatPipeline 统一处理。

export const VOICE_MESSAGE_KIND = 'voice';

export const VOICE_PLACEHOLDER_TEXT = '[用户发来一段语音]';

export function isVoiceMessage(message) {
  return !!(message && message.kind === VOICE_MESSAGE_KIND && message.audio);
}

// 上下文投影：有转写/原文文本用文本，为空（转写失败）用占位，保证消息语义不丢、不报错。
export function getVoicePromptText(message) {
  if (!isVoiceMessage(message)) return String(message && message.text || '');
  const text = String(message.text || '').trim();
  return text || VOICE_PLACEHOLDER_TEXT;
}

// 构造语音消息。audio: { uri, mime, durationMs }；uri 必须是本机 voice/ 文件。
export function createVoiceMessage({
  id,
  role = 'user',
  text = '',
  audio,
  timestamp = Date.now(),
} = {}) {
  const source = audio && typeof audio === 'object' ? audio : {};
  return {
    id: String(id || `${timestamp}-${VOICE_MESSAGE_KIND}`),
    role: role === 'assistant' ? 'assistant' : 'user',
    kind: VOICE_MESSAGE_KIND,
    text: String(text || ''),
    audio: {
      uri: String(source.uri || ''),
      mime: String(source.mime || 'audio/m4a'),
      durationMs: Math.max(0, Math.round(Number(source.durationMs) || 0)),
    },
    timestamp,
  };
}

// 时长展示：秒（四舍五入，至少 1 秒，避免 0'00"）。
export function formatVoiceDuration(durationMs) {
  const seconds = Math.max(1, Math.round((Number(durationMs) || 0) / 1000));
  return `${seconds}"`;
}
