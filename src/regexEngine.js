export const REGEX_PLACEMENT = {
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
};

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
  let output = input;

  for (const script of list) {
    if (!script || script.enabled === false) continue;
    if (!Array.isArray(script.placement) || !script.placement.includes(placement)) continue;
    if (mode === 'prompt' && script.markdownOnly && !script.promptOnly) continue;
    if (mode === 'display' && script.promptOnly && !script.markdownOnly) continue;
    if (!script.findRegex) continue;
    if (!withinDepth(script, options.depth)) continue;
    try {
      const regex = compileRegex(script.findRegex, script.flags);
      let replacement = script.replaceString ?? '';
      if (mode === 'display' && /^\s*<style\b[^>]*>(?:(?!<\/style>)[\s\S])*<\/style>$/i.test(replacement)) {
        replacement += '\n';
      }
      output = output.replace(regex, replacement);
    } catch (error) {
      // 非法正则直接跳过，避免影响整条消息链路
    }
  }

  return output;
}
