import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  DEFAULT_CHARACTER,
  saveCharacterState,
  getActiveCharacterId,
  getCharacterLibrary,
  isCharacterLibraryWriteBlocked,
  saveCharacterLibrary,
  setActiveCharacterId,
  sortCharacters,
  getSessions,
  getActiveSessionId,
  whenSessionMutationsSettled,
  setActiveSessionId,
  saveSessions,
  startNewSession,
  appendProactiveMessage,
  getProactiveSettings,
  bindProactiveSlotSession,
  cloneSession as cloneSessionStorage,
  deleteSession as deleteSessionStorage,
  deleteSessions as deleteSessionsStorage,
   collectOrphanImageFiles,
   reconcileVectorIndexes,
 } from '../storage.js';

import {
  describeDefaultArtwork,
  resolveActiveId,
  runWithRollback,
  withAddedCharacter,
  withDeletedCharacter,
  withDeletedCharacters,
  withPinnedCharacter,
  withSwitchedCharacter,
  withUpdatedCharacter,
} from './characterLibrary.js';
import { resolveActiveSessionId, sortSessions } from './sessionLibrary.js';
import { materializeDefaultArtwork } from '../defaultCharacterAssets.js';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [characters, setCharactersState] = useState([DEFAULT_CHARACTER]);
  const [activeId, setActiveIdState] = useState(DEFAULT_CHARACTER.id);
  const [sessions, setSessionsState] = useState([]);
  const [activeSessionId, setActiveSessionIdState] = useState('');
  const [pendingTarget, setPendingTargetState] = useState(null);
  const [loaded, setLoaded] = useState(false);
  // 主动消息落库后自增，通知聊天页重新读取当前会话消息（同会话追加时 activeSessionId 不变）。
  const [messageRefreshTick, setMessageRefreshTick] = useState(0);
  const charactersRef = useRef([DEFAULT_CHARACTER]);
  const activeIdRef = useRef(DEFAULT_CHARACTER.id);
  const sessionsRef = useRef([]);
  const activeSessionIdRef = useRef('');
  const pendingTargetRef = useRef(null);
  const loadedRef = useRef(false);
  const mutationRef = useRef(Promise.resolve());

  const enqueueMutation = useCallback(operation => {
    const pending = mutationRef.current.then(operation);
    mutationRef.current = pending.catch(() => {});
    return pending;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [list, storedActiveId, sessionList, storedActiveSessionId] = await Promise.all([
          getCharacterLibrary(),
          getActiveCharacterId(),
          getSessions(),
          getActiveSessionId(),
        ]);
        if (cancelled) return;
        const libraryBlocked = isCharacterLibraryWriteBlocked();
        // 默认角色（EasyChat2 助手）首次运行时补上内置头像/背景：仅当用户尚未自定义。
        // 落盘为 avatars/ 下的普通文件，使所有既有渲染点无需改动即可生效。
        let resolvedList = list;
        if (!libraryBlocked) {
          const defaultCharacter = list.find(item => item.id === DEFAULT_CHARACTER.id);
          const needs = describeDefaultArtwork({
            id: DEFAULT_CHARACTER.id,
            avatarUri: defaultCharacter && defaultCharacter.avatarUri,
            bgUri: defaultCharacter && defaultCharacter.bgUri,
            defaultId: DEFAULT_CHARACTER.id,
          });
          if (needs.avatar || needs.bg) {
            const artwork = await materializeDefaultArtwork();
            if (cancelled) return;
            if (artwork.avatarUri || artwork.bgUri) {
              resolvedList = list.map(item => {
                if (item.id !== DEFAULT_CHARACTER.id) return item;
                return {
                  ...item,
                  avatarUri: needs.avatar && artwork.avatarUri ? artwork.avatarUri : item.avatarUri,
                  bgUri: needs.bg && artwork.bgUri ? artwork.bgUri : item.bgUri,
                };
              });
              await saveCharacterLibrary(resolvedList).catch(() => {});
            }
          }
        }
        const resolved = resolveActiveId(resolvedList, storedActiveId);
        const sortedSessions = sortSessions(sessionList);
        const resolvedSessionId = resolveActiveSessionId(sortedSessions, storedActiveSessionId);
        charactersRef.current = resolvedList;
        activeIdRef.current = libraryBlocked ? (storedActiveId || resolved) : resolved;
        sessionsRef.current = sortedSessions;
        activeSessionIdRef.current = resolvedSessionId;
        setCharactersState(resolvedList);
        setActiveIdState(libraryBlocked ? (storedActiveId || resolved) : resolved);
        setSessionsState(sortedSessions);
        setActiveSessionIdState(resolvedSessionId);
        if (!libraryBlocked && resolved !== storedActiveId) {
          setActiveCharacterId(resolved).catch(() => {});
        }
        if (resolvedSessionId !== storedActiveSessionId && resolvedSessionId) {
          setActiveSessionId(resolvedSessionId).catch(() => {});
        }
      } catch (error) {
        if (cancelled) return;
        charactersRef.current = [DEFAULT_CHARACTER];
        activeIdRef.current = DEFAULT_CHARACTER.id;
        sessionsRef.current = [];
        activeSessionIdRef.current = '';
        setCharactersState([DEFAULT_CHARACTER]);
        setActiveIdState(DEFAULT_CHARACTER.id);
        setSessionsState([]);
        setActiveSessionIdState('');
      } finally {
        if (!cancelled) {
          loadedRef.current = true;
          setLoaded(true);
          reconcileVectorIndexes().catch(error => {
            if (__DEV__) console.warn('[vector] startup reconciliation failed', error);
          });
          collectOrphanImageFiles().catch(() => {});
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyList = useCallback(list => {
    const sorted = sortCharacters(list);
    charactersRef.current = sorted;
    setCharactersState(sorted);
    return sorted;
  }, []);

  const restore = useCallback(snapshot => {
    charactersRef.current = snapshot.list;
    activeIdRef.current = snapshot.activeId;
    setCharactersState(snapshot.list);
    setActiveIdState(snapshot.activeId);
  }, []);

  const snapshotState = useCallback(() => ({
    list: charactersRef.current,
    activeId: activeIdRef.current,
  }), []);

  const updateCharacter = useCallback(async patch => {
    if (!loadedRef.current) {
      throw new Error('角色尚未加载完成');
    }
    const targetId = patch?.id || activeIdRef.current;
    return enqueueMutation(async () => {
      const snapshot = snapshotState();
      if (!snapshot.list.some(item => item.id === targetId)) {
        throw new Error('角色不存在');
      }
      const { list, character } = withUpdatedCharacter(snapshot.list, targetId, patch);
      applyList(list);
      await runWithRollback(snapshot, restore, () => saveCharacterLibrary(list));
      return character;
    });
  }, [applyList, restore, snapshotState, enqueueMutation]);

  const switchCharacter = useCallback(async id => {
    if (!loadedRef.current) {
      throw new Error('角色尚未加载完成');
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotState();
      const { list, character, found } = withSwitchedCharacter(
        snapshot.list,
        id,
        Date.now()
      );
      if (!found) {
        throw new Error('角色不存在');
      }
      if (id === snapshot.activeId) return character;
      applyList(list);
      activeIdRef.current = id;
      setActiveIdState(id);
      await runWithRollback(snapshot, restore, () => saveCharacterState(list, id));
      return character;
    });
  }, [applyList, restore, snapshotState, enqueueMutation]);

  const addCharacter = useCallback(async character => {
    if (!loadedRef.current) {
      throw new Error('角色尚未加载完成');
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotState();
      const created = withAddedCharacter(snapshot.list, character, Date.now());
      applyList(created.list);
      activeIdRef.current = created.character.id;
      setActiveIdState(created.character.id);
      await runWithRollback(snapshot, restore, () =>
        saveCharacterState(created.list, created.character.id)
      );
      return created.character;
    });
  }, [applyList, restore, snapshotState, enqueueMutation]);

  const deleteCharacter = useCallback(async (id, options = {}) => {
    if (!loadedRef.current) {
      throw new Error('角色尚未加载完成');
    }
    if (id === DEFAULT_CHARACTER.id) {
      throw new Error('默认角色不可删除');
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotState();
      const result = withDeletedCharacter(snapshot.list, id, snapshot.activeId);
      if (!result.removed) {
        throw new Error('角色不存在');
      }
      applyList(result.list);
      activeIdRef.current = result.activeId;
      setActiveIdState(result.activeId);
      await runWithRollback(snapshot, restore, () =>
        saveCharacterState(
          result.list,
          result.activeId,
          id,
          options.clearVectorIds || []
        )
      );
      return result.list;
    });
  }, [applyList, restore, snapshotState, enqueueMutation]);

  const pinCharacter = useCallback(async (id, pinned) => {
    if (!loadedRef.current) {
      throw new Error('角色尚未加载完成');
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotState();
      const result = withPinnedCharacter(snapshot.list, id, pinned);
      if (!result.found) {
        throw new Error('角色不存在');
      }
      applyList(result.list);
      await runWithRollback(snapshot, restore, () =>
        saveCharacterState(result.list, snapshot.activeId)
      );
      return result.character;
    });
  }, [applyList, restore, snapshotState, enqueueMutation]);

  const deleteCharacters = useCallback(async (ids, options = {}) => {
    if (!loadedRef.current) {
      throw new Error('角色尚未加载完成');
    }
    const list = (Array.isArray(ids) ? ids : []).map(String)
      .filter(id => id && id !== DEFAULT_CHARACTER.id);
    if (list.length === 0) {
      throw new Error('没有可删除的角色');
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotState();
      // 默认角色不可删，删掉其余全部角色后仍会保留默认角色，因此这里不再拦截“全选删除”。
      const result = withDeletedCharacters(snapshot.list, list, snapshot.activeId);
      if (result.removedCount === 0) {
        throw new Error('角色不存在');
      }
      applyList(result.list);
      activeIdRef.current = result.activeId;
      setActiveIdState(result.activeId);
      await runWithRollback(snapshot, restore, () =>
        saveCharacterState(
          result.list,
          result.activeId,
          list,
          options.clearVectorIds || []
        )
      );
      return result.list;
    });
  }, [applyList, restore, snapshotState, enqueueMutation]);

  const applySessions = useCallback(list => {
    const sorted = sortSessions(list);
    sessionsRef.current = sorted;
    setSessionsState(sorted);
    return sorted;
  }, []);

  const restoreSessions = useCallback(snapshot => {
    sessionsRef.current = snapshot.sessions;
    activeSessionIdRef.current = snapshot.activeSessionId;
    setSessionsState(snapshot.sessions);
    setActiveSessionIdState(snapshot.activeSessionId);
  }, []);

  const snapshotSessions = useCallback(() => ({
    sessions: sessionsRef.current,
    activeSessionId: activeSessionIdRef.current,
  }), []);

  const applyActiveSessionId = useCallback(id => {
    activeSessionIdRef.current = id;
    setActiveSessionIdState(id);
  }, []);

  const setPendingTarget = useCallback(target => {
    const value = target && target.sessionId && target.messageId
      ? { sessionId: String(target.sessionId), messageId: String(target.messageId) }
      : null;
    pendingTargetRef.current = value;
    setPendingTargetState(value);
  }, []);

  const consumePendingTarget = useCallback(() => {
    const value = pendingTargetRef.current;
    pendingTargetRef.current = null;
    setPendingTargetState(null);
    return value;
  }, []);

  const refreshSessionsDirect = useCallback(async () => {
    // 先等存储层会话写入（含旧消息迁移）排空：迁移在 storage 的队列里，
    // 与这里的 mutation 队列不是同一个；不等待会在迁移写盘中途读到中间态。
    await whenSessionMutationsSettled();
    const [sessionList, storedActiveSessionId] = await Promise.all([
      getSessions(),
      getActiveSessionId(),
    ]);
    const sorted = applySessions(sessionList);
    const resolved = resolveActiveSessionId(sorted, storedActiveSessionId);
    applyActiveSessionId(resolved);
    return sorted;
  }, [applySessions, applyActiveSessionId]);

  // 外部刷新也要进 mutation 队列：否则迁移/写入进行中的刷新可能用旧快照覆盖新 Context。
  const refreshSessions = useCallback(
    () => enqueueMutation(() => refreshSessionsDirect()),
    [enqueueMutation, refreshSessionsDirect]
  );

  const refreshAppData = useCallback(async () => {
    await enqueueMutation(async () => {
      const [list, storedActiveId, sessionList, storedActiveSessionId] = await Promise.all([
        getCharacterLibrary(),
        getActiveCharacterId(),
        getSessions(),
        getActiveSessionId(),
      ]);
      const resolvedList = Array.isArray(list) && list.length > 0 ? list : [DEFAULT_CHARACTER];
      const resolved = resolveActiveId(resolvedList, storedActiveId);
      const sortedSessions = sortSessions(sessionList);
      const resolvedSessionId = resolveActiveSessionId(sortedSessions, storedActiveSessionId);
      charactersRef.current = resolvedList;
      activeIdRef.current = resolved;
      sessionsRef.current = sortedSessions;
      activeSessionIdRef.current = resolvedSessionId;
      setCharactersState(resolvedList);
      setActiveIdState(resolved);
      setSessionsState(sortedSessions);
      setActiveSessionIdState(resolvedSessionId);
      setMessageRefreshTick(tick => tick + 1);
    });
  }, [enqueueMutation]);

  const ensureCharacterSession = useCallback(async (characterId, opening = null) => {
    if (!loadedRef.current) {
      throw new Error('会话尚未加载完成');
    }
    return enqueueMutation(async () => {
      const targetId = String(characterId || '');
      const existing = sessionsRef.current.find(session => session.characterId === targetId);
      if (existing) {
        if (activeSessionIdRef.current !== existing.id) {
          applyActiveSessionId(existing.id);
          await setActiveSessionId(existing.id);
        }
        return existing;
      }
      try {
        const created = await startNewSession(targetId, opening);
        await refreshSessionsDirect();
        return sessionsRef.current.find(session => session.id === created.id) || created;
      } catch (error) {
        await refreshSessionsDirect().catch(() => {});
        throw error;
      }
    });
  }, [applyActiveSessionId, refreshSessionsDirect, enqueueMutation]);

  // 主动消息落库：把原生待写队列里的消息逐条写入各自角色的单聊会话，再刷新列表。
  // 目标会话由槽的 sessionTargetId 决定：命中该角色的历史对话则写入，否则新建一段并把槽绑定过去
  // （下次触发即固定复用；该会话若被删除则视为空，再次新建）。
  // 返回 { written, skipped, deferred, targetSessions }：
  //   written        已写入，可 ack 删除；
  //   skipped        结构残缺、永远无法处理，可 ack 删除；
  //   deferred       暂时处理不了（角色不在库/写入失败），**不 ack**，保留重试；
  //   targetSessions roleId → 本次消息实际写入的 sessionId，供通知跳转精确切到那段会话。
  const ingestProactiveMessages = useCallback(async messages => {
    const list = Array.isArray(messages) ? messages : [];
    if (list.length === 0 || !loadedRef.current) {
      return { written: [], skipped: [], deferred: [], targetSessions: {} };
    }
    const written = [];
    const skipped = [];
    const deferred = [];
    // 每个角色本次消息落到的会话；同一角色多条时取最后一条（最新）。
    const targetSessions = {};
    // 槽绑定表只读一次；新建后同步更新，保证同一轮多条消息指向同一段新建会话。
    const settings = await getProactiveSettings().catch(() => ({ slots: [] }));
    const slotTargets = new Map(
      (Array.isArray(settings.slots) ? settings.slots : [])
        .map(slot => [String(slot.slotId || ''), String(slot.sessionTargetId || '')])
    );
    for (const message of list) {
      const roleId = String(message && message.roleId || '');
      const id = String(message && message.id || '');
      const slotId = String(message && message.slotId || '');
      if (!id) {
        // 没有 id 就无法定位、无法 ack，忽略即可
        continue;
      }
      if (!roleId) {
        // 连角色都没有，永远无法落库：保留重试也无意义，按可删除处理
        skipped.push(id);
        continue;
      }
      if (!charactersRef.current.some(item => item.id === roleId)) {
        // 角色当前不在库（可能被删、也可能是 id 一时对不上）：保留重试，不删消息。
        deferred.push(id);
        continue;
      }
      try {
        const result = await appendProactiveMessage(roleId, {
          id,
          text: message.text,
          createdAt: message.createdAt,
          sessionTargetId: slotTargets.get(slotId) || '',
        });
        written.push(id);
        if (result && result.sessionId) {
          targetSessions[roleId] = result.sessionId;
        }
        // 首次新建对话：把槽绑定到这段新会话，之后固定复用。
        if (result && result.created && slotId && result.sessionId) {
          slotTargets.set(slotId, result.sessionId);
          await bindProactiveSlotSession(slotId, result.sessionId).catch(() => {});
        }
      } catch (error) {
        // 写入失败：保留重试，下次启动消费者会再取一次
        deferred.push(id);
      }
    }
    if (written.length > 0) {
      await refreshSessionsDirect().catch(() => {});
      setMessageRefreshTick(tick => tick + 1);
    }
    return { written, skipped, deferred, targetSessions };
  }, [refreshSessionsDirect]);

  const switchSession = useCallback(async id => {
    if (!loadedRef.current) {
      throw new Error('会话尚未加载完成');
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotSessions();
      const target = snapshot.sessions.find(session => session.id === id);
      if (!target) {
        throw new Error('会话不存在');
      }
      if (id === snapshot.activeSessionId) return target;
      applyActiveSessionId(id);
      await runWithRollback(snapshot, restoreSessions, () => setActiveSessionId(id));
      return target;
    });
  }, [applyActiveSessionId, restoreSessions, snapshotSessions, enqueueMutation]);

  const pinSession = useCallback(async id => {
    if (!loadedRef.current) {
      throw new Error('会话尚未加载完成');
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotSessions();
      if (!snapshot.sessions.some(session => session.id === id)) {
        throw new Error('会话不存在');
      }
      const next = snapshot.sessions.map(session =>
        session.id === id ? { ...session, pinned: !session.pinned } : session
      );
      const sorted = applySessions(next);
      await runWithRollback(snapshot, restoreSessions, () => saveSessions(sorted));
      return sorted;
    });
  }, [applySessions, restoreSessions, snapshotSessions, enqueueMutation]);

  const cloneSession = useCallback(async id => {
    if (!loadedRef.current) {
      throw new Error('会话尚未加载完成');
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotSessions();
      if (!snapshot.sessions.some(session => session.id === id)) {
        throw new Error('会话不存在');
      }
      const copy = await cloneSessionStorage(id);
      applySessions([...sessionsRef.current, copy]);
      return copy;
    });
  }, [applySessions, snapshotSessions, enqueueMutation]);

  const deleteSession = useCallback(async id => {
    if (!loadedRef.current) {
      throw new Error('会话尚未加载完成');
    }
    return enqueueMutation(async () => {
      try {
        const result = await deleteSessionStorage(id);
        applySessions(result.sessions);
        applyActiveSessionId(result.activeSessionId);
        return result;
      } catch (error) {
        await refreshSessionsDirect().catch(() => {});
        throw error;
      }
    });
  }, [applySessions, applyActiveSessionId, refreshSessionsDirect, enqueueMutation]);

  const deleteSessions = useCallback(async (ids, excludedCharacterIds = []) => {
    if (!loadedRef.current) {
      throw new Error('会话尚未加载完成');
    }
    const targets = (Array.isArray(ids) ? ids : [])
      .map(id => String(id || ''))
      .filter(Boolean);
    const excluded = new Set(
      (Array.isArray(excludedCharacterIds) ? excludedCharacterIds : [])
        .map(id => String(id || ''))
        .filter(Boolean)
    );
    if (targets.length === 0) return sessionsRef.current;
    return enqueueMutation(async () => {
      const snapshot = snapshotSessions();
      try {
        const result = await deleteSessionsStorage(targets);
        let sorted = applySessions(result.sessions);
        let resolved = resolveActiveSessionId(sorted, result.activeSessionId);
        if (targets.includes(snapshot.activeSessionId) && sorted.length === 0) {
          const current = snapshot.sessions.find(
            session => session.id === snapshot.activeSessionId
          );
          const available = charactersRef.current.filter(item => !excluded.has(String(item.id || '')));
          const currentOwner = current && current.type !== 'group'
            ? String(current.characterId || '')
            : '';
          const activeOwner = String(activeIdRef.current || '');
          const fallbackCharacterId = (
            (currentOwner && available.some(item => item.id === currentOwner) && currentOwner)
            || (available.some(item => item.id === activeOwner) && activeOwner)
            || (available.find(item => item.id === DEFAULT_CHARACTER.id) || {}).id
            || (available[0] || {}).id
            || ''
          );
          await startNewSession(fallbackCharacterId);
          sorted = await refreshSessionsDirect();
          resolved = resolveActiveSessionId(sorted, activeSessionIdRef.current);
        }
        applyActiveSessionId(resolved);
        return sorted;
      } catch (error) {
        await refreshSessionsDirect().catch(() => {});
        throw error;
      }
    });
  }, [applySessions, applyActiveSessionId, refreshSessionsDirect, enqueueMutation]);

  // activeId 失效（存储损坏 / 角色被外部删除）时界面角色会退回初始卡。若同时继续对外
  // 暴露失效的 activeId，就会造成“高亮的角色”和“当前角色”不是同一个的身份错位，后续
  // 按 activeId 落盘的数据也会指错人。这里统一以解析出的角色为准：character.id 就是
  // 唯一有效的 activeId。
  const character = useMemo(
    () => characters.find(item => item.id === activeId)
      || characters.find(item => item.id === DEFAULT_CHARACTER.id)
      || DEFAULT_CHARACTER,
    [characters, activeId]
  );
  const resolvedActiveId = character.id;

  // activeId 与当前角色不一致时立即修正并落盘，避免失效 id 一直留在存储里。
  useEffect(() => {
    if (!loaded || isCharacterLibraryWriteBlocked()) return;
    if (activeIdRef.current === resolvedActiveId) return;
    activeIdRef.current = resolvedActiveId;
    setActiveIdState(resolvedActiveId);
    setActiveCharacterId(resolvedActiveId).catch(() => {});
  }, [loaded, resolvedActiveId]);

  const value = useMemo(
    () => ({
      character,
      characters,
      activeId: resolvedActiveId,
      loaded,
      updateCharacter,
      switchCharacter,
      addCharacter,
      deleteCharacter,
      pinCharacter,
      deleteCharacters,
      sessions,
      activeSessionId,
      switchSession,
      pinSession,
      cloneSession,
      deleteSession,
      deleteSessions,
      refreshSessions,
      refreshAppData,
      ensureCharacterSession,
      ingestProactiveMessages,
      messageRefreshTick,
      pendingTarget,
      setPendingTarget,
      consumePendingTarget,
    }),
    [
      character,
      characters,
      resolvedActiveId,
      loaded,
      updateCharacter,
      switchCharacter,
      addCharacter,
      deleteCharacter,
      pinCharacter,
      deleteCharacters,
      sessions,
      activeSessionId,
      switchSession,
      pinSession,
      cloneSession,
      deleteSession,
      deleteSessions,
      refreshSessions,
      refreshAppData,
      ensureCharacterSession,
      ingestProactiveMessages,
      messageRefreshTick,
      pendingTarget,
      setPendingTarget,
      consumePendingTarget,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp 必须在 AppProvider 内使用');
  }
  return ctx;
}
