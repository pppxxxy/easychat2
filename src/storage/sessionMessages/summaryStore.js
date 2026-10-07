// 会话记忆摘要共享读写原语（叶子）：消息恢复会话行与摘要域都要读摘要。
// 从 src/storage/sessionMessages.js 原样外提（纯搬运，无行为变化）。
// 放在叶子层以保持依赖单向：summaryStore ← messages ← summaries。

import {
  backupCorruptValue,
  readJsonStatus,
} from '../io.js';
import { sessionSummariesKey } from '../sessionCore.js';

export function normalizeSessionSummary(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    summary: String(source.summary || ''),
    keywords: (Array.isArray(source.keywords) ? source.keywords : [])
      .map(item => String(item || '').trim())
      .filter(Boolean),
    boundary: String(source.boundary || ''),
    createdAt: Number(source.createdAt) || 0,
  };
}

export async function getSessionSummariesStatus(sessionId) {
  const key = sessionSummariesKey(sessionId);
  const stored = await readJsonStatus(key);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(key);
    return { status: 'corrupt', summaries: [] };
  }
  if (stored.status === 'missing') return { status: 'missing', summaries: [] };
  const summaries = stored.value
    .map(normalizeSessionSummary)
    .filter(item => item.summary.trim().length > 0);
  return { status: 'ok', summaries };
}
