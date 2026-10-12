import { tActive } from '../i18n/index.js';

export const REGEX_PLACEMENT = {
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
};

// 正则来自第三方卡片或用户输入，可能是灾难性回溯模式（例如 (a+)+$）。
// JS 主线程无法抢占正在执行的正则，这里用嵌套量词启发式识别**一部分**会挂死的模式并跳过。
//
// ⚠️ 覆盖面边界（本函数**不是**安全保证，是「降误伤优先」的启发式）：
//   本函数只覆盖「分组体内含未限定量词（*、+、{n,}），且该分组本身又被无上界量词
//   （*、+、{n,}）重复」这一种形态。以下同样会指数级回溯的形态**一律漏检**：
//     (a|aa)+      —— 交替项可重叠，重复次数可任意拆分
//     (a|a?)+      —— 可空交替项
//     (\w|\w\w)+   —— 多字符交替项
//     (a{2,})+$    —— 体内是 {n,} 而非 * / +（本函数已回补，但同类变体仍可能出现）
//   即「被放行」只表示「没命中这一条启发式」，**不表示**该正则安全。
//   ⇒ 调用方**不得**据此省略执行侧的兜底：applyRegexScripts 的长度 fail-closed
//     （见下方 MAX_REGEX_INPUT_CHARS 注释）才是真正的执行侧防线。
//   ⇒ 先例：src/localModel/adapter.js:278 的 fail-closed 也是「宁可整体不处理，
//     也不半套用」——启发式/预检都不能替代执行侧兜底。
//
// 判定口径：只在「分组体内含未限定量词，且分组本身又被无上界量词（*、+、{n,}）重复」
// 时判定，避免误伤 (a{2,3})+ 这类有界写法。
// 判断分组结束后紧跟的量词是否「无上界」（可无限重复）：*、+、{n,}、{n,}?。
// 有上界的 {n,m} 不在此列——`(a{2,3})+` 这类写成有界的模式仍应放行，避免误伤。
// 体内量词复用同一个 isUnboundedRepeatAfter：{n,} 与 * / + 同为无上界，必须同一口径，
// 否则 `(a+)+$` 被拦而 `(a{2,})+$` 放行，两者危害完全相同（重复次数可任意拆分 ⇒ 指数回溯）。
function isUnboundedRepeatAfter(pattern, at) {
  const char = pattern[at];
  if (char === '*' || char === '+') return true;
  if (char !== '{') return false;
  const close = pattern.indexOf('}', at + 1);
  if (close < 0) return false;
  const inner = pattern.slice(at + 1, close).trim();
  const match = inner.match(/^(\d+)\s*,\s*(\d*)$/);
  return Boolean(match && match[2] === '');
}

export function isUnsafeRegexPattern(findRegex) {
  let pattern = String(findRegex ?? '');
  if (pattern.startsWith('/')) {
    // 与 compileRegex 同一解析口径（最后一个未转义 / 是分隔符）：模式体内
    // 允许出现未转义斜杠（如 /a/b/g）。若这里按第一个 / 截断，模式体尾部的
    // 灾难性回溯结构（/a(?:b+)+c/g）会漏检，主线程仍会执行会挂死的正则。
    let escaped = false;
    let inClass = false;
    let delimiter = -1;
    for (let index = 1; index < pattern.length; index += 1) {
      const char = pattern[index];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) delimiter = index;
    }
    if (delimiter >= 0) pattern = pattern.slice(1, delimiter);
  }
  const stack = [];
  let escaped = false;
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char === '(') {
      stack.push(index);
      continue;
    }
    if (char !== ')' || stack.length === 0) continue;
    const start = stack.pop();
    if (!isUnboundedRepeatAfter(pattern, index + 1)) continue;
    const body = pattern.slice(start + 1, index);
    let bodyEscaped = false;
    let bodyInClass = false;
    for (let cursor = 0; cursor < body.length; cursor += 1) {
      const bodyChar = body[cursor];
      if (bodyEscaped) {
        bodyEscaped = false;
        continue;
      }
      if (bodyChar === '\\') {
        bodyEscaped = true;
        continue;
      }
      if (bodyInClass) {
        if (bodyChar === ']') bodyInClass = false;
        continue;
      }
      if (bodyChar === '[') {
        bodyInClass = true;
        continue;
      }
      if (isUnboundedRepeatAfter(body, cursor)) return true;
      // 命中 {n,} 时把游标跳到 `}` 之后，避免把 `{`、数字、`,` 当普通字符重复扫描
      if (bodyChar === '{') {
        const close = body.indexOf('}', cursor + 1);
        if (close > 0) cursor = close;
      }
    }
  }
  return false;
}

