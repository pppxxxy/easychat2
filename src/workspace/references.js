// 符号引用查找（find_references）——LSP-lite 的「跳到引用」切面。
//
// 为什么需要：`search_workspace` 是**文本**搜索（子串即可命中），`list_symbols` 只列单文件
// 顶层符号。要回答「这个函数/类在哪些地方被用到」需要一个**按标识符整词匹配 + 定义/引用
// 分类**的视图——这正是重构前最常问的问题。纯函数、零 IO、可 Node 直测。
//
// 分类口径：某行的行号若命中该文件的顶层符号（复用 symbols.js 的 extractSymbols），
// 记为「定义」，否则记为「引用」。启发式、不追求完备（真 LSP 不可行）。

import { extractSymbols, languageFromPath } from './symbols.js';
import { clampInt } from '../utils/clampInt.js';

export const REFERENCES_DEFAULTS = Object.freeze({
  contextLines: 0,
  maxContextLines: 3,
  maxMatchesPerFile: 50,
  maxMatchesPerFileCap: 200,
  maxOutputChars: 16 * 1024,
  timeBudgetMs: 2500,
});

// 整数夹取用唯一实现 utils/clampInt.js（此处曾有一份参数顺序不同的私有副本）。

export function escapeRegExp(text) {
  return String(text == null ? '' : text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 整词匹配：标识符用 \b 边界；含非标识符字符时退回子串（\b 对 . / : 无意义）。
export function buildSymbolPattern(symbol) {
  const name = String(symbol == null ? '' : symbol).trim();
  if (!name) return null;
  const escaped = escapeRegExp(name);
  return /^[A-Za-z_$][\w$]*$/.test(name)
    ? new RegExp(`\\b${escaped}\\b`)
    : new RegExp(escaped);
}

// 纯扫描。files = [{ path, content }]。返回 { text, fileCount, total, definitions, references, truncated }。
export function scanReferences(files, {
  symbol = '',
  contextLines = REFERENCES_DEFAULTS.contextLines,
  maxMatchesPerFile = REFERENCES_DEFAULTS.maxMatchesPerFile,
  maxOutputChars = REFERENCES_DEFAULTS.maxOutputChars,
  now = Date.now,
  startTime = now(),
  timeBudgetMs = REFERENCES_DEFAULTS.timeBudgetMs,
} = {}) {
  const matcher = buildSymbolPattern(symbol);
  if (!matcher) return { text: '', fileCount: 0, total: 0, definitions: 0, references: 0, truncated: false, error: 'empty-symbol' };
  const ctx = clampInt(contextLines, {
    min: 0, max: REFERENCES_DEFAULTS.maxContextLines, fallback: REFERENCES_DEFAULTS.contextLines,
  });
  const perFile = clampInt(maxMatchesPerFile, {
    min: 1, max: REFERENCES_DEFAULTS.maxMatchesPerFileCap, fallback: REFERENCES_DEFAULTS.maxMatchesPerFile,
  });
  const list = Array.isArray(files) ? files : [];

  const blocks = [];
  let fileCount = 0;
  let total = 0;
  let definitions = 0;
  let references = 0;
  let truncated = false;
  let outputLen = 0;

  outer:
  for (const file of list) {
    if (now() - startTime >= timeBudgetMs) { truncated = true; break; }
    const path = String((file && file.path) || '');
    const content = String((file && file.content) || '');
    if (!content) continue;
    const lines = content.split('\n');
    const defLines = new Set(extractSymbols(content, languageFromPath(path)).map(item => item.line));
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (matcher.test(lines[i])) hits.push(i);
    }
    if (hits.length === 0) continue;
    fileCount += 1;
    total += hits.length;

    const shown = hits.slice(0, perFile);
    const fileBlocks = [];
    for (const hit of shown) {
      const isDef = defLines.has(hit + 1);
      if (isDef) definitions += 1; else references += 1;
      const tag = isDef ? '定义' : '引用';
      const from = Math.max(0, hit - ctx);
      const to = Math.min(lines.length - 1, hit + ctx);
      for (let i = from; i <= to; i += 1) {
        const marker = i === hit ? tag : '  ';
        fileBlocks.push(`${path}:${i + 1}: [${marker}] ${lines[i].trim()}`);
      }
    }
    if (hits.length > shown.length) {
      fileBlocks.push(`${path}: （${hits.length} 处，已列前 ${shown.length} 处）`);
    }

    for (const line of fileBlocks) {
      const cost = line.length + 1;
      if (outputLen + cost > maxOutputChars) { truncated = true; break outer; }
      blocks.push(line);
      outputLen += cost;
    }
    blocks.push('');
    outputLen += 1;
  }

  return {
    text: blocks.join('\n').trim(),
    fileCount,
    total,
    definitions,
    references,
    truncated,
    error: '',
  };
}
