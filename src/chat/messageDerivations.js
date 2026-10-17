// 按消息引用增量维护的派生容器（2026-10-17，性能）。
//
// 背景：ChatScreen 有三个「每 tick 重建」的派生值——rawTextById（Map）、regenerableIds
// （Set）、scrubberMessages（filter 出的数组）。它们都依赖整个 messages 数组，而流式
// 期间每 tick 都换引用 ⇒ 每 tick 全量重建。实测（2000 条 × 300 字中文历史）：
//   rawTextById 0.12 ms/tick、regenerableIds 0.05 ms/tick，合计约帧预算的 1%。
// 数字不大，但它们是**纯浪费**：流式每 tick 只有尾部一条是新引用。
//
// 做法：保留上一次的结果 + 上一次处理的 messages 数组，新的 messages 与旧的做**前缀
// 引用比对**（逐位 ===），只在第一处不一致的地方之后重建，前缀结果直接复用。
// 三种情况：
//   ① 尾部追加/更新（流式最常见）：前缀全部相同 ⇒ 只算新尾部，O(增量)；
//   ② 中间某条变了（编辑消息）：从该位置起重算，前缀仍复用；
//   ③ 数组变短或引用全变（切会话）：从头重算，等价于全量。
//
// 结构参照 compaction.js 的 createMessageBytesEstimator（引用比对 + 必要时重建），
// 不发明新形状。**不设清空定时器**：缓存挂在调用方自己的 ref 上，随组件卸载一起回收。

// 返回「前多少条可以复用」的下标。要求 prevList[i] === nextList[i] 逐位相同。
function prefixLength(prevList, nextList) {
  if (!Array.isArray(prevList) || !Array.isArray(nextList)) return 0;
  const max = Math.min(prevList.length, nextList.length);
  let i = 0;
  while (i < max && prevList[i] === nextList[i]) i += 1;
  return i;
}

// ---- rawTextById：id → String(text) ----
// 语义与原来逐字一致：只收「有 id 的消息」，text 走 String(text ?? '')。
export function createRawTextIndex() {
  let prevList = null;
  let prevMap = null;
  return function getRawTextById(messages) {
    const list = Array.isArray(messages) ? messages : [];
    if (prevList === list && prevMap) return prevMap;
    const reusable = prefixLength(prevList, list);
    // 前缀可复用时在旧 Map 上增量改；否则（含首次）新建。
    // 注意：Map 必须**新建或复制**，不能就地改旧 Map——旧的可能仍被上一次渲染的
    // 子组件持有（MessageBubble 读 rawTextById.get(id)），就地改会让它读到新值。
    const map = reusable > 0 && prevMap ? new Map(prevMap) : new Map();
    for (let i = reusable; i < list.length; i += 1) {
      const message = list[i];
      if (message && message.id) map.set(message.id, String(message.text ?? ''));
    }
    // 数组变短时，尾部残留的 id 必须删掉（否则已删除的消息仍能查到正文）。
    if (reusable > 0 && prevList && prevList.length > list.length) {
      const alive = new Set();
      for (const message of list) if (message && message.id) alive.add(message.id);
      for (const id of [...map.keys()]) if (!alive.has(id)) map.delete(id);
    }
    prevList = list;
    prevMap = map;
    return map;
  };
}

// ---- regenerableIds：USER 之后才有可重生的 ASSISTANT ----
// 语义与原来逐字一致：遇到 USER 置 hasUser，之后的 ASSISTANT 都进集合。
export function createRegenerableIndex() {
  let prevList = null;
  let prevSet = null;
  return function getRegenerableIds(messages) {
    const list = Array.isArray(messages) ? messages : [];
    if (prevList === list && prevSet) return prevSet;
    const reusable = prefixLength(prevList, list);
    const set = reusable > 0 && prevSet ? new Set(prevSet) : new Set();
    // hasUser 是「前缀里是否出现过 USER」——必须从头重新确认，不能凭集合猜：
    // 前缀里可能一条 ASSISTANT 都没有（集合为空）但 hasUser 已为真。
    let hasUser = false;
    for (let i = 0; i < reusable; i += 1) {
      const item = list[i];
      if (item && item.role === 'user') hasUser = true;
    }
    if (reusable === 0) hasUser = false;
    for (let i = reusable; i < list.length; i += 1) {
      const item = list[i];
      if (!item) continue;
      if (item.role === 'user') {
        hasUser = true;
      } else if (item.role === 'assistant' && hasUser) {
        set.add(item.id);
      }
    }
    // 数组变短：集合里已不存在的 id 要删掉。
    if (reusable > 0 && prevList && prevList.length > list.length) {
      const alive = new Set();
      for (const message of list) if (message && message.id) alive.add(message.id);
      for (const id of [...set]) if (!alive.has(id)) set.delete(id);
    }
    prevList = list;
    prevSet = set;
    return set;
  };
}

// ---- scrubberMessages：非 pending 且 role 为 user/assistant ----
export function createScrubberListIndex() {
  let prevList = null;
  let prevOut = null;
  return function getScrubberMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    if (prevList === list && prevOut) return prevOut;
    const reusable = prefixLength(prevList, list);
    let keep = 0;
    let out;
    if (reusable > 0 && prevOut) {
      // 前缀引用未变 ⇒ 那些项的判定结果也不变。重新数一遍前缀里筛出多少条（O(前缀)，
      // 但只做计数、不重建对象），然后切片复用。
      for (let i = 0; i < reusable; i += 1) {
        const message = list[i];
        if (message && !message.pending && (message.role === 'user' || message.role === 'assistant')) {
          keep += 1;
        }
      }
      out = prevOut.slice(0, keep);
    } else {
      out = [];
    }
    for (let i = reusable; i < list.length; i += 1) {
      const message = list[i];
      if (message && !message.pending && (message.role === 'user' || message.role === 'assistant')) {
        out.push(message);
      }
    }
    prevList = list;
    prevOut = out;
    return out;
  };
}
