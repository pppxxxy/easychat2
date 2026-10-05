import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import {
  getMediaWriteRevision,
  isMediaWriteRevisionCurrent,
  isRecentMediaUri,
  isRecentlyModifiedFile,
  markMediaWrite,
} from './storage/mediaProtection.js';
import { CORRUPT_BACKUP_SUFFIX } from './storage/io.js';
import {
  detachCharacterFromWorldMap,
  getWorldMap,
  getWorldMapStatus,
  updateWorldMap,
} from './storage/worldMap.js';
import {
  deleteDiariesForCharacterDeletion,
  getDiaries,
  getDiariesStatus,
  getDiarySettings,
  saveDiaries,
  saveDiarySettings,
  updateDiaries,
} from './storage/diary.js';
import { MOMENTS_KEY, getMomentsStatus } from './storage/moments.js';
import { isStickerReferenceBackupKey, readStickerStatus } from './storage/stickers.js';
import { USER_PROFILE_KEY, getUserProfileStatus } from './storage/personas.js';
import {
  clearVectorIndex,
} from './storage/vector.js';
import {
  CHARACTER_ITEM_PREFIX,
  DEFAULT_CHARACTER,
  getActiveCharacterId,
  getCharacterLibrary,
  isCharacterLibraryWriteBlocked,
  saveCharacterLibrary,
  setActiveCharacterId,
} from './storage/characters.js';
import { SESSIONS_KEY, collectChatImageFiles, messagesKey, readSessionsStatus } from './storage/sessions.js';
import { runCharacterCleanup } from './storage/characterLifecycle.js';

export { markMediaWrite } from './storage/mediaProtection.js';
export {
  getLocationSettings,
  normalizeLocationSettings,
  saveLocationSettings,
  setLastLocation,
  updateLocationSettings,
} from './storage/location.js';
export { detachCharacterFromWorldMap, getWorldMap, getWorldMapStatus, updateWorldMap };
export {
  deleteDiariesForCharacterDeletion,
  getDiaries,
  getDiariesStatus,
  getDiarySettings,
  saveDiaries,
  saveDiarySettings,
  updateDiaries,
};
export {
  deleteMomentsBySessionIds,
  deleteMomentsForCharacterDeletion,
  getMoments,
  getMomentsSettings,
  getMomentsStatus,
  getProactiveSettings,
  makeProactiveSlotId,
  PROACTIVE_MODES,
  saveMoments,
  saveMomentsSettings,
  saveProactiveSettings,
  bindProactiveSlotSession,
  updateMoments,
} from './storage/moments.js';
export { deleteStickers, getStickers, reorderStickers, saveSticker } from './storage/stickers.js';
export {
  DISCLAIMER_VERSION,
  SAMPLING_FIELDS,
  THINKING_DISPLAYS,
  THINKING_LEVELS,
  MUSIC_CLIP_SECONDS,
  MUSIC_CLIP_SAMPLE_RATES,
  DEFAULT_MUSIC_CLIP,
  acknowledgeDisclaimer,
  completeOnboarding,
  getAppearanceSettings,
  getChatOptions,
  getEnabledPlugins,
  getImageGenSettings,
  getInlineImageSettings,
  getMemorySummarySettings,
  getMusicClipSettings,
  getPlugins,
  getSamplingSettings,
  getThinkingSettings,
  getTranscriptionSettings,
  getTtsSettings,
  isDisclaimerAcknowledged,
  isOnboardingDone,
  patchAppearanceSettings,
  saveAppearanceSettings,
  saveChatOptions,
  saveImageGenSettings,
  saveInlineImageSettings,
  saveMemorySummarySettings,
  saveMusicClipSettings,
  savePlugins,
  saveSamplingSettings,
  saveThinkingSettings,
  saveTranscriptionSettings,
  saveTtsSettings,
} from './storage/settings.js';
export {
  WORKSPACE_KEY,
  WORKSPACE_CHANGES_KEY,
  WORKSPACE_CHANGE_LIMIT,
  appendWorkspaceChange,
  clearWorkspaceChanges,
  getWorkspaceChanges,
  getWorkspaceSettings,
  normalizeWorkspaceChange,
  patchWorkspaceSettings,
  saveWorkspaceSettings,
} from './storage/workspace.js';
export {
  clearGithubMcpCredentials,
  connectGithubMcpWithToken,
  createGithubMcpSessionFromSettings,
  GITHUB_MCP_KEY,
  getGithubMcpSettings,
  normalizeGithubMcpSettings,
  patchGithubMcpSettings,
  refreshGithubMcpToolCatalog,
} from './storage/githubMcp.js';
export {
  capabilitiesForModel,
  createApiConfig,
  getActiveApiConfig,
  getActiveModel,
  getApiConfigs,
  normalizeCapabilityEntry,
  saveApiConfigs,
} from './storage/apiConfigs.js';
export {
  deleteLocalModelItem,
  getActiveLocalModel,
  getLocalModelIndex,
  getLocalModelItem,
  getLocalModelSettings,
  localModelItemKey,
  rebuildLocalModelIndex,
  saveLocalModelItem,
  saveLocalModelSettings,
} from './storage/localModels.js';
export {
  USER_PROFILE_KEY,
  createPersona,
  deletePersona,
  getActivePersonaId,
  getPersonas,
  getUserProfile,
  getUserProfileStatus,
  saveUserProfile,
  setActivePersonaId,
} from './storage/personas.js';
export {
  createGlobalPresetId,
  getEnabledGlobalPresetPrompts,
  getGlobalPresetSettings,
  getGlobalPresets,
  saveGlobalPresetSettings,
  saveGlobalPresets,
} from './storage/globalPresets.js';
export {
  createVectorConfig,
  getVectorIndex,
  clearVectorIndex,
  getVectorIndexStatus,
  getVectorMemoryConfig,
  getVectorMemorySettings,
  removeVectorIndexForMessage,
  removeVectorIndexForMessages,
  removeVectorIndexForSession,
  removeVectorIndexForSessions,
  saveVectorIndex,
  saveVectorMemoryConfig,
  saveVectorMemorySettings,
  updateVectorIndex,
} from './storage/vector.js';
export { getAffinityStatus, saveAffinity } from './storage/affinity.js';
export { exportBackup, importBackup } from './storage/backup.js';
export {
  DEFAULT_CHARACTER,
  clearCharacterEditDraft,
  getActiveCharacterId,
  getCharacterLibrary,
  hasShownDefaultGreeting,
  isCharacterLibraryWriteBlocked,
  markDefaultGreetingShown,
  saveCharacterEditDraft,
  saveCharacterLibrary,
  setActiveCharacterId,
  sortCharacters,
  takeCharacterEditDraft,
} from './storage/characters.js';
export {
  clearCardForge,
  getCardForge,
  getCardForgeStatus,
  saveCardForge,
} from './storage/cardForge.js';
export {
  appendSessionSummary,
  clearSessionDraft,
  cloneSession,
  collectChatImageFiles,
  collectVoiceFiles,
  createGroupSession,
  deleteSession,
  deleteSessions,
  findOrphanSessions,
  getActiveSessionId,
  getMessagesBySession,
  getMessagesBySessionStatus,
  getSessionDraft,
  getSessionSummaries,
  getSessionSummariesStatus,
  getSessionSummaryRevision,
  getSessions,
  invalidateSessionSummaries,
  isSessionSummaryRevisionCurrent,
  migrateLegacyMessages,
  reconcileVectorIndexes,
  resetSessionSummaries,
  restoreSession,
  saveMessagesBySession,
  appendProactiveMessage,
  saveSessionDraft,
  saveSessions,
  searchMessages,
  setActiveSessionId,
  setProtectedChatImageUris,
  setProtectedVoiceUris,
  setSessionGreetingSelected,
  setSessionPinned,
  setSessionSummarizedUpTo,
  startNewSession,
  updateSessionInfo,
  updateSessionMemberProfiles,
  whenSessionMutationsSettled,
} from './storage/sessions.js';

