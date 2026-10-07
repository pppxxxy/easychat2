// 会话消息领域实现聚合：从各子模块 re-export 公开符号，barrel 只需指向这里。
// 从 src/storage/sessionMessages.js 原样外提（纯搬运，无行为变化）。
// 依赖单向：summaryStore（叶子）← messages ← summaries；drafts/search 只向下依赖。

export {
  getMessagesBySessionStatus,
  getMessagesBySession,
  saveMessagesBySession,
  appendProactiveMessage,
} from './messages.js';
export {
  getSessionSummariesStatus,
  getSessionSummaries,
  setSessionSummarizedUpTo,
  resetSessionSummaries,
  invalidateSessionSummaries,
  appendSessionSummary,
} from './summaries.js';
export {
  getSessionDraft,
  saveSessionDraft,
  clearSessionDraft,
} from './drafts.js';
export { searchMessages } from './search.js';
export { CORRUPT_BACKUP_SUFFIX } from '../io.js';
