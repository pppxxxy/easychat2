// 按消息引用增量维护的派生容器（2026-10-17，性能；2026-10-18 迁移到统一引擎）。
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
// 2026-10-18（结构 1 批次 2）：三个工厂共用的「同引用返回 + 前缀比对 + 状态维护」骨架
// 上收到 createListDerivation，本文件只保留各自**真正的业务语义**（怎么复用前缀、算出来
// 是什么形状）。此前三处各抄一份 prefixLength 与 prevList/prevOut 状态，改一处漏两处。
//
// 语义与改造前**逐字节等价**：tests/messageDerivations.test.mjs 保留着改造前的全量实现
// 作为参照，含 200 轮随机序列（追加/尾部更新/中间编辑/截断）逐轮比对。
import { createListDerivation } from './messageDerivationStore.js';

// ---- rawTextById：id → String(text) ----
// 语义与原来逐字一致：只收「有 id 的消息」，text 走 String(text ?? '')。
export function createRawTextIndex() {
  return createListDerivation({
    compute: (list, reusable, previous) => {
      // 前缀可复用时在旧 Map 上增量改；否则（含首次）新建。
      // 注意：Map 必须**新建或复制**，不能就地改旧 Map——旧的可能仍被上一次渲染的
      // 子组件持有（MessageBubble 读 rawTextById.get(id)），就地改会让它读到新值。
      const map = reusable > 0 && previous ? new Map(previous) : new Map();
      for (let i = reusable; i < list.length; i += 1) {
        const message = list[i];
        if (message && message.id) map.set(message.id, String(message.text ?? ''));
      }
      // 数组变短时，尾部残留的 id 必须删掉（否则已删除的消息仍能查到正文）。
      // 按 list 里实际存在的 id 清理（不能只看长度：中间删一条时长度也会变）。
      if (reusable > 0) {
        const alive = new Set();
        for (const message of list) if (message && message.id) alive.add(message.id);
        for (const id of [...map.keys()]) if (!alive.has(id)) map.delete(id);
      }
      return map;
    },
  });
}

// ---- regenerableIds：USER 之后才有可重生的 ASSISTANT ----
// 语义与原来逐字一致：遇到 USER 置 hasUser，之后的 ASSISTANT 都进集合。
export function createRegenerableIndex() {
  return createListDerivation({
    compute: (list, reusable, previous) => {
      const set = reusable > 0 && previous ? new Set(previous) : new Set();
      // hasUser 是「前缀里是否出现过 USER」——必须从头重新确认，不能凭集合猜：
      // 前缀里可能一条 ASSISTANT 都没有（集合为空）但 hasUser 已为真。
      let hasUser = false;
      for (let i = 0; i < reusable; i += 1) {
        const item = list[i];
        if (item && item.role === 'user') hasUser = true;
      }
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
      if (reusable > 0) {
        const alive = new Set();
        for (const message of list) if (message && message.id) alive.add(message.id);
        for (const id of [...set]) if (!alive.has(id)) set.delete(id);
      }
      return set;
    },
  });
}

// ---- scrubberMessages：非 pending 且 role 为 user/assistant ----
export function createScrubberListIndex() {
  const keep = message => !!message
    && !message.pending
    && (message.role === 'user' || message.role === 'assistant');
  return createListDerivation({
    compute: (list, reusable, previous) => {
      let out;
      if (reusable > 0 && previous) {
        // 前缀引用未变 ⇒ 那些项的判定结果也不变。重新数一遍前缀里筛出多少条（O(前缀)，
        // 但只做计数、不重建对象），然后切片复用。
        let count = 0;
        for (let i = 0; i < reusable; i += 1) if (keep(list[i])) count += 1;
        out = previous.slice(0, count);
      } else {
        out = [];
      }
      for (let i = reusable; i < list.length; i += 1) {
        if (keep(list[i])) out.push(list[i]);
      }
      return out;
    },
  });
}
