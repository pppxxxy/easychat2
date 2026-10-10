// 本地微压缩（Z 系采纳 #5，对照 zai-org/ZCode 的 microcompact）：
// **不调模型**，只把「旧的、超长的」消息内容就地截断（保留首尾 + 明确标记），
// 把上下文压下来。比模型摘要便宜得多（零 API 调用、零延迟），应作为第一手段；
// 压不动再走模型摘要（compaction.js）。
//
// 三条保护（都不可协商）：
// - 最近 keepRecent 条**不动**：那是当前任务的「工作台」，压了模型立刻失忆；
// - system 消息不动：人设/世界书/格式约束丢了等于换了个人；
// - 只压超过 minChars 的消息；截断保留首尾（结论常在末尾）。
//
// 纯模块：零 import、零原生依赖，Node 直测。

export const MICROCOMPACT_MIN_CHARS = 2000;
export const MICROCOMPACT_HEAD_CHARS = 600;
export const MICROCOMPACT_TAIL_CHARS = 300;
export const MICROCOMPACT_KEEP_RECENT = 8;
export const MICROCOMPACT_MARKER = '…（中间内容已省略：本条原文过长，只保留首尾）…';

function textOf(item) {
  if (!item || typeof item !== 'object') return '';
  return String(item.text === undefined || item.text === null ? (item.content || '') : item.text);
}

// 返回 { messages, compacted, savedChars, compactedCount }。
// compacted=false 时 messages 原样返回（同一引用）——调用方据此零成本判断「压不动」。
export function microcompactMessages(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const minChars = Number.isFinite(Number(options.minChars)) ? Math.max(0, Math.floor(Number(options.minChars))) : MICROCOMPACT_MIN_CHARS;
  const head = Number.isFinite(Number(options.headChars)) ? Math.max(0, Math.floor(Number(options.headChars))) : MICROCOMPACT_HEAD_CHARS;
  const tail = Number.isFinite(Number(options.tailChars)) ? Math.max(0, Math.floor(Number(options.tailChars))) : MICROCOMPACT_TAIL_CHARS;
  const keepRecent = Number.isFinite(Number(options.keepRecent)) ? Math.max(0, Math.floor(Number(options.keepRecent))) : MICROCOMPACT_KEEP_RECENT;
  // 最近 keepRecent 条的边界：索引 < 该值的不动。
  const frozenFrom = Math.max(0, list.length - keepRecent);

  let compactedCount = 0;
  let savedChars = 0;
  const out = list.map((item, index) => {
    if (index >= frozenFrom) return item;
    if (!item || typeof item !== 'object') return item;
    if (item.role === 'system') return item;
    const text = textOf(item);
    if (text.length <= minChars) return item;
    if (text.length <= head + tail + MICROCOMPACT_MARKER.length) return item;
    const clipped = `${text.slice(0, head)}${MICROCOMPACT_MARKER}${text.slice(text.length - tail)}`;
    compactedCount += 1;
    savedChars += text.length - clipped.length;
    // 保留原对象其余字段（role/id/时间戳等），只换正文。
    return item.text !== undefined ? { ...item, text: clipped } : { ...item, content: clipped };
  });

  if (compactedCount === 0) {
    return { messages: list, compacted: false, savedChars: 0, compactedCount: 0 };
  }
  return { messages: out, compacted: true, savedChars, compactedCount };
}
