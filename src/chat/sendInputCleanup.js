// 发送成功后的「清空输入 + 清草稿」：从 useChatSend 外提（纯逻辑，Node 直测）。
//
// 为什么要单独一个模块：它有一段**必须讲清楚的历史**，而 useChatSend.js 已经顶在
// 行数基线上（1960）。把这段连同它的来龙去脉搬到这里，既守住了行数纪律，也让
// 这条容易再次踩的坑有自己的门牌号——下次谁要动它，一眼能看到为什么不能写成函数式。
//
// ⚠️ 历史（2026-10-18 P0 回归，用户实测）：
// 原先这里是 `setInput(current => { if (current !== rawText) return current; ... return ''; })`。
// 那是从 useState 迁移到模块级 inputStore 时漏改的函数式更新，而 setInput 只接受值：
// 函数被 String() 归一成**源码字符串**，Hermes 下长这样 `function (a0) { [bytecode] }`
// （a0 是形参名）。结果就是「发完一条消息，输入框突然多出这段东西」。
//
// 现在的形状：调用期读取 getInput() 比较，再**传值**写入。防竞态语义与原函数式版本等价
// ——发送期间用户若改了输入，就不清空。

/**
 * 发送成功后清空输入与草稿；仅当输入仍是本次发送的文本时。
 *
 * @param {object} args
 * @param {string} args.rawText 本次发送的原始文本
 * @param {() => string} args.getInput 调用期读取当前输入
 * @param {(value: string) => void} args.setInput 写入输入（**只接受值**）
 * @param {{ current: string }} args.draftTextRef 草稿文本 ref
 * @param {(sessionId: string, text: string) => void} args.persistDraftNow 草稿持久化
 * @param {string} args.sessionId 当前会话 id
 * @returns {boolean} 是否真的清空了（false = 用户已改动输入，本次不动）
 */
export function clearInputAfterSend({
  rawText,
  getInput,
  setInput,
  draftTextRef,
  persistDraftNow,
  sessionId,
}) {
  if (getInput() !== rawText) return false;
  setInput('');
  // 发送成功即清空草稿：内容已进入消息列表，不再是待发草稿。
  if (draftTextRef) draftTextRef.current = '';
  if (typeof persistDraftNow === 'function') persistDraftNow(sessionId, '');
  return true;
}
