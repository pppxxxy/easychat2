// 国际化核心：语言解析、词条查找与插值（纯逻辑，零 RN 依赖，Node 可测）。
//
// Provider 与 hook 在 ./I18nContext.js（含 RN 依赖，不在此处 import）。
//
// 设计取舍：
// - 缺失词条回退到基准语言（中文）而不是显示 key 或空白——漏译只是没翻，
//   不会让界面出现 `chat.attach.title` 这种给用户看的原始 key；
// - 基准语言本身也缺 key 时返回 key 原文，便于开发期发现漏登记（测试会断言
//   zh-CN 与 en 的 key 集合一致，所以正常不会走到这一步）；
// - 插值用 `{name}` 占位，避免拼接句子（各语言语序不同，拼接无法翻译）。

import { zhCN } from './locales/zh-CN.js';
import { en } from './locales/en.js';

export const BASE_LOCALE = 'zh-CN';

// 语言清单：id 与展示名分离——展示名用各语言自己的写法（语言选择器里
// 「简体中文」在英文界面下也应显示为「简体中文」，而不是 "Chinese"）。
export const LOCALES = [
  { id: 'zh-CN', label: '简体中文', english: 'Chinese (Simplified)' },
  { id: 'en', label: 'English', english: 'English' },
];

export const LOCALE_IDS = LOCALES.map(item => item.id);

const BUNDLES = {
  'zh-CN': zhCN,
  en,
};

export function isSupportedLocale(id) {
  return LOCALE_IDS.includes(String(id || ''));
}

// 归一化为受支持的 locale id；无法识别时回退基准语言。
export function resolveLocale(id) {
  const value = String(id || '');
  if (isSupportedLocale(value)) return value;
  // 容忍常见变体：zh-Hans-CN / zh_CN / en-US / EN
  const lower = value.toLowerCase();
  const exact = LOCALE_IDS.find(item => item.toLowerCase() === lower);
  if (exact) return exact;
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en';
  return BASE_LOCALE;
}

export function getBundle(localeId) {
  return BUNDLES[resolveLocale(localeId)] || BUNDLES[BASE_LOCALE];
}

// 插值：`{count}` 用 params.count 替换；缺失的参数保留原占位符，
// 便于在界面上直接看出是哪个变量没传（比静默留空更好排查）。
export function interpolate(template, params) {
  const source = String(template == null ? '' : template);
  if (!params || typeof params !== 'object') return source;
  return source.replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(params, key) && params[key] != null
      ? String(params[key])
      : match
  ));
}

// 词条查找：当前语言 → 基准语言 → key 本身。
export function translate(localeId, key, params) {
  const id = String(key || '');
  if (!id) return '';
  const bundle = getBundle(localeId);
  const value = bundle[id];
  if (typeof value === 'string' && value) return interpolate(value, params);
  const fallback = BUNDLES[BASE_LOCALE][id];
  if (typeof fallback === 'string' && fallback) return interpolate(fallback, params);
  return id;
}

// 供测试与漏译统计：某语言相对基准语言缺哪些 key。
export function missingKeys(localeId, baseId = BASE_LOCALE) {
  const target = getBundle(localeId);
  const base = BUNDLES[resolveLocale(baseId)] || BUNDLES[BASE_LOCALE];
  return Object.keys(base).filter(key => typeof target[key] !== 'string' || !target[key]);
}

export function allKeys(localeId = BASE_LOCALE) {
  return Object.keys(getBundle(localeId));
}
