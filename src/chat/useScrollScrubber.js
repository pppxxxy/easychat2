// 快速定位滑动条的状态与回调。2026-09-27 从 ChatScreen 抽出（无行为变化）。
//
// 共享的滚动基础设施（scrollRef / messageOffsetsRef / scrollToMessage）仍由
// ChatScreen 持有并通过参数注入——它们同时服务搜索定位与引用跳转，不归本 hook 所有。

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
  messageOffsetsRef,
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
    const offset = messageOffsetsRef.current[target.id];
    if (typeof offset === 'number') {
      scrollRef.current?.scrollTo?.({ y: Math.max(0, offset - 80), animated: true });
    } else {
      scrollToMessage(target.id);
    }
  }, [scrubberMessages, scrollToMessage]);

  const onScrubberToStart = useCallback(() => {
    scrollRef.current?.scrollTo?.({ y: 0, animated: true });
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
