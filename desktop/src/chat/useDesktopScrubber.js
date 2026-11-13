// 消息定位条（桌面）：拖动进度条快速跳到历史某条消息。
//
// 与手机 ScrollScrubber 的区别只在滚动原语：手机走 FlatList 的 scrollToOffset/scrollToEnd，
// 桌面是普通滚动容器（scrollTop / scrollHeight）。
//
// 预览的逐条缓存直接复用共享层 useScrollScrubber 导出的 buildScrubberPreview
// （它按「消息引用 + 说话人 + t」缓存，流式期间每 tick 只重算尾部一条）——那是这块
// 唯一有性能风险的地方，不在这里重写。
import { useMemo, useRef } from 'react';

import {
  buildScrubberPreview,
} from '../../../src/chat/useScrollScrubber.js';
import { ASSISTANT_ID, USER_ID } from '../../../src/chat/chatConstants.js';
import { indexFromRatio } from '../../../src/chat/scrollScrubberMath.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';

export default function useDesktopScrubber({ messages, characterName, scrollRef, searchFocusedId }) {
  const { t } = useTranslation();
  const rafRef = useRef(0);

  // 可定位的消息（排除 pending 与工具/系统气泡），与手机同一过滤口径。
  const scrubberMessages = useMemo(
    () => (Array.isArray(messages) ? messages : []).filter(message => (
      message
      && !message.pending
      && (message.role === USER_ID || message.role === ASSISTANT_ID)
    )),
    [messages]
  );

  const previews = useMemo(
    () => scrubberMessages.map(message => buildScrubberPreview(message, characterName, t)),
    [scrubberMessages, characterName, t]
  );

  // 滚到某条消息：复用 ChatPane 的 data-message-id 锚点（与搜索同一套）。
  const seek = index => {
    const target = scrubberMessages[index];
    if (!target || !target.id) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const root = scrollRef.current;
      if (!root) return;
      const node = root.querySelector(`[data-message-id="${String(target.id).replace(/"/g, '\\"')}"]`);
      if (node && typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
  };

  const seekByRatio = ratio => seek(indexFromRatio(ratio, scrubberMessages.length));

  const toStart = () => {
    const root = scrollRef.current;
    if (root) root.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const toEnd = () => {
    const root = scrollRef.current;
    if (root) root.scrollTo({ top: root.scrollHeight, behavior: 'smooth' });
  };

  return {
    scrubberMessages,
    previews,
    seek,
    seekByRatio,
    toStart,
    toEnd,
    // searchFocusedId 仅为与搜索共用「当前聚焦」语义而透传（定位条不自己维护一份）。
    focusedId: searchFocusedId || '',
  };
}