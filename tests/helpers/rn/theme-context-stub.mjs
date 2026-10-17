// `src/theme/ThemeContext.js` 的**轻量替代**（仅在渲染测试里生效）。
//
// 真实文件为了持久化外观设置而 import `../storage/settings.js`，一渲染就会把
// AsyncStorage / FileSystem / SecureStore / SQLite 以及 9 个设置子模块全部拉进进程。
// 渲染测试不需要那些副作用。
//
// 本桩**不伪造任何外观数据**：它复用真实文件的 `useTheme()` 无 Provider 回退，
// 也就是 `getTheme(DEFAULT_THEME_ID)` + 真实 tokens。所以组件渲染出来的颜色、
// 字号、圆角与真机默认外观一致。
//
// ⚠️ 这里故意不导出 `ThemeProvider`：任何测试若试图依赖 Provider（从而需要真存储），
// 应该在 import 处直接报错，而不是悄悄拿到一个假 Provider 却以为自己测了真链路。

import { getTheme, DEFAULT_THEME_ID, THEMES, FONT_SCALES, DEFAULT_FONT_SCALE_ID } from '../../../src/theme/themes.js';
import { tokens } from '../../../src/theme/tokens.js';

// 与真实文件的回退**逐字段一致**（见 ThemeContext.js 的 useTheme 末尾）。
export function useTheme() {
  const fallbackScale = 1;
  return {
    theme: getTheme(DEFAULT_THEME_ID),
    themes: THEMES,
    themeId: DEFAULT_THEME_ID,
    setThemeId: () => {},
    customColors: {},
    setCustomColors: () => {},
    fontScaleId: DEFAULT_FONT_SCALE_ID,
    fontScales: FONT_SCALES,
    setFontScaleId: () => {},
    reloadAppearance: async () => {},
    fontScale: fallbackScale,
    fonts: {
      scale: fallbackScale,
      scaled: size => Math.round(Number(size || 0) * fallbackScale),
    },
    tokens,
  };
}

// 渲染测试里没有 Provider，显式抛错比返回假 Provider 更诚实。
export function ThemeProvider() {
  throw new Error(
    '渲染测试不提供 ThemeProvider（它会拖入原生存储栈）。'
    + '请直接依赖 useTheme() 的无 Provider 回退，见 tests/helpers/rn/theme-context-stub.mjs。'
  );
}
