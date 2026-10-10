// 工作区搜索工具（search_workspace）：在文本文件里按字面量或正则查找内容，
// 返回「文件:行号 + 匹配行及上下文」的片段——即「摘要 + 指针」式 grep，让 agent
// 不必 list 全量再逐文件读就能定位符号 / 函数 / 配置项。
//
// 纯扫描函数（searchWorkspaceText）与工具壳分离：前者零 I/O、Node 可直测命中矩阵与
// 预算；后者只负责取文件列表、逐个读入（受同一时间预算约束）再交给纯函数。

export const SEARCH_DEFAULTS = Object.freeze({
  contextLines: 2,
  maxContextLines: 5,
  maxMatchesPerFile: 20,
  maxMatchesPerFileCap: 100,
  // 自有输出上限（8KB）：16KB 序列化头尾保留之前的更小护栏，避免中段省略把命中结果吃掉。
  maxOutputChars: 8 * 1024,
  // 总时间预算：防灾难性正则（ReDoS）拖死整轮 turn；超时返回已完成部分并标注。
  timeBudgetMs: 2000,
});

function clampInt(value, fallback, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// 纯扫描。files = [{ path, content }]；now/startTime 可注入以便确定性测试时间预算。
// 返回 { text, matchCount, fileCount, truncated, error, message }。
export function searchWorkspaceText(files, {
  pattern = '',
  regex = false,
  contextLines = SEARCH_DEFAULTS.contextLines,
  maxMatchesPerFile = SEARCH_DEFAULTS.maxMatchesPerFile,
  maxOutputChars = SEARCH_DEFAULTS.maxOutputChars,
  now = Date.now,
  startTime = now(),
  timeBudgetMs = SEARCH_DEFAULTS.timeBudgetMs,
} = {}) {
  const needle = String(pattern);
  if (!needle) {
    return { text: '', matchCount: 0, fileCount: 0, truncated: false, error: 'empty-pattern' };
  }
  let matcher = null;
  if (regex) {
    try {
      matcher = new RegExp(needle);
    } catch (error) {
      return {
        text: '', matchCount: 0, fileCount: 0, truncated: false,
        error: 'bad-regex', message: String((error && error.message) || ''),
      };
    }
  }
  const ctx = clampInt(contextLines, SEARCH_DEFAULTS.contextLines, 0, SEARCH_DEFAULTS.maxContextLines);
  const perFile = clampInt(maxMatchesPerFile, SEARCH_DEFAULTS.maxMatchesPerFile, 1, SEARCH_DEFAULTS.maxMatchesPerFileCap);
  const list = Array.isArray(files) ? files : [];

  const blocks = [];
  let matchCount = 0;
  let fileCount = 0;
  let truncated = false;
  let outputLen = 0;

  outer:
  for (const file of list) {
    if (now() - startTime >= timeBudgetMs) {
      truncated = true;
      break;
    }
    const path = String((file && file.path) || '');
    const content = String((file && file.content) || '');
    if (!content) continue;
    const lines = content.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const matched = regex ? matcher.test(line) : line.includes(needle);
      if (matched) hits.push(i);
    }
    if (hits.length === 0) continue;
    fileCount += 1;
    matchCount += hits.length;

    const hitSet = new Set(hits);
    const shown = hits.slice(0, perFile);
    const fileBlocks = [];
    let lastPrinted = -1;
    for (const hit of shown) {
      const from = Math.max(0, hit - ctx);
      const to = Math.min(lines.length - 1, hit + ctx);
      for (let i = from; i <= to; i += 1) {
        if (i <= lastPrinted) continue; // 相邻匹配的上下文重叠时去重
        // grep 风格：匹配行用 `:`，上下文行用 `-`。用命中集合判定——同一行既是
        // 某个匹配的上下文、又是另一个匹配本身时，应按「匹配」显示。
        const sep = hitSet.has(i) ? ':' : '-';
        fileBlocks.push(`${path}${sep}${i + 1}${sep} ${lines[i]}`);
        lastPrinted = i;
      }
    }
    if (hits.length > shown.length) {
      fileBlocks.push(`${path}: （${hits.length} 处匹配，已列前 ${shown.length} 处）`);
    }

    for (const line of fileBlocks) {
      const cost = line.length + 1;
      if (outputLen + cost > maxOutputChars) {
        truncated = true;
        break outer;
      }
      blocks.push(line);
      outputLen += cost;
    }
    blocks.push(''); // 文件之间空一行
    outputLen += 1;
  }

  return {
    text: blocks.join('\n').trim(),
    matchCount,
    fileCount,
    truncated,
    error: '',
  };
}

export const SEARCH_TOOL_DEFINITION = {
  name: 'search_workspace',
  description: '在工作区文本文件里搜索内容（类似 grep）：返回「文件:行号 + 匹配行及上下文」的片段，适合定位符号、函数名、配置项，避免逐个文件盲读。默认按字面量子串匹配；传 regex:true 时按正则匹配。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '要搜索的内容（默认按字面量子串；regex:true 时为正则表达式）。' },
      regex: { type: 'boolean', description: '可选：true 时把 pattern 当作正则表达式（默认 false，按字面量）。' },
      subdir: { type: 'string', description: '可选：只在该子目录内搜索。' },
      contextLines: { type: 'number', description: '可选：每个匹配前后各显示的上下文行数（默认 2，上限 5）。' },
      maxMatchesPerFile: { type: 'number', description: '可选：单个文件最多返回的匹配数（默认 20）。' },
    },
    required: ['pattern'],
  },
  execute: async (options, args, ctx) => {
    const pattern = String(args.pattern === undefined || args.pattern === null ? '' : args.pattern);
    if (!pattern) return { content: '请提供 pattern（要搜索的内容）。', isError: true };
    const regex = args.regex === true;
    if (regex) {
      try {
        new RegExp(pattern);
      } catch (error) {
        return {
          content: `正则语法错误：${String((error && error.message) || '')}。请修正正则，或不传 regex 改用字面量模式。`,
          isError: true,
        };
      }
    }
    const subdir = typeof args.subdir === 'string' ? args.subdir : '';
    const characterId = ctx && ctx.characterId;
    const store = options.store;

    const startTime = Date.now();
    let paths = [];
    try {
      paths = await store.listWorkspaceFiles({ characterId, subdir });
    } catch (error) {
      paths = [];
    }
    const files = [];
    for (const path of (Array.isArray(paths) ? paths : [])) {
      if (Date.now() - startTime >= SEARCH_DEFAULTS.timeBudgetMs) break;
      try {
        const result = await store.readWorkspaceFile({ characterId, path });
        files.push({ path, content: String((result && result.content) || '') });
      } catch (error) {
        // 读不了就跳过（二进制 / 权限 / 已删）——搜索是尽力而为。
      }
    }

    const outcome = searchWorkspaceText(files, {
      pattern,
      regex,
      contextLines: args.contextLines,
      maxMatchesPerFile: args.maxMatchesPerFile,
      startTime,
    });
    if (outcome.error === 'bad-regex') {
      return {
        content: `正则语法错误：${outcome.message}。请修正正则，或不传 regex 改用字面量模式。`,
        isError: true,
      };
    }
    if (!outcome.text) return '（未找到匹配）';
    const suffix = outcome.truncated
      ? '\n…（结果已达输出/时间上限，可能不完整；可用 subdir 收窄范围或调小 contextLines）'
      : '';
    return `${outcome.text}${suffix}`;
  },
};
