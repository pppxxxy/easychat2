// 聊天内搜索的状态与回调。2026-09-27 从 ChatScreen 抽出（无行为变化）。
//
// 共享的跳转与焦点锚点（scrollToMessage / focusedMessageId）不归本 hook 所有——
// 引用跳转与消息删除清理也会用到它们，因此由 ChatScreen 持有并通过参数注入。
// 保留原依赖数组（scrollToMessage 为稳定 useCallback）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { advanceMatchIndex, collectSearchMatchIds, NO_MATCHES } from './chatSearchMath.js';

export default function useChatSearch({ messages, scrollToMessage, setFocusedMessageId }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);

  // searchOpen 传进纯函数：面板关闭时直接短路，**不做全历史扫描**（见 chatSearchMath 的说明）。
  const searchMatches = useMemo(
    () => collectSearchMatchIds(messages, searchQuery, searchOpen),
    [messages, searchQuery, searchOpen]
  );
  // 用「命中 id 拼接」作为稳定依赖：messages 在流式回复期间每个 token 都会变，
  // 直接依赖 searchMatches 数组引用会让 effect 反复重跑，把用户点「下一条」的
  // activeMatchIndex 不断重置回 0。只有在命中集合真正变化时才重定位。
  //
  // 命中集合不变时**返回同一个字符串引用**：不再每 tick 重拼一遍全列表。
  // 判据是「上一次的数组引用 + 上一次的拼接结果」——collectSearchMatchIds 在命中集合
  // 未变时并不保证返回同一数组（流式时尾部那条会重新命中，数组仍是新的），所以这里
  // 再比一次内容（join 本身只在**引用变了**时才跑，且用 ref 记住上次结果）。
  const signatureRef = useRef({ source: NO_MATCHES, signature: '' });
  const searchMatchSignature = useMemo(() => {
    const previous = signatureRef.current;
    if (previous.source === searchMatches) return previous.signature;
    const signature = searchMatches.join('\n');
    signatureRef.current = { source: searchMatches, signature };
    return signature;
  }, [searchMatches]);

  const goToMatch = useCallback(delta => {
    if (searchMatches.length === 0) return;
    const next = advanceMatchIndex(activeMatchIndex, delta, searchMatches.length);
    setActiveMatchIndex(next);
    setFocusedMessageId(searchMatches[next]);
    scrollToMessage(searchMatches[next]);
  }, [activeMatchIndex, searchMatches, scrollToMessage]);

  useEffect(() => {
    if (!searchOpen) return;
    const query = searchQuery.trim();
    if (!query) {
      setActiveMatchIndex(0);
      setFocusedMessageId('');
      return;
    }
    setActiveMatchIndex(0);
    if (searchMatches.length > 0) {
      setFocusedMessageId(searchMatches[0]);
      scrollToMessage(searchMatches[0]);
    } else {
      setFocusedMessageId('');
    }
  }, [searchOpen, searchQuery, searchMatchSignature, scrollToMessage, setFocusedMessageId]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setActiveMatchIndex(0);
    setFocusedMessageId('');
  }, []);

  return {
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    activeMatchIndex,
    setActiveMatchIndex,
    searchMatches,
    goToMatch,
    closeSearch,
  };
}
