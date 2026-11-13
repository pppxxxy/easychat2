// 对话内搜索（桌面）：状态 + 命中 + 跳转。纯逻辑全在共享层 chatSearchMath.js。
//
// 与手机 useChatSearch 的差别只在「跳转」这一件事：
//   · 手机走 FlatList 的 scrollToIndex（虚拟列表，目标可能被窗口化切走，要扩窗重试）；
//   · 桌面是普通滚动容器，所有消息都在 DOM 里，直接 scrollIntoView 即可。
// 命中集合与推进口径**逐字复用共享层**，不在这里重写（否则两端口径会漂）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { advanceMatchIndex, collectSearchMatchIds } from '../../../src/chat/chatSearchMath.js';

export default function useDesktopChatSearch({ messages, scrollRef }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const lastSignatureRef = useRef('');

  // open 传进纯函数：搜索关闭时直接短路，不做全历史扫描（共享层的既有优化）。
  const matches = useMemo(
    () => collectSearchMatchIds(messages, query, open),
    [messages, query, open]
  );
  // 命中集合的稳定签名：messages 在流式期间每 tick 都是新数组，
  // 直接依赖 matches 会在回复期间不断把下标重置回 0（共享层已解释过这个坑）。
  const signature = useMemo(() => matches.join('\n'), [matches]);

  // 当前聚焦的消息：**派生**，不额外存一份（两份状态迟早不一致）。
  // 下标越界时（命中集合缩小）回落到最后一条。
  const safeIndex = matches.length === 0
    ? 0
    : Math.min(Math.max(0, activeMatchIndex), matches.length - 1);
  const focusedId = open && matches.length > 0 ? String(matches[safeIndex]) : '';

  // 滚动到某条消息：等下一帧，让高亮边框先落到 DOM 上。
  const scrollToMessage = useCallback(id => {
    if (!id) return;
    requestAnimationFrame(() => {
      const root = scrollRef.current;
      if (!root) return;
      const node = root.querySelector(`[data-message-id="${String(id).replace(/"/g, '\\"')}"]`);
      if (!node || typeof node.scrollIntoView !== 'function') return;
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, [scrollRef]);

  // 命中集合变化（输入了新查询、或消息被删）时回到第一条并滚过去。
  // 依赖签名而不是 matches 数组引用：流式期间尾部消息每 tick 变引用，但签名通常不变。
  useEffect(() => {
    if (!open) return;
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;
    setActiveMatchIndex(0);
    if (matches.length > 0) scrollToMessage(matches[0]);
  }, [open, signature, matches, scrollToMessage]);

  // 下标变化时（上/下条）跟着滚——但与「集合变化」那条分开，否则同一 tick 会滚两次。
  const lastIndexRef = useRef(0);
  useEffect(() => {
    if (!open) return;
    if (lastIndexRef.current === activeMatchIndex) return;
    lastIndexRef.current = activeMatchIndex;
    if (matches.length > 0) scrollToMessage(matches[Math.min(activeMatchIndex, matches.length - 1)]);
  }, [open, activeMatchIndex, matches, scrollToMessage]);

  const goToMatch = useCallback(delta => {
    if (matches.length === 0) return;
    setActiveMatchIndex(advanceMatchIndex(activeMatchIndex, delta, matches.length));
  }, [activeMatchIndex, matches]);

  const openSearch = useCallback(() => {
    setOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveMatchIndex(0);
    lastSignatureRef.current = '';
    lastIndexRef.current = 0;
  }, []);

  const changeQuery = useCallback(value => {
    setQuery(String(value ?? ''));
    setActiveMatchIndex(0);
    lastIndexRef.current = 0;
  }, []);

  return {
    open,
    query,
    matches,
    matchCount: matches.length,
    activeMatchIndex: safeIndex,
    focusedId,
    openSearch,
    closeSearch,
    changeQuery,
    prev: () => goToMatch(-1),
    next: () => goToMatch(1),
  };
}