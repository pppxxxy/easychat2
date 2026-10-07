// 会话列表领域 barrel。从 src/storage/sessions.js 原样外提（无行为变化）。
// 实现已拆到 src/storage/sessionList/ 子目录：mutations（会话增删改与队列包装）、
// orphans（孤儿扫描/恢复）、migration（旧版按角色消息迁移）、vectorReconcile（向量索引对账）、
// index（聚合导出）。
// 注：saveCharacterState（跨领域编排）仍留在 storage.js barrel。

export {
  reconcileVectorIndexes,
  startNewSession,
  setSessionGreetingSelected,
  createGroupSession,
  updateSessionInfo,
  setSessionPinned,
  markSessionModel,
  updateSessionMemberProfiles,
  cloneSession,
  deleteSession,
  deleteSessions,
  restoreSession,
  migrateLegacyMessages,
  findOrphanSessions,
  MESSAGES_KEY_PREFIX,
  reconcileWorldMemories,
} from './sessionList/index.js';
