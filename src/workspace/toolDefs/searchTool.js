// 工作区搜索工具（search_workspace）：在文本文件里按字面量或正则查找内容，
// 返回「文件:行号 + 匹配行及上下文」的片段——即「摘要 + 指针」式 grep，让 agent
// 不必 list 全量再逐文件读就能定位符号 / 函数 / 配置项。
//
// 纯扫描函数（searchWorkspaceText）与工具壳分离：前者零 I/O、Node 可直测命中矩阵与
// 预算；后者只负责取文件列表、逐个读入（受同一时间预算约束）再交给纯函数。

import { clampInt } from '../../utils/clampInt.js';

export const SEARCH_DEFAULTS = Object.freeze({
  contextLines: 2,
  maxContextLines: 5,
  maxMatchesPerFile: 20,
  maxMatchesPerFileCap: 100,
  // 自有输出上限（8KB）：16KB 序列化头尾保留之前的更小护栏，避免中段省略把命中结果吃掉。
  // 注意：工具执行路径会把该上限调高（见 SEARCH_TOOL_OUTPUT_CHARS），让超大结果走 O1 落盘
  // 而非就地截断——纯函数默认值仍用于小结果与单测。
  maxOutputChars: 8 * 1024,
  // 总时间预算：防灾难性正则（ReDoS）拖死整轮 turn；超时返回已完成部分并标注。
  timeBudgetMs: 2000,
});

// O2/M1 追加：工具执行路径的输出硬上限。设得远高于序列化上限（16KB），使「搜索命中很多、
// 结果很大」时由循环的 O1 落盘管道接管（整份存 .task_outputs/ + 消息里留预览+指针），
// 而不是在工具内就地截断丢失中段。纯函数默认 8KB 仍用于常规小结果。
export const SEARCH_TOOL_OUTPUT_CHARS = 1024 * 1024;

