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
  saveCharacterLibrary,
  setActiveCharacterId,
  sortCharacters,
  getSessions,
  getActiveSessionId,
  setActiveSessionId,
  saveSessions,
  startNewSession,
  cloneSession as cloneSessionStorage,
  deleteSession as deleteSessionStorage,
  deleteSessions as deleteSessionsStorage,
} from '../storage';
import {
  resolveActiveId,
  runWithRollback,
  withAddedCharacter,
  withDeletedCharacter,
  withDeletedCharacters,
  withPinnedCharacter,
  withSwitchedCharacter,
  withUpdatedCharacter,
} from './characterLibrary';
import { resolveActiveSessionId, sortSessions } from './sessionLibrary';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [characters, setCharactersState] = useState([DEFAULT_CHARACTER]);
  const [activeId, setActiveIdState] = useState(DEFAULT_CHARACTER.id);
  const [sessions, setSessionsState] = useState([]);
  const [activeSessionId, setActiveSessionIdState] = useState('');
  const [pendingTarget, setPendingTargetState] = useState(null);
  const [loaded, setLoaded] = useState(false);
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
        const resolved = resolveActiveId(list, storedActiveId);
        const sortedSessions = sortSessions(sessionList);
        const resolvedSessionId = resolveActiveSessionId(sortedSessions, storedActiveSessionId);
        charactersRef.current = list;
        activeIdRef.current = resolved;
        sessionsRef.current = sortedSessions;
        activeSessionIdRef.current = resolvedSessionId;
        setCharactersState(list);
        setActiveIdState(resolved);
        setSessionsState(sortedSessions);
        setActiveSessionIdState(resolvedSessionId);
        if (resolved !== storedActiveId) {
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

  const deleteCharacter = useCallback(async id => {
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
        saveCharacterState(result.list, result.activeId, id)
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

  const deleteCharacters = useCallback(async ids => {
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
      const totalDeletable = snapshot.list.filter(item => item.id !== DEFAULT_CHARACTER.id).length;
      if (list.length >= totalDeletable) {
        throw new Error('至少保留一个角色');
      }
      const result = withDeletedCharacters(snapshot.list, list, snapshot.activeId);
      if (result.removedCount === 0) {
        throw new Error('角色不存在');
      }
      applyList(result.list);
      activeIdRef.current = result.activeId;
      setActiveIdState(result.activeId);
      await runWithRollback(snapshot, restore, () =>
        saveCharacterState(result.list, result.activeId)
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

  const refreshSessions = useCallback(async () => {
    const [sessionList, storedActiveSessionId] = await Promise.all([
      getSessions(),
      getActiveSessionId(),
    ]);
    const sorted = applySessions(sessionList);
    const resolved = resolveActiveSessionId(sorted, storedActiveSessionId);
    applyActiveSessionId(resolved);
    return sorted;
  }, [applySessions, applyActiveSessionId]);

  const ensureCharacterSession = useCallback(async characterId => {
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
        const created = await startNewSession(targetId);
        await refreshSessions();
        return sessionsRef.current.find(session => session.id === created.id) || created;
      } catch (error) {
        await refreshSessions().catch(() => {});
        throw error;
      }
    });
  }, [applyActiveSessionId, refreshSessions, enqueueMutation]);

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
        await refreshSessions().catch(() => {});
        throw error;
      }
    });
  }, [applySessions, applyActiveSessionId, refreshSessions, enqueueMutation]);

  const deleteSessions = useCallback(async ids => {
    if (!loadedRef.current) {
      throw new Error('会话尚未加载完成');
    }
    const targets = (Array.isArray(ids) ? ids : [])
      .map(id => String(id || ''))
      .filter(Boolean);
    if (targets.length === 0) return sessionsRef.current;
    return enqueueMutation(async () => {
      const snapshot = snapshotSessions();
      try {
        if (targets.includes(snapshot.activeSessionId)) {
          const current = snapshot.sessions.find(
            session => session.id === snapshot.activeSessionId
          );
          await startNewSession(current ? current.characterId : '');
        }
        const result = await deleteSessionsStorage(targets);
        const sorted = applySessions(result.sessions);
        const resolved = resolveActiveSessionId(sorted, result.activeSessionId);
        applyActiveSessionId(resolved);
        return sorted;
      } catch (error) {
        await refreshSessions().catch(() => {});
        throw error;
      }
    });
  }, [applySessions, applyActiveSessionId, refreshSessions, enqueueMutation]);

  const character = useMemo(
    () => characters.find(item => item.id === activeId)
      || characters.find(item => item.id === DEFAULT_CHARACTER.id)
      || DEFAULT_CHARACTER,
    [characters, activeId]
  );

  const value = useMemo(
    () => ({
      character,
      characters,
      activeId,
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
      ensureCharacterSession,
      pendingTarget,
      setPendingTarget,
      consumePendingTarget,
    }),
    [
      character,
      characters,
      activeId,
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
      ensureCharacterSession,
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