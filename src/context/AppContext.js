import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Alert } from 'react-native';

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

  const updateCharacter = useCallback(
    async patch => {
      const merged = {
        ...character,
        ...patch
      };
      const oldCharacter = character;
      setCharacterState(merged);
      try {
        await saveCharacter(merged);
      } catch (error) {
        setCharacterState(oldCharacter);
        Alert.alert('保存失败，请检查存储空间或权限');
      }
      return merged;
    },
    [character]
  );

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