export async function saveCharacterState(list, activeId, deletedIds, clearVectorIds = []) {
  const previousList = await getCharacterLibrary().catch(() => null);
  const previousActiveId = await getActiveCharacterId().catch(() => '');
  for (const item of Array.isArray(list) ? list : []) {
    markMediaWrite(item && item.avatarUri);
    markMediaWrite(item && item.bgUri);
  }
  await saveCharacterLibrary(list);
  try {
    await setActiveCharacterId(activeId);
  } catch (error) {
    if (previousList) await saveCharacterLibrary(previousList).catch(() => {});
    if (previousActiveId) await setActiveCharacterId(previousActiveId).catch(() => {});
    throw error;
  }
  const vectorIds = Array.isArray(clearVectorIds)
    ? clearVectorIds
    : (clearVectorIds ? [clearVectorIds] : []);
  for (const id of vectorIds) {
    if (id && id !== DEFAULT_CHARACTER.id) {
      try {
        await clearVectorIndex(id);
      } catch (error) {
        if (__DEV__) console.warn('[vector] character cleanup failed', error);
      }
    }
  }
  const removed = Array.isArray(deletedIds) ? deletedIds : (deletedIds ? [deletedIds] : []);
  for (const id of removed) {
    if (id && id !== DEFAULT_CHARACTER.id) {
      try {
        await AsyncStorage.removeItem(messagesKey(id));
      } catch (error) {}
    }
  }
  // 角色删除后的跨域清理交给注册机制：各域在自己模块里注册（见 storage/characterLifecycle.js），
  // 这里只负责跑钩子。此前是硬编码清单，新增域必须记得回来改本函数——@easychat2_affinity
  // （好感度）就是这么漏掉的；moments 的清理更是写在 CharacterScreen 里、门面不知道。
  // 钩子内部各自容错，单个域失败不阻断其余域（runCharacterCleanup 逐个 try/catch）。
  const removedCharacters = removed.filter(id => id && id !== DEFAULT_CHARACTER.id);
  await runCharacterCleanup(removedCharacters);
}