// 整数夹取用唯一实现 utils/clampInt.js（此处曾有一份参数顺序不同的私有副本）。

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
  const ctx = clampInt(contextLines, {
    min: 0, max: SEARCH_DEFAULTS.maxContextLines, fallback: SEARCH_DEFAULTS.contextLines,
  });
  const perFile = clampInt(maxMatchesPerFile, {
    min: 1, max: SEARCH_DEFAULTS.maxMatchesPerFileCap, fallback: SEARCH_DEFAULTS.maxMatchesPerFile,
  });
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
    // 先按**文件名**收窄，再逐个读内容。
    //
    // 为什么必须这一步（真机日志 2026-10-18）：旧实现无条件把工作区里每个文件都读一遍，
    // 读到 2000ms 预算用完就 break——于是 search_workspace 连续 4 次都耗时
    // 2005/2005/2007/2007ms，每次都是**被预算切断的半成品**，模型拿不到完整结果只能再搜。
    // 搜索的时间应该花在「匹配」上，而不是花在「把整个工作区的正文搬进内存」上。
    //
    // 命中判定：pattern 是字面量时，文件名包含它就优先读（这是绝大多数
    // 「找某个配置/符号在哪个文件」的实际形态）；regex 模式下用文件名试匹配，
    // 非法正则/不匹配都不影响——**文件内容仍会被搜**，只是排到后面。
    // 关键：这是**排序**而不是过滤。滤掉文件名不含 pattern 的文件会漏掉
    // 「内容里有、文件名里没有」的正常命中（那是搜索的主要场景）。
    const needle = String(pattern || '');
    let candidates = Array.isArray(paths) ? paths.slice() : [];
    if (needle) {
      const nameHits = [];
      const rest = [];
      let nameMatcher = null;
      if (regex) {
        try {
          nameMatcher = new RegExp(needle);
        } catch (error) {
          nameMatcher = null; // 非法正则：交给下面的纯函数统一报 bad-regex
        }
      }
      for (const path of candidates) {
        const text = String(path || '');
        const base = text.slice(text.lastIndexOf('/') + 1);
        const hit = nameMatcher ? nameMatcher.test(base) : (base.includes(needle) || text.includes(needle));
        if (hit) nameHits.push(path);
        else rest.push(path);
      }
      candidates = nameHits.concat(rest);
    }
    const files = [];
    // 读取阶段是否被预算截断：必须单独记着。
    // 旧实现只把 startTime 传给纯函数，而纯函数的 truncated 只在**它自己**超时时为真——
    // 读取阶段先被切断的情况完全不可见。后果是模型收到一份「看起来完整」的结果：
    // 若没命中，它会得到「（未找到匹配）」并据此断言「工作区里没有 X」，
    // 而真相是「一半文件还没读」。这是**把没查完说成查过了**，比慢更危险。
    let readTruncated = false;
    for (const path of candidates) {
      if (Date.now() - startTime >= SEARCH_DEFAULTS.timeBudgetMs) {
        readTruncated = true;
        break;
      }
      try {
        const result = await store.readWorkspaceFile({ characterId, path });
        files.push({ path, content: String((result && result.content) || '') });
      } catch (error) {
        // 读不了就跳过（二进制 / 权限 / 已删）——搜索是尽力而为。
      }
    }

    // ⚠️ 匹配阶段的预算必须**从此刻重新起算**，不能沿用 startTime。
    //
    // 这是一个真实的数据缺陷（真机日志 2026-10-18 暴露）：读取和匹配共用同一个
    // 2000ms 预算，于是「读取把预算花光」⇒ 纯函数进循环第一行就 now()-startTime >= 2000
    // ⇒ **一个文件都没扫**，直接 truncated=true、text=''。工具于是回报「未找到匹配」，
    // 而那些文件其实已经在内存里了、根本还没来得及看——既不完整，又在说谎。
    //
    // 拆成两段独立预算后语义才对得上：读取最多花 2000ms 决定"能拿到哪些内容"，
    // 匹配再最多花 2000ms 决定"能看到多少结果"。两段各自都可能被截断，且都如实上报。
    const matchStart = Date.now();
    const outcome = searchWorkspaceText(files, {
      pattern,
      regex,
      contextLines: args.contextLines,
      maxMatchesPerFile: args.maxMatchesPerFile,
      // O2/M1：工具路径用高硬上限——超大结果交给循环的 O1 落盘管道（不就地截断丢中段）。
      maxOutputChars: SEARCH_TOOL_OUTPUT_CHARS,
      startTime: matchStart,
    });
    if (outcome.error === 'bad-regex') {
      return {
        content: `正则语法错误：${outcome.message}。请修正正则，或不传 regex 改用字面量模式。`,
        isError: true,
      };
    }
    if (!outcome.text) {
      // 「没找到」与「没读完」必须分开说：前者是事实，后者是**未知**。
      // 合成一句话会让模型把「未知」当成「没有」，进而对用户做出错误断言。
      return readTruncated
        ? `（在已读取的 ${files.length} 个文件里未找到匹配；读取已达 ${SEARCH_DEFAULTS.timeBudgetMs}ms 时间上限，`
          + '工作区里还有文件没读完——不能据此断定不存在。请用 subdir 收窄范围后重试。）'
        : '（未找到匹配）';
    }
    const truncatedSuffix = '\n…（结果已达输出/时间上限，可能不完整；可用 subdir 收窄范围或调小 contextLines）';
    const suffix = outcome.truncated
      ? truncatedSuffix
      : (readTruncated
        // 命中了，但读取阶段被截断：结果可能不完整，同样要说出来。
        ? `\n…（只搜索了 ${files.length} 个文件（读取达 ${SEARCH_DEFAULTS.timeBudgetMs}ms 上限），`
          + '其余文件未搜索，结果可能不完整；可用 subdir 收窄范围）'
        : '');
    return `${outcome.text}${suffix}`;
  },
};
