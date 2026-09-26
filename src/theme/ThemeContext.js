import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, PixelRatio, useWindowDimensions } from 'react-native';

import {
  DEFAULT_FONT_SCALE_ID,
  DEFAULT_THEME_ID,
  FONT_SCALES,
  THEMES,
  getFontOption,
  getTheme,
  resolveFontScale,
} from './themes';
import {
  getAppearanceSettings,
  saveAppearanceSettings,
} from '../storage';
import { tokens } from './tokens';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [themeId, setThemeId] = useState(DEFAULT_THEME_ID);
  const [fontScaleId, setFontScaleId] = useState(DEFAULT_FONT_SCALE_ID);
  const mountedRef = useRef(true);
  const themeIdRef = useRef(DEFAULT_THEME_ID);
  const fontScaleIdRef = useRef(DEFAULT_FONT_SCALE_ID);
  const lastSavedRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve());
  const persistRevisionRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    const revisionAtLoad = persistRevisionRef.current;
    getAppearanceSettings()
      .then(settings => {
        if (!mountedRef.current) return;
        // 加载期间用户已经改过外观（且已把新值写盘）：晚到的旧磁盘回填
        // 不得把界面拉回旧值——跳过回填，让界面停留在用户的新选择上。
        if (persistRevisionRef.current !== revisionAtLoad) return;
        themeIdRef.current = settings.themeId;
        fontScaleIdRef.current = settings.fontScaleId;
        lastSavedRef.current = {
          themeId: settings.themeId,
          fontScaleId: settings.fontScaleId,
        };
        setThemeId(settings.themeId);
        setFontScaleId(settings.fontScaleId);
      })
      .catch(() => {});
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const persist = useCallback(next => {
    const revision = ++persistRevisionRef.current;
    const run = saveQueueRef.current
      .catch(() => {})
      .then(() => saveAppearanceSettings(next));
    saveQueueRef.current = run;
    run
      .then(() => {
        // 队列已保证成功按顺序结算：无条件推进“最后成功”快照，
        // 它必须始终等于磁盘上真实存在的值，回滚时才不会出现状态与存储分叉。
        lastSavedRef.current = next;
      })
      .catch(() => {
        // 旧失败晚到不得回滚新选择：A 失败、B 成功时，A 的回滚会把界面拉回旧主题，
        // 而磁盘里已经是 B。只有这次仍是最新一次选择时才回滚到最后成功值。
        if (revision !== persistRevisionRef.current) return;
        const fallback = lastSavedRef.current;
        if (fallback && mountedRef.current) {
          themeIdRef.current = fallback.themeId;
          fontScaleIdRef.current = fallback.fontScaleId;
          setThemeId(fallback.themeId);
          setFontScaleId(fallback.fontScaleId);
        }
        Alert.alert('外观设置保存失败', '请检查存储空间或权限。');
      });
  }, []);

  const changeTheme = useCallback(id => {
    const resolved = getTheme(id).id;
    themeIdRef.current = resolved;
    setThemeId(resolved);
    persist({ themeId: resolved, fontScaleId: fontScaleIdRef.current });
  }, [persist]);

  const changeFontScale = useCallback(id => {
    const resolved = getFontOption(id).id;
    fontScaleIdRef.current = resolved;
    setFontScaleId(resolved);
    persist({ themeId: themeIdRef.current, fontScaleId: resolved });
  }, [persist]);

  const theme = useMemo(() => getTheme(themeId), [themeId]);

  const { fontScale: windowFontScale } = useWindowDimensions();
  const systemScale = windowFontScale || PixelRatio.getFontScale();

  const value = useMemo(() => {
    const scale = resolveFontScale(fontScaleId, systemScale);
    const scaled = size => Math.round(Number(size || 0) * scale);
    return {
      theme,
      themes: THEMES,
      themeId,
      setThemeId: changeTheme,
      fontScaleId,
      fontScales: FONT_SCALES,
      setFontScaleId: changeFontScale,
      fontScale: scale,
      fonts: { scale, scaled },
      tokens,
    };
  }, [theme, themeId, changeTheme, fontScaleId, changeFontScale, systemScale]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context) return context;
  const fallbackScale = 1;
  return {
    theme: getTheme(DEFAULT_THEME_ID),
    themes: THEMES,
    themeId: DEFAULT_THEME_ID,
    setThemeId: () => {},
    fontScaleId: DEFAULT_FONT_SCALE_ID,
    fontScales: FONT_SCALES,
    setFontScaleId: () => {},
    fontScale: fallbackScale,
    fonts: {
      scale: fallbackScale,
      scaled: size => Math.round(Number(size || 0) * fallbackScale),
    },
    tokens,
  };
}
