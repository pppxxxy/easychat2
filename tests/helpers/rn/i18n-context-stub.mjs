// `src/i18n/I18nContext.js` 的**轻量替代**（仅在渲染测试里生效）。
//
// 真实文件为了持久化语言设置而 import `../storage/settings.js`，一渲染就会拖入
// 整条原生存储栈。渲染测试不需要。
//
// 本桩**不伪造任何文案**：`translate` 用的是真实的词条包（src/i18n/index.js），
// 语言是基准语言 zh-CN（与 App 首次启动一致）。所以断言里读到的中文都是真词条。
//
// ⚠️ 同样故意不提供可用的 Provider：测试若需要换语言，直接调 translate(locale, key)
// 取期望值，而不是挂一个假 Provider 让组件「看起来」是英文界面。

import { BASE_LOCALE, LOCALES, translate } from '../../../src/i18n/index.js';

const FALLBACK = {
  localeId: BASE_LOCALE,
  locales: LOCALES,
  setLocaleId: () => BASE_LOCALE,
  t: (key, params) => translate(BASE_LOCALE, key, params),
  translate: (key, params) => translate(BASE_LOCALE, key, params),
};

export function useTranslation() {
  return FALLBACK;
}

export function useT() {
  return FALLBACK.t;
}

export function I18nProvider() {
  throw new Error(
    '渲染测试不提供 I18nProvider（它会拖入原生存储栈）。'
    + '请用 translate(\'zh-CN\', key) 取期望词条，见 tests/helpers/rn/i18n-context-stub.mjs。'
  );
}

export default null;
