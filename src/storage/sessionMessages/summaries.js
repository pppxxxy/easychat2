// 会话记忆摘要：摘要读写、边界推进、失效/重置/追加。
// 从 src/storage/sessionMessages.js 原样外提（纯搬运，无行为变化）。
// 摘要读取原语在叶子 summaryStore.js，消息读取在 messages.js。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { tActive } from '../../i18n/index.js';
import {
  bumpSessionSummaryRevision,
  enqueueSessionMutation,
  isSessionSummaryRevisionCurrent,
  requireSessions,
  saveSessionsInternal,
  sessionSummariesKey,
} from '../sessionCore.js';
import {
  getSessionSummariesStatus,
  normalizeSessionSummary,
} from './summaryStore.js';
import { getMessagesBySession } from './messages.js';

// 公开导出面：getSessionSummariesStatus 从叶子原样转发。
export { getSessionSummariesStatus } from './summaryStore.js';

export async function getSessionSummaries(sessionId) {
  const { summaries } = await getSessionSummariesStatus(sessionId);
  return summaries;
}

async function saveSessionSummariesInternal(sessionId, list) {
  const normalized = (Array.isArray(list) ? list : [])
    .map(normalizeSessionSummary)
    .filter(item => item.summary.trim().length > 0);
  await AsyncStorage.setItem(sessionSummariesKey(sessionId), JSON.stringify(normalized));
  return normalized;
}

async function setSessionSummarizedUpToInternal(sessionId, messageId, options = {}) {
  const sessions = await requireSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target) throw new Error(tActive('error.storage.sessionNotFound'));
  const nextBoundary = String(messageId || '');
  if (!nextBoundary) {
    if (!target.summarizedUpTo) return target;
    const updated = { ...target, summarizedUpTo: '' };
    await saveSessionsInternal(sessions.map(session => (
      session.id === sessionId ? updated : session
    )));
    return updated;
  }
  const messages = await getMessagesBySession(sessionId);
  const newIndex = messages.findIndex(item => item.id === nextBoundary);
  if (newIndex < 0) throw new Error(tActive('error.storage.summaryBoundaryInvalid'));
  const oldIndex = messages.findIndex(item => item.id === target.summarizedUpTo);
  if (
    options.allowBackward !== true
    && target.summarizedUpTo
    && oldIndex >= 0
    && newIndex <= oldIndex
  ) {
    return target;
  }
  const updated = { ...target, summarizedUpTo: nextBoundary };
  await saveSessionsInternal(sessions.map(session => (session.id === sessionId ? updated : session)));
  return updated;
}

export function setSessionSummarizedUpTo(sessionId, messageId, expectedRevision = null) {
  return enqueueSessionMutation(() => {
    if (expectedRevision !== null && !isSessionSummaryRevisionCurrent(sessionId, expectedRevision)) {
      throw new Error(tActive('error.storage.summaryReset'));
    }
    return setSessionSummarizedUpToInternal(sessionId, messageId);
  });
}

export function resetSessionSummaries(sessionId) {
  bumpSessionSummaryRevision(sessionId);
  return enqueueSessionMutation(async () => {
    const sessions = await requireSessions();
    const target = sessions.find(session => session.id === sessionId);
    if (!target) throw new Error(tActive('error.storage.sessionNotFound'));
    const key = sessionSummariesKey(sessionId);
    const cleared = sessions.map(session => (
      session.id === sessionId ? { ...session, summarizedUpTo: '' } : session
    ));
    await saveSessionsInternal(cleared);
    try {
      await AsyncStorage.removeItem(key);
    } catch (error) {
      await saveSessionsInternal(sessions).catch(restoreError => {
        if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[storage] summary boundary restore failed', restoreError);
      });
      throw error;
    }
    return cleared;
  });
}

export function invalidateSessionSummaries(sessionId, keepSummaries = [], nextBoundary = '') {
  bumpSessionSummaryRevision(sessionId);
  return enqueueSessionMutation(async () => {
    const sessions = await requireSessions();
    const target = sessions.find(session => session.id === sessionId);
    if (!target) throw new Error(tActive('error.storage.sessionNotFound'));
    const previousStatus = await getSessionSummariesStatus(sessionId);
    if (previousStatus.status === 'corrupt') {
      throw new Error(tActive('error.storage.summaryReadFailed'));
    }
    const kept = (Array.isArray(keepSummaries) ? keepSummaries : [])
      .map(normalizeSessionSummary)
      .filter(item => item.summary.trim().length > 0);
    await saveSessionSummariesInternal(sessionId, kept);
    try {
      await setSessionSummarizedUpToInternal(sessionId, nextBoundary, { allowBackward: true });
    } catch (error) {
      await saveSessionSummariesInternal(sessionId, previousStatus.summaries).catch(restoreError => {
        if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[storage] summary rollback failed', restoreError);
      });
      throw error;
    }
    return kept;
  });
}

export function appendSessionSummary(sessionId, entry, expectedRevision = null) {
  const task = enqueueSessionMutation(async () => {
    if (expectedRevision !== null && !isSessionSummaryRevisionCurrent(sessionId, expectedRevision)) {
      throw new Error(tActive('error.storage.summaryReset'));
    }
    const { status, summaries } = await getSessionSummariesStatus(sessionId);
    if (status === 'corrupt') throw new Error(tActive('error.storage.summaryReadFailed'));
    const normalizedEntry = normalizeSessionSummary(entry);
    const next = [...summaries, normalizedEntry];
    await saveSessionSummariesInternal(sessionId, next);
    try {
      await setSessionSummarizedUpToInternal(sessionId, normalizedEntry.boundary);
    } catch (error) {
      if (
        expectedRevision === null
        || isSessionSummaryRevisionCurrent(sessionId, expectedRevision)
      ) {
        await saveSessionSummariesInternal(sessionId, summaries).catch(() => {});
      }
      throw error;
    }
    return next;
  });
  return task;
}
