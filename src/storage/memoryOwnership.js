// 世界书记忆的归属对账（**存量数据治理**，与「代码路径修复」互补）。
//
// 为什么需要：读/写路径已经在 61f7687 统一成「跟随会话所属角色」，但**修复之前**写错
// 位置的数据还留在盘上——单会话时代写进角色卡的「记忆总结」条目、删会话后残留在卡上的
// 条目、跨卡流通过来的条目。它们只要还 enabled，一旦该角色的会话结构回到「单会话」
// 就会被 worldSummaryEntries 读出来注入，用户感知就是「记忆又串了 / 串历史对话了」。
//
// 这里做的是销旧账：按**当前**会话结构判定每条卡上记忆的合法性，不合法的就地退休
// （enabled:false + stale:true，内容保留、不再注入）。判定本身在 memory/memoryRetire.js
// （纯函数），本模块只负责读盘/写盘与编排。
//
// 两个调用时机：
//   ① 启动时（AppContext 读角色库**之前**，见 context/AppContext.js）：全局对账，
//      同时兜住「恢复旧备份把污染数据整表写回」的情形；
//   ② 会话增删后（storage/sessionList.js）：只对受影响角色对账，代价最小。

import { getCharacterLibrary, saveCharacterLibrary } from './characters.js';
import { appendSessionSummary, getMessagesBySession } from './sessionMessages.js';
import { getSessionSummaryRevision, readSessionsStatus } from './sessionCore.js';
import {
  activeWorldMemoryEntries,
  applyWorldMemoryRetire,
  isBuiltinCharacter,
  planWorldMemoryRetire,
} from '../memory/memoryRetire.js';

// 该角色的单聊会话（群聊不计；群聊没有「角色记忆」这回事）。
export function singleChatSessionsOf(sessions, characterId) {
  const id = String(characterId || '');
  if (!id) return [];
  return (Array.isArray(sessions) ? sessions : []).filter(session => (
    session && String(session.type || 'single') !== 'group' && String(session.characterId || '') === id
  ));
}

// 计算某角色需要退休的记忆条目。
async function planRetireForCharacter(character, sessions) {
  const active = activeWorldMemoryEntries(character && character.worldInfo);
  if (active.length === 0) return [];
  const builtin = isBuiltinCharacter(character);
  const owned = singleChatSessionsOf(sessions, String(character.id || ''));
  let messageIds = null;
  // 只有「唯一会话」这一个场景需要读消息来判归属；读不出来就本次不动（null 语义）。
  if (!builtin && owned.length === 1) {
    try {
      const messages = await getMessagesBySession(String(owned[0].id || ''));
      messageIds = new Set((Array.isArray(messages) ? messages : [])
        .map(item => String((item && item.id) || ''))
        .filter(Boolean));
    } catch (error) {
      messageIds = null;
    }
  }
  return planWorldMemoryRetire(character.worldInfo, {
    sessionCount: owned.length,
    messageIds,
    builtin,
  });
}

async function retireInLibrary(library, sessions, { onlyCharacterId = '', persist = true } = {}) {
  const targetId = String(onlyCharacterId || '');
  const list = Array.isArray(library) ? library : [];
  const next = [];
  const changed = [];
  for (const character of list) {
    if (targetId && String((character && character.id) || '') !== targetId) {
      next.push(character);
      continue;
    }
    const retireIds = await planRetireForCharacter(character, sessions);
    if (retireIds.length === 0) {
      next.push(character);
      continue;
    }
    changed.push({ id: String((character && character.id) || ''), count: retireIds.length });
    next.push({ ...character, worldInfo: applyWorldMemoryRetire(character.worldInfo, retireIds) });
  }
  if (changed.length > 0 && persist) {
    await saveCharacterLibrary(next);
  }
  return {
    retired: changed.reduce((sum, item) => sum + item.count, 0),
    characters: changed.map(item => item.id),
    next,
  };
}

