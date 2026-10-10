// 自动压缩的空闲触发（从 ChatScreen 外提，Z 系采纳 #5）。
//
// 触发口径：token 预算（窗口 − 输出预留 − 缓冲，见 compactionPolicy.js），不再是固定比例。
// 两步走：先试**本地微压缩**（零 API 调用，压得下来就完事），压不动再走模型摘要。
// 只在**空闲时**触发（不在发送路径上做），避免「压缩替换消息」与「发送读消息」的时序竞态；
// 同一消息条数只尝试一次，防死循环。

import { useEffect, useMemo, useRef } from 'react';

import { resolveAutoCompactPolicy, shouldAutoCompactByBudget } from './compactionPolicy.js';
import { estimateHistoryTokens } from './contextUsage.js';
import { microcompactMessages } from './microcompact.js';

export default function useAutoCompact({
  enabled,
  contextUsage,
  isSending,
  messages,
  messagesRef,
  setMessages,
  compactBusyRef,
  onCompact,
}) {
  const policy = useMemo(
    () => resolveAutoCompactPolicy({ contextWindow: contextUsage.window }),
    [contextUsage.window]
  );
  const attemptRef = useRef(-1);

  useEffect(() => {
    if (enabled === false) return;
    if (!shouldAutoCompactByBudget(contextUsage.tokens, policy)) return;
    if (isSending || compactBusyRef.current) return;
    if (attemptRef.current === messages.length) return;
    attemptRef.current = messages.length;
    const micro = microcompactMessages(messagesRef.current);
    if (micro.compacted && estimateHistoryTokens(micro.messages) < policy.thresholdTokens) {
      setMessages(micro.messages);
      return;
    }
    onCompact({ silent: true });
  }, [enabled, contextUsage.tokens, policy, isSending, messages.length, messagesRef, setMessages, compactBusyRef, onCompact]);
}
