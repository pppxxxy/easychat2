// 聊天内搜索的状态与回调。2026-09-27 从 ChatScreen 抽出（无行为变化）。
//
// 共享的跳转与焦点锚点（scrollToMessage / focusedMessageId）不归本 hook 所有——
// 引用跳转与消息删除清理也会用到它们，因此由 ChatScreen 持有并通过参数注入。
// 保留原依赖数组（scrollToMessage 为稳定 useCallback）。

import { useCallback, useEffect, useMemo, useState } from 'react';

import { getMessagePromptText } from '../chatMedia';
import { ASSISTANT_ID, USER_ID } from './chatConstants';

export default function useChatSearch({ messages, scrollToMessage, setFocusedMessageId }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);

  const searchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    return messages
      .filter(message => (
        message
        && (message.role === USER_ID || message.role === ASSISTANT_ID)
        && getMessagePromptText(message).toLowerCase().includes(query)
      ))
      .map(message => message.id);
  }, [messages, searchQuery]);

  const goToMatch = useCallback(delta => {
    if (searchMatches.length === 0) return;
    const next = (activeMatchIndex + delta + searchMatches.length) % searchMatches.length;
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
  }, [searchOpen, searchQuery, searchMatches, scrollToMessage]);

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
