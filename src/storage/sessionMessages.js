// 会话消息与记忆摘要存储领域 barrel。从 src/storage/sessions.js 拆出的原文件，现改为 barrel。
// 实现已拆到 src/storage/sessionMessages/ 子目录：messages（消息载体与主动消息落库）、
// summaries（摘要读写/边界/失效/重置/追加）、drafts（输入草稿）、search（全库搜索）、
// summaryStore（摘要读取共享原语，叶子）、index（聚合导出）。
// 依赖单向：summaryStore ← messages ← summaries；drafts/search 只向下依赖，无循环。

export {
  getMessagesBySessionStatus,
  getMessagesBySession,
  saveMessagesBySession,
  appendProactiveMessage,
  getSessionSummariesStatus,
  getSessionSummaries,
  setSessionSummarizedUpTo,
  resetSessionSummaries,
  invalidateSessionSummaries,
  appendSessionSummary,
  getSessionDraft,
  saveSessionDraft,
  clearSessionDraft,
  searchMessages,
  CORRUPT_BACKUP_SUFFIX,
} from './sessionMessages/index.js';
