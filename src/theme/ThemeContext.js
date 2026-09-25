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

  useEffect(() => {
    mountedRef.current = true;
    getAppearanceSettings()
      .then(settings => {
        if (!mountedRef.current) return;
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
    const run = saveQueueRef.current
      .catch(() => {})
      .then(() => saveAppearanceSettings(next));
    saveQueueRef.current = run;
    run
      .then(() => {
        lastSavedRef.current = next;
      })
      .catch(() => {
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
