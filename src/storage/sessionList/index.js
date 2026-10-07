// 会话列表领域实现聚合：从各子模块 re-export 公开符号，barrel 只需指向这里。
// 从 src/storage/sessionList.js 原样外提（纯搬运，无行为变化）。

export {
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
} from './mutations.js';
export { findOrphanSessions, restoreSession } from './orphans.js';
export { migrateLegacyMessages } from './migration.js';
export { reconcileVectorIndexes } from './vectorReconcile.js';
export { MESSAGES_KEY_PREFIX } from '../sessionCore.js';
export { reconcileWorldMemories } from '../memoryOwnership.js';
