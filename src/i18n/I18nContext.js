// 语言上下文：Provider + useTranslation hook（含 RN 依赖）。
//
// 持久化沿用 ThemeContext 的成熟模式：ref 记最新值、写盘串行化、加载期间用户
// 已改过语言则跳过磁盘回填（避免晚到的旧值把界面拉回去）。
// 语言与主题/字号同存 `@easychat2_appearance` 一个键，天然属于「外观」范畴。

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { getAppearanceSettings, patchAppearanceSettings } from '../storage/settings.js';
import { BASE_LOCALE, LOCALES, resolveLocale, setActiveLocale, translate } from './index.js';

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [localeId, setLocaleId] = useState(BASE_LOCALE);
  const mountedRef = useRef(true);
  const localeIdRef = useRef(BASE_LOCALE);
  const lastSavedRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve());
  const persistRevisionRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    const revisionAtLoad = persistRevisionRef.current;
    getAppearanceSettings()
      .then(settings => {
        if (!mountedRef.current) return;
        // 加载期间用户已改过语言（且已写盘）：跳过回填，停留在用户的新选择上。
        if (persistRevisionRef.current !== revisionAtLoad) return;
        const next = resolveLocale(settings.localeId);
        localeIdRef.current = next;
        lastSavedRef.current = { localeId: next };
        setLocaleId(next);
      })
      .catch(() => {});
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const persist = useCallback(next => {
    const previous = lastSavedRef.current;
    if (previous && previous.localeId === next) return;
    persistRevisionRef.current += 1;
    // 串行写：连续切换语言时保证最后写入的是最新值。
    // 外观键与主题/字号共用，写盘前读现值合并——否则改语言会把 themeId/fontScaleId
    // 归一化回默认值，静默重置用户的外观设置（ThemeContext 侧有对称处理）。
    saveQueueRef.current = saveQueueRef.current
      .catch(() => {})
      .then(() => {
        lastSavedRef.current = { localeId: next };
        // 与 ThemeContext 同理：语言、主题、字号共享外观键，必须走 patch 合并写，
        // 否则切语言会把 themeId/fontScaleId 归一回默认值。
        return patchAppearanceSettings({ localeId: next });
      })
      .catch(() => {});
  }, []);

  const changeLocale = useCallback(id => {
    const next = resolveLocale(id);
    if (next === localeIdRef.current) return next;
    localeIdRef.current = next;
    setLocaleId(next);
    persist(next);
    return next;
  }, [persist]);

  const value = useMemo(() => {
    // 同步活动语言到模块级：崩溃页（StartupErrorBoundary）在 Provider 外面，
    // 拿不到 hook，只能经 tActive() 同步取词。放在这里可覆盖全部更新路径
    // （初载回填 / changeLocale / 未来新增），不会漏。
    setActiveLocale(localeId);
    const t = (key, params) => translate(localeId, key, params);
    return {
      localeId,
      locales: LOCALES,
      setLocaleId: changeLocale,
      t,
      // 便捷形式：t.xxx('key', params)
      translate: t,
    };
  }, [changeLocale, localeId]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

// 无 Provider 时退化为基准语言翻译，而不是抛错——这样单独渲染某个组件
// （如测试、或尚未包在 Provider 里的分支）不会因缺上下文而崩。
const FALLBACK = {
  localeId: BASE_LOCALE,
  locales: LOCALES,
  setLocaleId: () => BASE_LOCALE,
  t: (key, params) => translate(BASE_LOCALE, key, params),
  translate: (key, params) => translate(BASE_LOCALE, key, params),
};

export function useTranslation() {
  return useContext(I18nContext) || FALLBACK;
}

// 只要翻译函数时的快捷 hook（多数组件只需要 t）。
export function useT() {
  return useTranslation().t;
}

export default I18nContext;
