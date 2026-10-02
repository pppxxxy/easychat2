// 从 ChatScreen.js 原样外提（无行为变化）：回复编排中的纯逻辑。
// 供 requestReply / requestGroupReply（useChatSend，后续外提）与 Node 测试共用。

import { SYSTEM_ERROR_ID } from './chatConstants.js';
import {
  buildErrorRawText,
  settlePendingMessage,
} from './chatHelpers.js';
import { maskSecrets } from '../secrets.js';

// 注意：本模块必须保持 Node 可加载（Node 测试直接 import）。
// 因此不能 import api.js（expo 依赖链），错误分类器由调用方注入。

// 摘要边界裁剪：summarizedUpTo 指向的消息之后的历史作为“原文已发送”保留，
// 更早区间（与其它会话）才交给向量召回，避免同一内容既当原文又当“相关记忆”。
export function trimHistoryByBoundary(historyMessages, boundary) {
  const list = Array.isArray(historyMessages) ? historyMessages : [];
  const boundaryIndex = boundary
    ? list.findIndex(item => item.id === boundary)
    : -1;
  const trimmedHistory = boundaryIndex >= 0 ? list.slice(boundaryIndex + 1) : list;
  const sentIds = new Set(
    trimmedHistory.map(item => String((item && item.id) || ''))
  );
  return { trimmedHistory, sentIds };
}

// 流式增量合并：文本 token 只更新仍处于 pending 的占位符（waitingForResponse 随首个 token 落地）。
export function mergeStreamedText(messages, pendingId, fullText) {
  return (messages || []).map(item => (
    item && item.id === pendingId && item.pending
      ? { ...item, text: fullText, waitingForResponse: false }
      : item
  ));
}

// 流式增量合并：思考摘要与文本不同，不检查 pending（占位符期间也持续覆写）。
export function mergeStreamedReasoning(messages, pendingId, fullReasoning) {
  return (messages || []).map(item => (
    item && item.id === pendingId
      ? { ...item, reasoning: fullReasoning }
      : item
  ));
}

// 用解析后的回复分段替换 pending 占位符；回复为空时落「没有收到回复。」。
// 注意：与原实现一致，即使未命中占位符也返回新数组（保持既有重渲染节奏）。
export function replacePendingWithReply(messages, pendingId, replyParts) {
  const next = [];
  (messages || []).forEach(item => {
    if (item && item.id === pendingId) {
      if (!Array.isArray(replyParts) || replyParts.length === 0) {
        next.push({ ...item, text: '没有收到回复。', pending: false, waitingForResponse: false });
      } else {
        replyParts.forEach(part => next.push({ ...part, pending: false, waitingForResponse: false }));
      }
    } else {
      next.push(item);
    }
  });
  return next;
}

// 错误分类：配置变更（静默撤占位符）/ 用户取消（保留已生成内容）/ 真失败（错误气泡）。
// 两个判定器由调用方注入（api.js 的 isConfigChangedError / isCanceledError）。
export function classifyReplyError(error, isConfigChangedError, isCanceledError) {
  if (isConfigChangedError && isConfigChangedError(error)) return 'config-changed';
  if (isCanceledError && isCanceledError(error)) return 'canceled';
  return 'failure';
}

// 构造错误气泡：原文经 maskSecrets 后存 errorRawRef，气泡 detail 只放脱敏文本。
export function buildReplyErrorMessage(pendingId, error) {
  const rawText = buildErrorRawText(error);
  return {
    message: {
      id: `${pendingId}-error`,
      role: SYSTEM_ERROR_ID,
      text: '请求失败，点击查看详情',
      detail: maskSecrets(rawText),
      timestamp: Date.now(),
    },
    rawText,
  };
}

// 错误合并：占位符已有部分内容（settle 后仍在）则落盘并追加错误条目，否则整条替换。
export function mergeErrorMessage(messages, pendingId, errorMessage) {
  const settled = settlePendingMessage(messages || [], pendingId);
  const keptPartial = settled.some(item => item && item.id === pendingId);
  if (keptPartial) return settled.concat(errorMessage);
  return (messages || []).map(item => (
    item && item.id === pendingId ? errorMessage : item
  ));
}

// 自动摘要的输入：基础消息 + 回复分段（空回复以「没有收到回复。」占位参与）。
export function buildAutoSummaryInput(baseMessages, replyParts, pendingAssistantMessage) {
  return [
    ...(baseMessages || []),
    ...((!Array.isArray(replyParts) || replyParts.length === 0)
      ? [{ ...pendingAssistantMessage, text: '没有收到回复。', pending: false, waitingForResponse: false }]
      : replyParts.map(part => ({ ...part, pending: false, waitingForResponse: false }))),
  ];
}
