export const REGEX_PLACEMENT = {
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
};

// 正则来自第三方卡片或用户输入，可能是灾难性回溯模式（例如 (a+)+$）。
// 这里给被匹配文本设长度上限：超长时只对「尾部」执行脚本（聊天里最新的内容在尾部），
// 头部原样保留，把最坏耗时限制在可控范围内，而不是卡死 JS 线程。
const MAX_REGEX_INPUT_CHARS = 20000;
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
      output = output.replace(regex, replacement);
    } catch (error) {
      // 非法正则直接跳过，避免影响整条消息链路
    }
  }

  return head + output;
}
