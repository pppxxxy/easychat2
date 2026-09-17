export const REGEX_PLACEMENT = {
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
};

const ALLOWED_FLAGS = new Set(['g', 'i', 'm', 's', 'u', 'y']);

function normalizeFlags(flags) {
  const raw = String(flags || 'g');
  let result = '';
  for (const flag of raw) {
    if (ALLOWED_FLAGS.has(flag) && !result.includes(flag)) {
      result += flag;
    }
  }
  if (!result.includes('g')) result += 'g';
  return result;
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
    if (mode === 'prompt' && script.markdownOnly) continue;
    if (mode === 'display' && script.promptOnly) continue;
    if (!script.findRegex) continue;
    if (!withinDepth(script, options.depth)) continue;
    try {
      const regex = new RegExp(script.findRegex, normalizeFlags(script.flags));
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
