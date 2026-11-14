// 角色删除编排（桌面）：删角色时必须一并处理它的会话、动态与向量记忆。
//
// 为什么必须抽出来并走共享编排：桌面的删除此前只调 deleteCharacter(id)——角色表里
// 那一行没了，但它的会话、动态、向量记忆全部留在盘上，成为孤儿数据（记忆页能扫出
// 「消息还在、会话没了」的那种）。手机通过 character/characterLibraryDelete.js 的
// runCharacterDelete 顺序执行三步，桌面照搬同一编排。
//
// 顺序与失败语义（与手机一致）：
//   1. 先删角色本身（失败 ⇒ 后续一个字节都不动，fail-closed）；
//   2. 用户选了「连记忆一起删」才继续：删动态 → 删会话；
//   3. 后两步失败要如实告知（不能只说「删除失败」让用户以为角色还在）。
import { useCallback } from 'react';

import {
  normalizeDeleteTargetIds,
  runCharacterDelete,
  shouldDeleteEverything,
} from '../../../src/character/characterLibraryDelete.js';
import { countMomentsForCharacterDeletion } from '../../../src/moments/moments.js';
import { selectSessionsForCharacters } from '../../../src/context/sessionLibrary.js';
import {
  deleteMomentsForCharacterDeletion,
  getMomentsStatus,
} from '../../../src/storage/moments.js';
import { getSessions } from '../../../src/storage/sessions.js';
import { deleteSessions } from '../../../src/storage/sessionList.js';

export default function useDesktopCharacterDelete({ deleteCharacter, deleteCharacters, refreshSessions }) {
  // 删除前的关联数据统计：让用户在确认框里看见「会连带删掉 N 段对话 / N 条动态」。
  const collectDeleteImpact = useCallback(async ids => {
    const targetIds = normalizeDeleteTargetIds(ids);
    let sessions = [];
    try {
      sessions = await getSessions();
    } catch (error) {
      sessions = [];
    }
    const sessionIds = selectSessionsForCharacters(Array.isArray(sessions) ? sessions : [], targetIds)
      .map(session => session.id)
      .filter(Boolean);
    let linkedMoments = 0;
    try {
      const { status, moments } = await getMomentsStatus();
      // 动态读不出来就抛：宁可不删，也不在「不知道有多少关联数据」时动手。
      if (status === 'corrupt') throw new Error('moments-corrupt');
      linkedMoments = countMomentsForCharacterDeletion(moments, targetIds, sessionIds);
    } catch (error) {
      if (error && error.message === 'moments-corrupt') throw error;
      linkedMoments = 0;
    }
    return { targetIds, sessionIds, linkedMoments };
  }, []);

  // 执行删除。deleteMemories=false 表示只删角色（保留会话/动态/记忆）。
  const runDelete = useCallback(async (ids, { deleteMemories = false } = {}) => {
    const targetIds = normalizeDeleteTargetIds(ids);
    if (targetIds.length === 0) return null;
    const { sessionIds } = await collectDeleteImpact(targetIds);
    const clearVectorIds = deleteMemories ? targetIds : [];
    const result = await runCharacterDelete({
      deleteMemories,
      memoryIds: sessionIds,
      deleteCharactersStep: () => (targetIds.length === 1
        ? deleteCharacter(targetIds[0], { clearVectorIds })
        : deleteCharacters(targetIds, { clearVectorIds })),
      removeMomentsStep: () => deleteMomentsForCharacterDeletion(targetIds, sessionIds),
      deleteSessionsStep: () => deleteSessions(sessionIds, targetIds),
    });
    if (typeof refreshSessions === 'function') refreshSessions().catch(() => {});
    return result;
  }, [collectDeleteImpact, deleteCharacter, deleteCharacters, refreshSessions]);

  return { collectDeleteImpact, runDelete, shouldDeleteEverything };
}