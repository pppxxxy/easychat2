// 符号引用查找工具（find_references）：按标识符整词匹配，返回「文件:行号 [定义|引用]」清单，
// 让 agent 在重构前快速知道「这个函数/类在哪些地方被用到」。只读、零副作用。
//
// 与 search_workspace 的分工：后者是**文本**搜索（子串即可命中，适合找配置项/字符串）；
// 本工具是**符号**搜索（整词 + 定义/引用分类，适合重构前的影响面分析）。纯扫描在 references.js。

import { scanReferences, REFERENCES_DEFAULTS } from '../references.js';

export const FIND_REFERENCES_TOOL_DEFINITION = {
  name: 'find_references',
  description: '查找一个符号（函数/类/变量名）在工作区里的所有出现位置，并区分「定义」与「引用」——重构前评估影响面时用它。整词匹配（不会把 myFuncX 误当 myFunc）。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: '要查找的符号名（如 runAgentTurn）。' },
      subdir: { type: 'string', description: '可选：只在该子目录内查找。' },
      contextLines: { type: 'number', description: '可选：每个命中前后各显示的上下文行数（默认 0，上限 3）。' },
      maxMatchesPerFile: { type: 'number', description: '可选：单文件最多返回的命中数（默认 50）。' },
    },
    required: ['symbol'],
  },
  execute: async (options, args, ctx) => {
    const symbol = String(args.symbol === undefined || args.symbol === null ? '' : args.symbol).trim();
    if (!symbol) return { content: '请提供 symbol（要查找的符号名）。', isError: true };
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
      if (Date.now() - startTime >= REFERENCES_DEFAULTS.timeBudgetMs) break;
      try {
        const result = await store.readWorkspaceFile({ characterId, path });
        files.push({ path, content: String((result && result.content) || '') });
      } catch (error) {
        // 读不了就跳过（二进制 / 权限 / 已删）——引用查找是尽力而为。
      }
    }

    const outcome = scanReferences(files, {
      symbol,
      contextLines: args.contextLines,
      maxMatchesPerFile: args.maxMatchesPerFile,
      startTime,
    });
    if (!outcome.text) return `（未找到「${symbol}」的引用）`;
    const head = `「${symbol}」：${outcome.total} 处（定义 ${outcome.definitions} / 引用 ${outcome.references}，涉及 ${outcome.fileCount} 个文件）\n`;
    const suffix = outcome.truncated ? '\n…（结果已达输出/时间上限，可能不完整；可用 subdir 收窄范围）' : '';
    return `${head}${outcome.text}${suffix}`;
  },
};
