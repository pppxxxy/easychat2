// 显式带 .js 扩展名：Metro 与 Node ESM 都能解析，便于对世界书匹配逻辑做单测
import { compileRegexCached, isUnsafeRegexPattern } from './regexEngine.js';

const DEFAULT_SCAN_DEPTH = 4;

// 与 regexEngine 一致：给正则匹配的文本设长度上限，超长时只匹配尾部（最新内容），
// 避免第三方卡片里的灾难性回溯模式卡死主线程。
const MAX_REGEX_INPUT_CHARS = 20000;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// JS 的 \b 按 ASCII 单词字符判断边界，中文关键词会被整体判为无边界。
// 含 CJK 字符时退回子串匹配，保持“整词”开关可用。
const CJK_PATTERN = /[\u2e80-\u2fff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

function hasCjk(text) {
  return CJK_PATTERN.test(String(text || ''));
}

function regexScope(haystack) {
  return haystack.length > MAX_REGEX_INPUT_CHARS
    ? haystack.slice(-MAX_REGEX_INPUT_CHARS)
    : haystack;
}

// 兼容 SillyTavern 的 /pattern/flags 键写法：即使条目未显式开启 useRegex 也按正则处理。
function keyLooksLikeRegex(keyword) {
  const text = String(keyword || '');
  return text.length > 2 && text.startsWith('/') && text.lastIndexOf('/') > 0;
}

function keywordMatches(keyword, haystack, entry) {
  if (!keyword || !haystack) return false;
  const caseSensitive = entry.caseSensitive === true;
  const flags = caseSensitive ? '' : 'i';
  const slashRegex = keyLooksLikeRegex(keyword);
  if (entry.useRegex || slashRegex) {
    if (isUnsafeRegexPattern(keyword)) return false;
    try {
      const source = entry.matchWholeWords && !slashRegex && !hasCjk(keyword)
        ? `\\b(?:${keyword})\\b`
        : keyword;
      return compileRegexCached(source, flags).test(regexScope(haystack));
    } catch (error) {
      return false;
    }
  }
  if (entry.matchWholeWords) {
    if (hasCjk(keyword)) {
      const source = caseSensitive ? haystack : haystack.toLowerCase();
      const needle = caseSensitive ? keyword : keyword.toLowerCase();
      return source.includes(needle);
    }
    try {
      const re = compileRegexCached(`\\b${escapeRegExp(keyword)}\\b`, flags);
      return re.test(regexScope(haystack));
    } catch (error) {
      return false;
    }
  }
  const source = caseSensitive ? haystack : haystack.toLowerCase();
  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  return source.includes(needle);
}

function matchesAnyKeyword(keys, haystack, entry) {
  return keys.some(key => keywordMatches(key, haystack, entry));
}

// 运行时会被灾难性回溯防护跳过的关键词：世界书编辑页据此提示用户，
// 避免条目静默失效被误以为“没命中”。
export function getUnsafeWorldEntryKeys(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const keys = Array.isArray(source.keys) ? source.keys : [];
  return keys.filter(key => (
    (source.useRegex || keyLooksLikeRegex(key)) && isUnsafeRegexPattern(key)
  ));
}

function buildScanText(entry, messageTexts) {
  const depth = Number.isFinite(entry.scanDepth)
    ? Math.max(1, entry.scanDepth)
    : DEFAULT_SCAN_DEPTH;
  return messageTexts.slice(-depth).join('\n');
}

function rollProbability(entry) {
  if (entry.useProbability === false) return true;
  const probability = Number(entry.probability);
  if (!Number.isFinite(probability) || probability >= 100) return true;
  if (probability <= 0) return false;
  return Math.random() * 100 < probability;
}

export function isEntryActive(entry, messageTexts) {
  if (!entry || entry.enabled === false) return false;
  if (entry.constant) return rollProbability(entry);
  const keys = Array.isArray(entry.keys) ? entry.keys : [];
  if (keys.length === 0) return false;
  const haystack = buildScanText(entry, messageTexts);
  if (!matchesAnyKeyword(keys, haystack, entry)) return false;
  if (entry.selective && Array.isArray(entry.secondaryKeys) && entry.secondaryKeys.length > 0) {
    if (!matchesAnyKeyword(entry.secondaryKeys, haystack, entry)) return false;
  }
  return rollProbability(entry);
}

export function collectActiveWorldInfo(character, historyMessages, latestUserText) {
  const entries = Array.isArray(character?.worldInfo) ? character.worldInfo : [];
  if (entries.length === 0) {
    return { before: [], after: [], depth: [] };
  }
  const messageTexts = (Array.isArray(historyMessages) ? historyMessages : [])
    .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
    .map(item => String(item.text || ''));
  messageTexts.push(String(latestUserText || ''));

  const active = entries.filter(entry => isEntryActive(entry, messageTexts));
  const byOrder = (a, b) => (a.order ?? 100) - (b.order ?? 100);

  return {
    before: active.filter(entry => entry.position === 0).sort(byOrder),
    after: active.filter(entry => entry.position !== 0 && entry.position !== 4).sort(byOrder),
    depth: active.filter(entry => entry.position === 4).sort(byOrder),
  };
}

export function buildWorldInfoText(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map(entry => String(entry?.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
}