// 向量记忆配置与索引 CRUD 见 src/storage/vector.js。

function isAvatarReferenceBackupKey(key) {
  const value = String(key);
  if (value === `${USER_PROFILE_KEY}${CORRUPT_BACKUP_SUFFIX}`) return true;
  if (value === `${SESSIONS_KEY}${CORRUPT_BACKUP_SUFFIX}`) return true;
  if (value === `${MOMENTS_KEY}${CORRUPT_BACKUP_SUFFIX}`) return true;
  return value.startsWith(`${CHARACTER_ITEM_PREFIX}::`) && value.endsWith(CORRUPT_BACKUP_SUFFIX);
}

async function hasReferenceBackupKey(check) {
  try {
    const keys = await AsyncStorage.getAllKeys();
    return (Array.isArray(keys) ? keys : []).some(key => check(key));
  } catch (error) {
    return true;
  }
}

export async function collectStickerImageFiles() {
  const revision = getMediaWriteRevision();
  if (await hasReferenceBackupKey(isStickerReferenceBackupKey)) return false;
  const status = await readStickerStatus();
  if (status.status !== 'ok' || !isMediaWriteRevisionCurrent(revision)) return false;
  const referenced = new Set(status.stickers.map(item => String(item.uri || '')).filter(Boolean));
  const directory = `${FileSystem.documentDirectory || ''}stickers/`;
  let entries = [];
  try {
    entries = await FileSystem.readDirectoryAsync(directory);
  } catch (error) {
    return true;
  }
  for (const entry of entries) {
    if (!isMediaWriteRevisionCurrent(revision)) return false;
    const uri = `${directory}${entry}`;
    if (isRecentMediaUri(uri)) continue;
    if (referenced.has(uri)) continue;
    // mtime 双保险：recentUris 是内存态，冷启动后失效——宽限窗内写入的文件一律跳过
    //（删除可推迟，误删不可逆）。
    if (await isRecentlyModifiedFile(uri)) continue;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (error) {}
  }
  return true;
}

export async function collectAvatarImageFiles() {
  const revision = getMediaWriteRevision();
  if (await hasReferenceBackupKey(isAvatarReferenceBackupKey)) return false;
  const characters = await getCharacterLibrary().catch(() => null);
  if (!characters || isCharacterLibraryWriteBlocked()) return false;
  const [sessionsStatus, profileStatus, momentsStatus] = await Promise.all([
    readSessionsStatus(),
    getUserProfileStatus().catch(() => ({ status: 'corrupt', profile: null })),
    getMomentsStatus().catch(() => ({ status: 'corrupt', moments: [] })),
  ]);
  if (
    !profileStatus
    || profileStatus.status === 'corrupt'
    || !profileStatus.profile
    || sessionsStatus.status === 'corrupt'
    || momentsStatus.status === 'corrupt'
    || !isMediaWriteRevisionCurrent(revision)
  ) return false;
  const referenced = new Set([
    profileStatus.profile.avatarUri,
    ...characters.flatMap(item => [item.avatarUri, item.bgUri]),
    ...sessionsStatus.sessions.flatMap(item => [item.avatarUri, item.bgUri]),
    ...momentsStatus.moments.map(item => item.avatarUri),
  ].map(value => String(value || '')).filter(Boolean));
  const directory = `${FileSystem.documentDirectory || ''}avatars/`;
  let entries = [];
  try {
    entries = await FileSystem.readDirectoryAsync(directory);
  } catch (error) {
    return true;
  }
  for (const entry of entries) {
    if (!isMediaWriteRevisionCurrent(revision)) return false;
    const uri = `${directory}${entry}`;
    if (isRecentMediaUri(uri)) continue;
    if (referenced.has(uri)) continue;
    // mtime 双保险：recentUris 是内存态，冷启动后失效——宽限窗内写入的文件一律跳过
    //（删除可推迟，误删不可逆）。
    if (await isRecentlyModifiedFile(uri)) continue;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch (error) {}
  }
  return true;
}

export async function collectOrphanImageFiles() {
  const [chatResult, stickerResult, avatarResult] = await Promise.all([
    collectChatImageFiles(),
    collectStickerImageFiles(),
    collectAvatarImageFiles(),
  ]);
  return chatResult !== false && stickerResult !== false && avatarResult !== false;
}

// ---- 动态（朋友圈）与互动 ----
// 实现见 src/storage/moments.js（barrel 这里 re-export 以保持对外 API 不变）。

// ---- 角色日记 ----
// 日记实现见 src/storage/diary.js（barrel 这里 re-export 以保持对外 API 不变）。

// ---- 世界地图 ----
// 地图实现见 src/storage/worldMap.js（barrel 这里 re-export 以保持对外 API 不变）。

// 动态删除联动实现见 src/storage/moments.js。

// 好感度存储见 src/storage/affinity.js。