// 展示/提示正则实际只需处理**单条消息**，正常单条消息远小于此值。
//
// 为什么是 fail-closed（超长整条跳过）而不是「只作用于尾部 N 字符」：
// 旧实现是 `head + output`——head 原样拼回，等于**不截断用户可见内容**，却把喂给正则的
// 输入放大到上限大小（原为 8MB）。方向是反的：它不是安全措施，而是给漏检模式
// （见上方启发式的覆盖面边界）提供了更大的爆炸半径。
// 而单纯调小常量会引入更难解释的副作用：正则静默变成「只作用于尾部 N 字符」，
// 「删星号」「改格式」这类展示正则在长消息前段**静默失效**，用户看到半套效果。
// ⇒ 因此语义改成 fail-closed：超长时整条跳过正则、原文逐字返回。
// 「宁可不美化，也不半套用」——内容完整保留、爆炸半径消除、行为可解释。
// 先例：src/localModel/adapter.js:278 同样采用 fail-closed。
//
// 上限值取 20000：单条消息（含 Markdown/HTML 展示文本）在此量级已很宽裕，
// 同时把最坏情况的回溯规模压到可控范围。
const MAX_REGEX_INPUT_CHARS = 20000;
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
  if (pattern.length === 0) throw new Error(tActive('error.regex.emptyPattern'));
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

// 判定一条脚本本次是否会被执行（只做静态过滤，不跑正则）。
// 抽出来是为了「超长整条跳过」时能如实统计被跳过的脚本条数，而不必先跑正则。
function scriptEligible(script, placement, mode, depth) {
  if (!script || script.enabled === false) return false;
  if (!Array.isArray(script.placement) || !script.placement.includes(placement)) return false;
  if (mode === 'prompt' && script.markdownOnly && !script.promptOnly) return false;
  if (mode === 'display' && script.promptOnly && !script.markdownOnly) return false;
  if (!script.findRegex) return false;
  return withinDepth(script, depth);
}

// 给返回的字符串挂上本次调用的统计信息。
// ⚠️ 为什么用 String 包装对象：字符串原始值在严格模式下**无法**挂属性
// （`'a'.x = 1` 会抛 TypeError），而直接改成返回对象又会破坏所有既有调用方
// （它们按原始字符串使用返回值，`assert.equal` / `typeof` 都会变）。
// ⇒ 只有调用方显式传 `{ withStats: true }` 时才返回包装对象；其余情况一律返回原始字符串，
//   既有调用方零改动。包装对象仍可当字符串使用（拼接、模板串、.slice 等都正常）。
function withStats(text, stats) {
  const wrapped = new String(text);
  wrapped.value = text;
  wrapped.applied = stats.applied;
  wrapped.skippedUnsafe = stats.skippedUnsafe;
  wrapped.skippedTooLong = stats.skippedTooLong;
  return wrapped;
}

// 让调用方/日志能看出「本条消息有 N 个正则被执行 / 因何被跳过」。
// ⚠️ 边界（如实说明，不得夸大）：这些计数**只能在正则真正执行前暴露**。
// 一旦某条正则真的发生灾难性回溯，主线程被不可抢占地占死，本函数**根本不会返回**，
// 因此本计数**无法**用于事后诊断「已经发生」的冻结，也无法证明「不会冻结」——
// 它只覆盖「已知会被跳过的形态」，漏检形态（见上方启发式的覆盖面边界）依旧会挂。
export function applyRegexScripts(text, scripts, placement, options = {}) {
  const input = String(text ?? '');
  const list = Array.isArray(scripts) ? scripts : [];
  const mode = options.mode || 'both';
  const wantStats = options.withStats === true;
  const stats = { applied: 0, skippedUnsafe: 0, skippedTooLong: 0 };
  if (list.length === 0) return wantStats ? withStats(input, stats) : input;

  // fail-closed：超长时整条跳过正则、原文逐字返回（理由见 MAX_REGEX_INPUT_CHARS 注释）。
  // 注意这里**不是**只对尾部 N 字符跑正则——那会让展示正则在长消息前段静默失效。
  if (input.length > MAX_REGEX_INPUT_CHARS) {
    for (const script of list) {
      if (scriptEligible(script, placement, mode, options.depth)) stats.skippedTooLong += 1;
    }
    return wantStats ? withStats(input, stats) : input;
  }

  let output = input;

  for (const script of list) {
    if (!scriptEligible(script, placement, mode, options.depth)) continue;
    if (isUnsafeRegexPattern(script.findRegex)) {
      stats.skippedUnsafe += 1;
      continue;
    }
    try {
      const regex = compileRegexCached(script.findRegex, script.flags);
      let replacement = normalizeReplacement(script.replaceString);
      if (mode === 'display' && /^\s*<style\b[^>]*>(?:(?!<\/style>)[\s\S])*<\/style>$/i.test(replacement)) {
        replacement += '\n';
      }
      const hasMarkup = /<[^>]+>/i.test(output);
      const isDocumentReplacement = /<!doctype\s+html\b|<html[\s>]/i.test(replacement);
      output = mode === 'display' && hasMarkup && !isDocumentReplacement
        ? replaceVisibleText(output, regex, replacement)
        : output.replace(regex, replacement);
      stats.applied += 1;
    } catch (error) {
      // 非法正则直接跳过，避免影响整条消息链路
    }
  }

  return wantStats ? withStats(output, stats) : output;
}
