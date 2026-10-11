// 消息正文的**唯一**读取口径（纯函数，零依赖，可 Node 直测）。
//
// 为什么单独成模块：仓库里同时流通两种会话消息形状——
//   · 聊天页消息（ChatScreen / MessageBubble / 发送路径）：正文在 `text`；
//   · 工作区面板消息（ChatPanel）与发给模型的 OpenAI 形态历史：正文在 `content`。
// 两种形状都要被同一批纯逻辑读（压缩、占用估算、搜索、导出），于是历史上各写各的
// 兜底，长出了三种互不相同的口径：
//   A. `item.text || item.content`      —— 空串/0 会被跳过（compaction.js）
//   B. `item.content != null ? item.content : item.text` —— content 优先（compactionPipeline.js）
//   C. `item.text`                      —— 只看 text，工作区消息直接读成空（contextUsage.js）
// 三种口径的直接后果是 2026-10-11 那次事故：压缩管线建的摘要消息只写了 `content`，
// 聊天页（读 `text`）渲染出一个**空气泡**，而管线自己读得到、测试也全绿。
//
// 口径（一处定义，全仓遵守）：
//   1. `text` 是非空字符串 → 用它（聊天页正文契约，也是「两者都有时」的优先项）；
//   2. 否则 `content` 非 null/undefined → 字符串化后用它（工作区消息 / 模型历史 / tool 消息）；
//   3. 都没有 → 空串。
// 注意第 1 条用的是「非空字符串」而不是「非空值」：`text: ''` 是**没写正文**的常见形态
// （流式占位），此时必须回落到 content，否则工作区消息会被读成空。
export function messageTextOf(message) {
  if (!message || typeof message !== 'object') return '';
  const text = message.text;
  if (typeof text === 'string' && text !== '') return text;
  const content = message.content;
  if (content === null || content === undefined) return '';
  return typeof content === 'string' ? content : String(content);
}

// 归一后的「有正文」判据（压缩计数 / 摘要保留都按这个口径，避免各写一次 trim）。
export function hasMessageText(message) {
  return messageTextOf(message).trim() !== '';
}
