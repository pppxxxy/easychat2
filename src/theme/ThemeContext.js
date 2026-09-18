import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PixelRatio } from 'react-native';

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

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [themeId, setThemeId] = useState(DEFAULT_THEME_ID);
  const [fontScaleId, setFontScaleId] = useState(DEFAULT_FONT_SCALE_ID);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    getAppearanceSettings()
      .then(settings => {
        if (!mountedRef.current) return;
        setThemeId(settings.themeId);
        setFontScaleId(settings.fontScaleId);
      })
      .catch(() => {});
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const persist = useCallback(next => {
    saveAppearanceSettings(next).catch(() => {});
  }, []);

  const changeTheme = useCallback(id => {
    const resolved = getTheme(id).id;
    setThemeId(resolved);
    persist({ themeId: resolved, fontScaleId });
  }, [fontScaleId, persist]);

  const changeFontScale = useCallback(id => {
    const resolved = getFontOption(id).id;
    setFontScaleId(resolved);
    persist({ themeId, fontScaleId: resolved });
  }, [persist, themeId]);

  const theme = useMemo(() => getTheme(themeId), [themeId]);

  const systemScale = PixelRatio.getFontScale();

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
  };
}
