export const REGEX_PLACEMENT = {
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
};

// 正则来自第三方卡片或用户输入，可能是灾难性回溯模式（例如 (a+)+$）。
const MAX_REGEX_INPUT_CHARS = 8 * 1024 * 1024;
const HTML_SEGMENT_PATTERN = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^>]+>/gi;
const COMPILED_CACHE_LIMIT = 300;
const compiledCache = new Map();

export function compileRegexCached(findRegex, flags = 'g') {
  const key = `${flags}\u0000${String(findRegex ?? '')}`;
  const cached = compiledCache.get(key);
  if (cached) {
    cached.lastIndex = 0;
    return cached;
  }
  const compiled = compileRegex(findRegex, flags);
  if (compiledCache.size >= COMPILED_CACHE_LIMIT) compiledCache.clear();
  compiledCache.set(key, compiled);
  return compiled;
}

export function compileRegex(findRegex, flags = 'g') {
  let pattern = String(findRegex ?? '');
  let effectiveFlags = String(flags ?? 'g');
  new RegExp('', effectiveFlags);
  if (pattern.startsWith('/')) {
    let escaped = false;
    let inClass = false;
    let delimiter = -1;
    for (let index = 1; index < pattern.length; index += 1) {
      const char = pattern[index];
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '[') {
        inClass = true;
      } else if (char === ']') {
        inClass = false;
      } else if (char === '/' && !inClass) {
        delimiter = index;
      }
    }
    if (delimiter >= 0) {
      effectiveFlags = pattern.slice(delimiter + 1);
      pattern = pattern.slice(1, delimiter);
    }
  }
  if (pattern.length === 0) throw new Error('匹配表达式不能为空。');
  return new RegExp(pattern, effectiveFlags);
}

// 兼容把 `$0` 当整段匹配的写法（JS 原生只认 `$&`，`$0` 会被当字面量）。
// 先把 `$$`（JS 里表示字面量 `$`）保护起来，再转换真正的 `$0`，避免误伤 `$$0`。
const DOLLAR_SENTINEL = '\u0000DOLLAR\u0000';
function normalizeReplacement(replacement) {
  return String(replacement ?? '')
    .replace(/\$\$/g, DOLLAR_SENTINEL)
    .replace(/\$0(?![0-9])/g, '$$&')
    .split(DOLLAR_SENTINEL).join('$$');
}

// 展示正则需要在「不改写标签/脚本/样式」的前提下保留整条消息的锚点语义。
// 做法：把受保护片段换成私有区哨兵，在整串上跑一次正则，再把哨兵还原。
// 逐段替换会把 `$`/`^` 降级成单个文本段的边界，导致错序和成倍复制。
const SENTINEL_START = '\uE000';
const SENTINEL_END = '\uE001';
const SENTINEL_DIGIT_BASE = 0xE010;
const SENTINEL_PATTERN = /\uE000[\uE010-\uE019]+\uE001/g;

function encodeSentinelIndex(index) {
  return String(index)
    .split('')
    .map(digit => String.fromCharCode(SENTINEL_DIGIT_BASE + (digit.charCodeAt(0) - 48)))
    .join('');
}

function decodeSentinelIndex(token) {
  return Number(token.slice(1, -1)
    .split('')
    .map(char => String(char.charCodeAt(0) - SENTINEL_DIGIT_BASE))
    .join(''));
}

function replaceVisibleText(input, regex, replacement) {
  const segments = new RegExp(HTML_SEGMENT_PATTERN.source, 'gi');
  const protectedValues = [];
  let tokenized = '';
  let cursor = 0;
  let match;
  while ((match = segments.exec(input)) !== null) {
    tokenized += input.slice(cursor, match.index);
    tokenized += `${SENTINEL_START}${encodeSentinelIndex(protectedValues.length)}${SENTINEL_END}`;
    protectedValues.push(match[0]);
    cursor = match.index + match[0].length;
    if (match[0].length === 0) segments.lastIndex += 1;
  }
  tokenized += input.slice(cursor);

  regex.lastIndex = 0;
  const replaced = tokenized.replace(regex, replacement);
  regex.lastIndex = 0;

  const restore = new RegExp(SENTINEL_PATTERN.source, 'g');
  return replaced.replace(restore, token => {
    const original = protectedValues[decodeSentinelIndex(token)];
    return original === undefined ? token : original;
  });
}

function withinDepth(script, depth) {
  if (depth === null || depth === undefined) return true;
  if (script.minDepth !== null && script.minDepth !== undefined && depth < script.minDepth) {
    return false;
  }
  if (script.maxDepth !== null && script.maxDepth !== undefined && depth > script.maxDepth) {
    return false;
  }
  return true;
}

export function applyRegexScripts(text, scripts, placement, options = {}) {
  const input = String(text ?? '');
  const list = Array.isArray(scripts) ? scripts : [];
  if (list.length === 0) return input;
  const mode = options.mode || 'both';
  const head = input.length > MAX_REGEX_INPUT_CHARS
    ? input.slice(0, input.length - MAX_REGEX_INPUT_CHARS)
    : '';
  let output = head ? input.slice(-MAX_REGEX_INPUT_CHARS) : input;

  for (const script of list) {
    if (!script || script.enabled === false) continue;
    if (!Array.isArray(script.placement) || !script.placement.includes(placement)) continue;
    if (mode === 'prompt' && script.markdownOnly && !script.promptOnly) continue;
    if (mode === 'display' && script.promptOnly && !script.markdownOnly) continue;
    if (!script.findRegex) continue;
    if (!withinDepth(script, options.depth)) continue;
    try {
      const regex = compileRegexCached(script.findRegex, script.flags);
      let replacement = normalizeReplacement(script.replaceString);
      if (mode === 'display' && /^\s*<style\b[^>]*>(?:(?!<\/style>)[\s\S])*<\/style>$/i.test(replacement)) {
        replacement += '\n';
      }
      const hasMarkup = /<[^>]+>/i.test(output);
      const insertsMarkup = /<[^>]+>/i.test(replacement);
      const isDocumentReplacement = /<!doctype\s+html\b|<html[\s>]/i.test(replacement);
      output = mode === 'display' && hasMarkup && insertsMarkup && !isDocumentReplacement
        ? replaceVisibleText(output, regex, replacement)
        : output.replace(regex, replacement);
    } catch (error) {
      // 非法正则直接跳过，避免影响整条消息链路
    }
  }

  return head + output;
}
