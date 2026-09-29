// 会话 / 消息 / 记忆摘要 / 聊天图片清理存储领域 —— 对外 barrel（既有导入方零改动）。
//
// 已按分层拆到同目录子模块，消除 ESM 循环（依赖方向单向）：
//   sessionCore.js     变更队列 / 键 / 共享状态 / 会话列表读写原语 / 摘要版本
//   sessionFiles.js    聊天图片文件回收（叶子）
//   sessionMessages.js 消息 + 记忆摘要 + 输入草稿 + 全库搜索
//   sessionList.js     会话增删改 / 群聊 / 迁移 / 孤儿恢复 / 向量对账
// 注：saveCharacterState（跨领域编排）与头像/表情/孤儿图片清理仍留在 storage.js barrel。

export {
  SESSIONS_KEY,
  messagesKey,
  whenSessionMutationsSettled,
  readSessionsStatus,
  getSessions,
  saveSessions,
  getActiveSessionId,
  setActiveSessionId,
  setProtectedChatImageUris,
  getSessionSummaryRevision,
  isSessionSummaryRevisionCurrent,
} from './sessionCore.js';

export {
  collectChatImageFiles,
} from './sessionFiles.js';

export {
  getMessagesBySession,
  getMessagesBySessionStatus,
  saveMessagesBySession,
  appendProactiveMessage,
  getSessionSummaries,
  getSessionSummariesStatus,
  setSessionSummarizedUpTo,
  resetSessionSummaries,
  invalidateSessionSummaries,
  appendSessionSummary,
  getSessionDraft,
  saveSessionDraft,
  clearSessionDraft,
  searchMessages,
} from './sessionMessages.js';

export {
  reconcileVectorIndexes,
  startNewSession,
  setSessionGreetingSelected,
  createGroupSession,
  updateSessionInfo,
  updateSessionMemberProfiles,
  cloneSession,
  deleteSession,
  deleteSessions,
  restoreSession,
  migrateLegacyMessages,
  findOrphanSessions,
} from './sessionList.js';
