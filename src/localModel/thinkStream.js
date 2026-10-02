// 本地推理模型的「思考流」解析（纯函数，Node 可测）。
//
// DeepSeek-R1 / QwQ 等本地推理模型不提供 reasoning_content 字段，而是把思考
// 过程以内联标签输出。两种实际形态：
// 1. 完整标签：输出以 <think> 开头、</think> 结束，之后才是正文；
// 2. 只有闭合标签（Qwen3 系常见）：聊天模板把 <think> 放进生成前缀，模型
//    实际只生成「思考 + </think> + 正文」——输出里看不到开标签。
// 形态 2 若不处理，思考会被整段当成正文。两种都剥离后，思考走 reasoning、
// 正文走 text；正文中途出现的孤立 <think> 视为普通文本。

export const THINK_OPEN_TAG = '<think>';
export const THINK_CLOSE_TAG = '</think>';

// 一次性拆分完整输出：思考过程与正文分离。未闭合的 <think> 视为仍在思考
// （正文为空）。闭合标签后紧跟的单个换行是模型惯常排版，剥掉一个。
export function splitThinkContent(raw, { openTag = THINK_OPEN_TAG, closeTag = THINK_CLOSE_TAG } = {}) {
  const value = String(raw ?? '');
  const open = String(openTag || '');
  const close = String(closeTag || '');
  const wsMatch = value.match(/^\s*/);
  const coreStart = wsMatch ? wsMatch[0].length : 0;
  const hasOpenAtStart = Boolean(open) && value.startsWith(open, coreStart);
  if (hasOpenAtStart) {
    const rest = value.slice(coreStart + open.length);
    if (!close) return { reasoning: rest, text: '' };
    const closeIndex = rest.indexOf(close);
    if (closeIndex < 0) {
      return { reasoning: rest, text: '' };
    }
    const after = rest.slice(closeIndex + close.length);
    return {
      reasoning: rest.slice(0, closeIndex),
      text: after.replace(/^\r?\n/, ''),
    };
  }
  // 形态 2：无起始开标签但存在闭合标签 —— 开标签在聊天模板的生成前缀里，
  // 闭合之前的全部内容是思考，之后的是正文。
  if (close && !hasOpenAtStart) {
    const closeIndex = value.indexOf(close);
    if (closeIndex >= 0) {
      return {
        reasoning: value.slice(0, closeIndex),
        text: value.slice(closeIndex + close.length).replace(/^\r?\n/, ''),
      };
    }
  }
  return { reasoning: '', text: value };
}

// 流式拆分器：逐 token push，随时读取当前的思考与正文视图。
// 内部持有原始累积串，视图按需重算（聊天规模下开销可忽略），正确性优先。
export function createThinkSplitter(options = {}) {
  let raw = '';
  return {
    push(token) {
      raw += String(token ?? '');
      return this;
    },
    raw() {
      return raw;
    },
    text() {
      return splitThinkContent(raw, options).text;
    },
    reasoning() {
      return splitThinkContent(raw, options).reasoning;
    },
  };
}
