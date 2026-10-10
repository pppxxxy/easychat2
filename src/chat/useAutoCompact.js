// 自动压缩的空闲触发（从 ChatScreen 外提，Z 系采纳 #5；Z/M/D 整合后）。
//
// 触发口径：**唯一来源** = compactionPolicy（阈值 min(窗口×比例, 窗口−输出预留−余量)，
// 且字节规则与 token 规则取更严者，连续失败达上限即停）。不再是各页面各写一个比例。
//
// 只做**模型摘要**这一步：更便宜的「本地微压缩」已由 agent loop 的 K1
// （agent/resultClearing：工具结果落盘 + 占位，每轮请求前跑）承担——两套微压缩只留一套。
// 只在空闲时触发（不在发送路径上做），避免「压缩替换消息」与「发送读消息」的时序竞态；
// 同一消息条数只尝试一次。

import { useEffect, useMemo, useRef } from 'react';

import {
  resolveAutoCompactPolicy,
  shouldCompactAnyRule,
  shouldStopAutoCompact,
} from './compactionPolicy.js';

export default function useAutoCompact({
  enabled,
  contextUsage,
  isSending,
  messages,
  compactBusyRef,
  onCompact,
  // 模型声明的输出上限（caps.maxOutput）——接上后阈值才是「模型感知」的。
  modelOutputCap = 0,
  // 字节口径（AsyncStorage 落盘上限）：由调用方用 compactionStatus 算好传进来。
  byteSize = 0,
  byteThreshold = 0,
}) {
  const policy = useMemo(
    () => resolveAutoCompactPolicy({
      contextWindow: contextUsage.window,
      maxOutputTokens: modelOutputCap,
    }),
    [contextUsage.window, modelOutputCap]
  );
  const attemptRef = useRef(-1);
  const failuresRef = useRef(0);

  useEffect(() => {
    if (enabled === false) return;
    if (shouldStopAutoCompact(failuresRef.current)) return;
    const decision = shouldCompactAnyRule({
      bytes: byteSize,
      tokens: contextUsage.tokens,
      byteThreshold,
      policy,
    });
    if (!decision.compact) return;
    if (isSending || compactBusyRef.current) return;
    if (attemptRef.current === messages.length) return;
    attemptRef.current = messages.length;
    Promise.resolve(onCompact({ silent: true })).then(
      result => { failuresRef.current = result && result.ok === false ? failuresRef.current + 1 : 0; },
      () => { failuresRef.current += 1; }
    );
  }, [
    enabled, contextUsage.tokens, policy, isSending, messages.length,
    byteSize, byteThreshold, compactBusyRef, onCompact,
  ]);
}
