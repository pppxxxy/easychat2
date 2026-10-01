import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { removeRolesFromDiarySettings } from './diary/diary.js';
import {
  getMediaWriteRevision,
  isMediaWriteRevisionCurrent,
  isRecentMediaUri,
  markMediaWrite,
} from './mediaProtection.js';
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

export { markMediaWrite } from './mediaProtection.js';
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
  acknowledgeDisclaimer,
  completeOnboarding,
  getAppearanceSettings,
  getChatOptions,
  getEnabledPlugins,
  getImageGenSettings,
  getInlineImageSettings,
  getMemorySummarySettings,
  getPlugins,
  getSamplingSettings,
  getThinkingSettings,
  getTranscriptionSettings,
  getTtsSettings,
  isDisclaimerAcknowledged,
  isOnboardingDone,
  saveAppearanceSettings,
  saveChatOptions,
  saveImageGenSettings,
  saveInlineImageSettings,
  saveMemorySummarySettings,
  savePlugins,
  saveSamplingSettings,
  saveThinkingSettings,
  saveTranscriptionSettings,
  saveTtsSettings,
} from './storage/settings.js';
export {
  createApiConfig,
  getActiveApiConfig,
  getActiveModel,
  getApiConfigs,
  saveApiConfigs,
} from './storage/apiConfigs.js';
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
  // 角色删除后联动清掉它的日记条目与日记开关，避免设置里残留孤儿角色。
  const removedCharacters = removed.filter(id => id && id !== DEFAULT_CHARACTER.id);
  if (removedCharacters.length > 0) {
    try {
      await deleteDiariesForCharacterDeletion(removedCharacters);
    } catch (error) {
      if (__DEV__) console.warn('[diary] character cleanup failed', error);
    }
    try {
      const settings = await getDiarySettings();
      await saveDiarySettings(removeRolesFromDiarySettings(settings, removedCharacters));
    } catch (error) {
      if (__DEV__) console.warn('[diary] settings cleanup failed', error);
    }
    // 角色删除后从地图里摘掉它：不再作为屋主，也不再是任何房子的住户。
    try {
      await detachCharacterFromWorldMap(removedCharacters);
    } catch (error) {
      if (__DEV__) console.warn('[map] character cleanup failed', error);
    }
  }
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

