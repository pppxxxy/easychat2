import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { DEFAULT_CHARACTER, getCharacter, saveCharacter } from '../storage';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [character, setCharacterState] = useState(DEFAULT_CHARACTER);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getCharacter().then(saved => {
      setCharacterState(saved);
      setLoaded(true);
    });
  }, []);

  const updateCharacter = useCallback(async patch => {
    const merged = {
      ...DEFAULT_CHARACTER,
      ...patch
    };
    setCharacterState(merged);
    await saveCharacter(merged);
    return merged;
  }, []);

  const value = useMemo(
    () => ({ character, loaded, updateCharacter }),
    [character, loaded, updateCharacter]
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
