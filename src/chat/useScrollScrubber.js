// 快速定位滑动条的状态与回调。2026-09-27 从 ChatScreen 抽出（无行为变化）。
//
// 共享的滚动基础设施（scrollRef / scrollToMessage）仍由 ChatScreen 持有并通过参数注入
// ——它们同时服务搜索定位与引用跳转，不归本 hook 所有。
// 2026-10-12：消息列表虚拟化后不再有逐条 messageOffsetsRef（窗口外的项没有 onLayout），
// 定位一律走 scrollToMessage（内部按当前窗口现算 index → FlatList.scrollToIndex）。

import { useCallback, useMemo, useState } from 'react';

import { getMessagePromptText } from './chatMedia.js';
import { ASSISTANT_ID, USER_ID } from './chatConstants.js';
import { formatScrubberTime, messageTimestamp } from './chatHelpers.js';

export default function useScrollScrubber({
  messages,
  characterName,
  // 定位预览里的说话人兜底文案（「我」/「角色」）走 i18n：由宿主传入 t。
  t,
  scrollRef,
  scrollToMessage,
}) {
  const [scrubberOpen, setScrubberOpen] = useState(false);

  const scrubberMessages = useMemo(
    () => messages.filter(message => (
      message
      && !message.pending
      && (message.role === USER_ID || message.role === ASSISTANT_ID)
    )),
    [messages]
  );

  const scrubberPreviews = useMemo(
    () => scrubberMessages.map(message => {
      const timestamp = messageTimestamp(message);
      return {
        label: formatScrubberTime(timestamp),
        speaker: message.role === USER_ID
          ? t('chat.bubble.me')
          : (characterName || t('common.characterFallback')),
        text: getMessagePromptText(message).replace(/\s+/g, ' ').trim().slice(0, 60),
      };
    }),
    [scrubberMessages, characterName, t]
  );

  const onScrubberSeek = useCallback(index => {
    const target = scrubberMessages[index];
    if (!target) return;
    // 虚拟化后没有逐条偏移缓存可读：一律走 scrollToMessage（按当前窗口现算 index）。
    // 目标被窗口化切走时由它扩窗重试，与搜索命中/引用跳转同一条链路。
    scrollToMessage(target.id);
  }, [scrubberMessages, scrollToMessage]);

  const onScrubberToStart = useCallback(() => {
    // FlatList 的 ref 上没有 scrollTo（VirtualizedList 只暴露 scrollToOffset /
    // scrollToIndex / scrollToEnd）——沿用旧的 scrollTo({ y: 0 }) 会静默变成空操作，
    // 「跳到开头」按钮就此失效。
    scrollRef.current?.scrollToOffset?.({ offset: 0, animated: true });
  }, []);

  const onScrubberToEnd = useCallback(() => {
    scrollRef.current?.scrollToEnd?.({ animated: true });
  }, []);

  return {
    scrubberOpen,
    setScrubberOpen,
    scrubberMessages,
    scrubberPreviews,
    onScrubberSeek,
    onScrubberToStart,
    onScrubberToEnd,
  };
}
