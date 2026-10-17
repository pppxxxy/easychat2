// 展示文本缓存：按消息引用缓存「应用正则脚本后的显示文本」。
//
// 2026-10-18（结构 1 批次 2）：内部改用统一派生引擎 messageDerivationStore。
// 语义与改造前**逐字节等价**（由 tests/messageDerivationEquivalence.test.mjs 的
// 「重算次数也必须一致」钉住，300 轮随机序列 203 = 203）。
import { createMessageDerivation } from '../chat/messageDerivationStore.js';

// 键里的 depth 只在**真的有正则脚本**时才需要。applyRegexScripts 对空脚本原样返回
//（prompt/regexEngine.js:292），所以没有脚本时展示文本与 depth 无关。
//
// 为什么这一点很要紧（2026-10-17 实测）：ChatScreen 的调用点算的是
// `depth = messages.length - 1 - index`，而 messages 每追加一条，**所有**消息的 depth 都 +1
// ⇒ 键全变、全历史重算，且旧键只增不减地留在每条消息的缓存里。用探针跑真实函数：
//   追加 N 条消息的累计重算次数 = N(N+1)/2（N=1000 时 500,500 次，比理想值放大 501 倍），
//   缓存条目同样是 500,500 个（按每条约百字节算是几十 MB 级的常驻增长）。
// 无脚本时改用与 depth 无关的键：每条消息每 placement 恒定一条缓存，
// 追加消息不再触发任何重算。**有脚本时行为一字不变**（depth 仍进键）。
//
// 改造前是「键 + 命中时再比一次 scripts 引用」两层判据，现在合成一个键数组：
//   [placement, 'static']            无脚本
//   [placement, depth, scripts]      有脚本（scripts 按引用比 —— 引擎默认 equals 逐项 ===）
// 两层合成一层后语义不变，但**只写对一次**（这正是本批收敛的目的）。
const deriveDisplayText = createMessageDerivation({
  key: (message, scripts, placement, depth) => {
    const hasScripts = Array.isArray(scripts) && scripts.length > 0;
    return hasScripts ? [placement, depth, scripts] : [placement, 'static'];
  },
  compute: (message, scripts, placement, depth, compute) => compute(),
});

export function getCachedDisplayText(message, scripts, placement, depth, compute) {
  if (!message || typeof compute !== 'function') return compute ? compute() : '';
  return deriveDisplayText(message, scripts, placement, depth, compute);
}
