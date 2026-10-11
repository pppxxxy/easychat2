// 上下文体积的粗估器（叶子模块：零依赖）。
//
// 为什么单独一个文件：这套估算口径有两个消费者——localModel/localContext.js 的裁剪
// 与 agent/resultClearing.js 的「工具结果清除」预算换算。它们必须**同一口径**，
// 但 resultClearing 又需要 localContext 的配对判据（findOrphanToolMessages 反过来在
// resultClearing 里）——直接互相 import 就是模块循环（guard-structure 会拒）。
// 把估算器下沉到叶子，两边都从这里取，环自然消失。
//
// 口径：CJK 约 1 token/字，其余按 4 字符/token；图像/音频按固定值折算。
// 只需要「够用」，不需要精确。

// 每个非文本模态部分折算的 token（图像/音频的粗略占用，仅用于预算，不需精确）。
const IMAGE_PART_TOKENS = 256;
const AUDIO_PART_TOKENS = 512;
// 单条消息的角色/分隔开销。
const PER_MESSAGE_OVERHEAD = 4;

const CJK_PATTERN = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/;

// 粗估一段文本的 token：CJK 约 1 token/字，其余按 4 字符/token。
export function estimateTextTokens(text) {
  const source = String(text || '');
  if (!source) return 0;
  let cjk = 0;
  for (const char of source) {
    if (CJK_PATTERN.test(char)) cjk += 1;
  }
  const other = source.length - cjk;
  return Math.ceil(cjk + other / 4);
}

function contentTokens(content) {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  content.forEach(part => {
    if (!part || typeof part !== 'object') return;
    if (part.type === 'image_url') tokens += IMAGE_PART_TOKENS;
    else if (part.type === 'input_audio') tokens += AUDIO_PART_TOKENS;
    else if (typeof part.text === 'string') tokens += estimateTextTokens(part.text);
  });
  return tokens;
}

export function estimateMessageTokens(message) {
  if (!message || typeof message !== 'object') return 0;
  return PER_MESSAGE_OVERHEAD + contentTokens(message.content);
}

export function estimateMessagesTokens(messages) {
  return (Array.isArray(messages) ? messages : []).reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0
  );
}
