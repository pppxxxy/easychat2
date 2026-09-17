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
} from '../storage';
import {
  resolveActiveId,
  runWithRollback,
  withAddedCharacter,
  withDeletedCharacter,
  withSwitchedCharacter,
  withUpdatedCharacter,
} from './characterLibrary';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [characters, setCharactersState] = useState([DEFAULT_CHARACTER]);
  const [activeId, setActiveIdState] = useState(DEFAULT_CHARACTER.id);
  const [loaded, setLoaded] = useState(false);
  const charactersRef = useRef([DEFAULT_CHARACTER]);
  const activeIdRef = useRef(DEFAULT_CHARACTER.id);
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
        const list = await getCharacterLibrary();
        const storedActiveId = await getActiveCharacterId();
        if (cancelled) return;
        const resolved = resolveActiveId(list, storedActiveId);
        charactersRef.current = list;
        activeIdRef.current = resolved;
        setCharactersState(list);
        setActiveIdState(resolved);
        if (resolved !== storedActiveId) {
          setActiveCharacterId(resolved).catch(() => {});
        }
      } catch (error) {
        if (cancelled) return;
        charactersRef.current = [DEFAULT_CHARACTER];
        activeIdRef.current = DEFAULT_CHARACTER.id;
        setCharactersState([DEFAULT_CHARACTER]);
        setActiveIdState(DEFAULT_CHARACTER.id);
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