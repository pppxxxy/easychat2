// 「待消费的定位目标 / 引用载荷」的纯归一化：AppContext 只负责 ref+state 装配。
//
// 为什么单独成模块：这两个归一化是纯函数（无 React、无存储），直接单测比经 AppContext
// 断言源码可靠；AppContext 是 RN 组件、Node 里跑不起来，且已接近行数上限——把这段
// 纯逻辑挪出来，既不改变行为，也让组件只留「归一化 → 写 ref → 写 state」三行。
//
// 引用载荷的形状与 chat/chatHelpers.js 的 buildQuotePayload 一致（{ id, name, role, text }）。

export function normalizePendingTarget(target) {
  if (!(target && target.sessionId && target.messageId)) return null;
  return {
    sessionId: String(target.sessionId),
    messageId: String(target.messageId),
  };
}

// id 允许为空：评论不是会话内消息，点引用块不定位（onPressQuoteBlock 对空 id 直接返回）。
// 空文本（trim 后）视为无引用——调用方据此丢弃，避免挂上一条点不动的空引用。
export function normalizePendingQuote(quote) {
  if (!(quote && quote.sessionId && quote.payload)) return null;
  return {
    sessionId: String(quote.sessionId),
    payload: {
      id: String((quote.payload && quote.payload.id) || ''),
      name: String((quote.payload && quote.payload.name) || '').trim(),
      role: String((quote.payload && quote.payload.role) || 'assistant'),
      text: String((quote.payload && quote.payload.text) || '').trim(),
    },
  };
}
