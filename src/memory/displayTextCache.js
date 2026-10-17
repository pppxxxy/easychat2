const cache = new WeakMap();

export function getCachedDisplayText(message, scripts, placement, depth, compute) {
  if (!message || typeof compute !== 'function') return compute ? compute() : '';
  const hasScripts = Array.isArray(scripts) && scripts.length > 0;
  let entries = cache.get(message);
  if (!entries) {
    entries = new Map();
    cache.set(message, entries);
  }
  // 键里的 depth 只在**真的有正则脚本**时才需要。applyRegexScripts 对空脚本原样返回
  //（prompt/regexEngine.js:292），所以没有脚本时展示文本与 depth 无关。
  //
  // 为什么这一点很要紧（2026-10-17 实测）：ChatScreen 的调用点算的是
  // `depth = messages.length - 1 - index`，而 messages 每追加一条，**所有**消息的 depth 都 +1
  // ⇒ 键全变、全历史重算，且旧键只增不减地留在每条消息的 entries 里。用探针跑真实函数：
  //   追加 N 条消息的累计重算次数 = N(N+1)/2（N=1000 时 500,500 次，比理想值放大 501 倍），
  //   缓存条目同样是 500,500 个（按每条约百字节算是几十 MB 级的常驻增长）。
  // 无脚本时改用与 depth 无关的键：每条消息每 placement 恒定一条缓存，
  // 追加消息不再触发任何重算。**有脚本时行为一字不变**（depth 仍进键）。
  const key = hasScripts ? `${placement}\u0000${depth}` : `${placement}\u0000static`;
  const cached = entries.get(key);
  // 无脚本的键天然只承载「无脚本」的结果（有脚本会走另一个键），所以不必再比引用；
  // 这顺带解决了「sessionOwnerMissing 分支每次渲染都新建 [] 字面量」导致的逐帧失效。
  if (cached && (hasScripts ? cached.scripts === scripts : true)) return cached.result;
  const result = compute();
  entries.set(key, { scripts: hasScripts ? scripts : null, result });
  return result;
}
