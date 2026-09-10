import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert } from 'react-native';

import { DEFAULT_CHARACTER, getCharacter, saveCharacter } from '../storage';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [character, setCharacterState] = useState(DEFAULT_CHARACTER);
  const [loaded, setLoaded] = useState(false);
  const characterRef = useRef(DEFAULT_CHARACTER);
  const loadedRef = useRef(false);

  useEffect(() => {
    getCharacter()
      .then(saved => {
        characterRef.current = saved;
        setCharacterState(saved);
      })
      .catch(() => {
        characterRef.current = DEFAULT_CHARACTER;
        setCharacterState(DEFAULT_CHARACTER);
      })
      .finally(() => {
        loadedRef.current = true;
        setLoaded(true);
      });
  }, []);

  const updateCharacter = useCallback(async patch => {
    if (!loadedRef.current) {
      throw new Error('角色尚未加载完成');
    }
    const oldCharacter = characterRef.current;
    const merged = {
      ...oldCharacter,
      ...patch
    };
    characterRef.current = merged;
    setCharacterState(merged);
    try {
      await saveCharacter(merged);
    } catch (error) {
      characterRef.current = oldCharacter;
      setCharacterState(oldCharacter);
      Alert.alert('保存失败，请检查存储空间或权限');
      throw error;
    }
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