// 启动对账：一次扫全部角色（只在卡上真有「生效的记忆条目」时才有额外读取）。
// characterId 传值则只对账该角色（会话增删后的轻量路径）。
export async function reconcileWorldMemories({ characterId = '' } = {}) {
  const [library, sessionsStatus] = await Promise.all([getCharacterLibrary(), readSessionsStatus()]);
  if (sessionsStatus.status === 'corrupt') {
    // 本模块是纯逻辑层（零 i18n 依赖）：错误带稳定 code，调用方仅记录日志、不影响启动。
    const error = new Error('session list is corrupt');
    error.code = 'SESSIONS_CORRUPT';
    throw error;
  }
  const result = await retireInLibrary(library, sessionsStatus.sessions, {
    onlyCharacterId: characterId,
  });
  return { retired: result.retired, characters: result.characters };
}

// 单会话 → 多会话的迁移：新会话一旦建成，卡上记忆就再也不会被读（≥2 个会话按会话级隔离）。
// 在创建新会话**之前**把卡上记忆搬进那个唯一会话的会话级摘要，记忆不丢、日后删回单会话
// 也不会又冒出来。任何一步失败都不抛（新建会话不该因此失败），卡上条目原样留给对账处理。
export async function migrateWorldMemoriesToSession(characterId, { now = Date.now } = {}) {
  const id = String(characterId || '');
  if (!id) return { migrated: 0 };
  let library = [];
  let sessions = [];
  try {
    const [list, sessionsStatus] = await Promise.all([getCharacterLibrary(), readSessionsStatus()]);
    if (sessionsStatus.status === 'corrupt') return { migrated: 0 };
    library = Array.isArray(list) ? list : [];
    sessions = sessionsStatus.sessions;
  } catch (error) {
    return { migrated: 0 };
  }
  const character = library.find(item => String((item && item.id) || '') === id);
  if (!character || isBuiltinCharacter(character)) return { migrated: 0 };
  const owned = singleChatSessionsOf(sessions, id);
  if (owned.length !== 1) return { migrated: 0 };
  const active = activeWorldMemoryEntries(character.worldInfo);
  if (active.length === 0) return { migrated: 0 };

  const sessionId = String(owned[0].id || '');
  let messages = [];
  try {
    messages = await getMessagesBySession(sessionId);
  } catch (error) {
    return { migrated: 0 };
  }
  const order = new Map();
  (Array.isArray(messages) ? messages : []).forEach((item, index) => {
    order.set(String((item && item.id) || ''), index);
  });
  // 只搬 boundary 能在这个会话里找到、且**晚于**当前总结边界的条目（边界只许前进）；
  // 找不到归属的条目留给对账退休，不硬塞。
  const currentBoundary = String((owned[0] && owned[0].summarizedUpTo) || '');
  const currentIndex = currentBoundary && order.has(currentBoundary) ? order.get(currentBoundary) : -1;
  const migratable = active
    .filter(entry => order.has(String(entry.boundary || '')))
    .filter(entry => currentIndex < 0 || order.get(String(entry.boundary)) > currentIndex)
    .sort((left, right) => order.get(String(left.boundary)) - order.get(String(right.boundary)));
  if (migratable.length === 0) return { migrated: 0 };

  const revision = getSessionSummaryRevision(sessionId);
  try {
    for (const entry of migratable) {
      await appendSessionSummary(sessionId, {
        summary: String(entry.content || '').trim(),
        keywords: Array.isArray(entry.keys) ? entry.keys : [],
        boundary: String(entry.boundary || ''),
        createdAt: now(),
      }, revision);
    }
  } catch (error) {
    // 摘要已落地的部分照旧可用（重复记忆好过丢记忆），卡上条目保留、下次再试。
    return { migrated: 0, failed: true };
  }
  const movedIds = new Set(migratable.map(entry => String((entry && entry.id) || '')));
  try {
    await saveCharacterLibrary(library.map(item => (
      String((item && item.id) || '') !== id
        ? item
        : {
          ...item,
          worldInfo: (Array.isArray(item.worldInfo) ? item.worldInfo : [])
            .filter(entry => !movedIds.has(String((entry && entry.id) || ''))),
        }
    )));
  } catch (error) {
    return { migrated: migratable.length, cardCleanupFailed: true };
  }
  return { migrated: migratable.length };
}
