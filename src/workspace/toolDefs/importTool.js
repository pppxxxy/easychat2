// 扩展导入工具（agent 侧）：让工作区助手自己去找扩展、装扩展。
//
// 两个工具：
//   search_extension_repos —— 只读：按关键词搜 GitHub 仓库，给模型候选清单
//   import_extension       —— 可写：从 GitHub / npm / 网址 / 粘贴内容导入技能、命令、
//                             子代理、MCP 服务与扩展包
//
// **刻意不装插件**：workspace/paths.js 写明 `.easychat/plugins.json` 不对 agent 的写工具
// 开放——插件 handler 是会在沙盒里执行的代码，装配源被改写等于执行任意代码；那条注释
// 同时写明「用户仍可在面板/UI 里装插件」。所以这里把「发现的插件」如实回报，让用户
// 在插件面板一键导入（UI 侧 runImport 传 allowPlugins:true）。
//
// **import 模块惰性 require**：它的静态链会拉 workspace/github/restApi.js → fflate。
// 让「加载工作区工具定义」平白多一条 node_modules 依赖，所有 import tools.js 的测试都被迫
// 装包（tests/toolsLayering.test.mjs 会把这种分层破坏直接判失败）。绝大多数对话用不到
// 扩展导入，把这份代价挪到真正调用的那一刻——与 docxTool 同款取舍。

import { tActive } from '../../i18n/index.js';

let importCache;
// 注入点：默认走惰性 require；纯 ESM 测试环境（没有 require）可注入模块实例。
let importOverride = null;
export function setImportModule(module) {
  importOverride = module || null;
}

function getImportModule() {
  if (importOverride) return importOverride;
  if (importCache !== undefined) return importCache;
  try {
    importCache = require('../import/index.js');
  } catch (error) {
    importCache = null;
  }
  return importCache;
}

// MCP 服务的读写在存储层（AsyncStorage + 钥匙串），同样惰性取：
// 拿不到就把 MCP 资产如实记为「跳过」，不影响技能/命令的导入。
function getMcpBridge() {
  try {
    const storage = require('../../storage/settings/mcpServers.js');
    if (!storage || typeof storage.getMcpServers !== 'function' || typeof storage.saveMcpServers !== 'function') {
      return null;
    }
    return { load: () => storage.getMcpServers(), save: list => storage.saveMcpServers(list) };
  } catch (error) {
    return null;
  }
}

export const SEARCH_EXTENSION_REPOS_TOOL_DEFINITION = {
  name: 'search_extension_repos',
  description: '在 GitHub 上按关键词搜索可导入的扩展仓库（技能 / 命令 / 子代理 / MCP 配置 / 插件）。'
    + '返回仓库全名、描述与 star 数；拿到候选后用 import_extension 按 "owner/repo" 导入。'
    + '用户让你「找一下某某插件/技能」时用这个。',
  readOnly: true,
  timeoutMs: 30000,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词，例如 "claude code skill review" 或 "mcp server filesystem"。' },
      limit: { type: 'number', description: '可选：返回条数（1-30，缺省 10）。' },
    },
    required: ['query'],
  },
  execute: async (options, args) => {
    const query = String((args && args.query) || '').trim();
    if (!query) return { content: tActive('error.workspace.importQueryEmpty'), isError: true };
    const api = getImportModule();
    if (!api) return { content: tActive('error.workspace.importUnsupported'), isError: true };
    const repos = await api.findRepos({ query, limit: Number((args && args.limit) || 10) });
    if (repos.length === 0) return { content: tActive('error.workspace.importNoRepo') };
    return {
      content: repos
        .map(item => `${item.fullName}（★${item.stars}）${item.description ? `：${item.description}` : ''}`)
        .join('\n'),
    };
  },
};

export const IMPORT_EXTENSION_TOOL_DEFINITION = {
  name: 'import_extension',
  description: '从一个来源导入扩展并写入工作区。来源写法：GitHub 仓库 "owner/repo" 或仓库 URL；'
    + 'npm 包 "npm:包名" 或包名；单个文件网址；或直接粘贴 MCP 配置 / 扩展包 JSON。'
    + '会识别 Claude Code / Codex / ZCode 等主流 agent 的布局（SKILL.md、commands/、agents/、'
    + '.mcp.json、opencode.json 的 mcp 段）并转成本工作区的技能 / 命令 / 子代理 / MCP 服务。'
    + '注意：插件（含可执行 handler）不在本工具能力内——发现的插件会回报给你，让用户到插件面板安装。',
  readOnly: false,
  // 会写「改 agent 自身行为」的文件（skills / commands / agents / MCP 配置）——逐条确认。
  requiresConfirmation: true,
  timeoutMs: 60000,
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '来源：owner/repo、仓库 URL、npm:包名、文件网址，或粘贴的 JSON 文本。' },
      overwrite: { type: 'boolean', description: '可选：true 则覆盖已存在的同名扩展文件（缺省 false，幂等）。' },
    },
    required: ['source'],
  },
  execute: async (options, args, ctx) => {
    const source = String((args && args.source) || '').trim();
    if (!source) return { content: tActive('error.workspace.importSourceEmpty'), isError: true };
    const api = getImportModule();
    if (!api) return { content: tActive('error.workspace.importUnsupported'), isError: true };
    const result = await api.runImport({
      input: source,
      store: options.store,
      characterId: ctx && ctx.characterId,
      mcp: getMcpBridge(),
      allowPlugins: false,
      overwrite: !!(args && args.overwrite),
    });
    if (!result.ok && (!result.install || result.installSummary.total === 0)) {
      return { content: formatFailure(result), isError: true };
    }
    return { content: formatReport(result) };
  },
};

function formatFailure(result) {
  const label = String((result && result.label) || '').trim();
  const reason = String((result && result.error) || '').trim();
  return `${tActive('error.workspace.importFailed')}${label ? `（${label}）` : ''}${reason ? `：${reason}` : ''}`;
}

// 模型可读的导入报告：装了什么、跳过了什么、为什么。跳过原因如实写出——尤其
// 「插件需要用户手动装」和「stdio 型 MCP 不支持」，否则模型会以为全装上了。
function formatReport(result) {
  const summary = (result && result.installSummary) || { installed: {}, total: 0 };
  const installed = summary.installed || {};
  const lines = [`来源 ${result.label || ''}：已导入 ${summary.total} 项。`];
  const parts = [];
  if (installed.skills) parts.push(`技能 ${installed.skills}`);
  if (installed.commands) parts.push(`命令 ${installed.commands}`);
  if (installed.agents) parts.push(`子代理 ${installed.agents}`);
  if (installed.mcpServers) parts.push(`MCP 服务 ${installed.mcpServers}`);
  if (installed.packs) parts.push(`扩展包 ${installed.packs}`);
  if (parts.length) lines.push(parts.join('、'));
  const skipped = Array.isArray(result.install && result.install.skipped) ? result.install.skipped : [];
  const plugins = skipped.filter(item => item.reason === 'pluginNeedsUserInstall');
  if (plugins.length) {
    lines.push(`发现 ${plugins.length} 个插件（${plugins.map(item => item.name).join('、')}）：插件含可执行代码，`
      + '我这边不能装，请让用户到「扩展 → 插件」页面确认安装。');
  }
  const mcpSkipped = skipped.filter(item => item.reason === 'mcpUnavailable');
  if (mcpSkipped.length) lines.push(`MCP 服务 ${mcpSkipped.length} 个未能写入（存储不可用）。`);
  const notes = Array.isArray(result.artifacts && result.artifacts.notes) ? result.artifacts.notes : [];
  const stdio = notes.filter(item => item.reason === 'stdio');
  if (stdio.length) lines.push(`跳过 ${stdio.length} 个 stdio 型 MCP 服务（本应用只支持 HTTP 型）：${stdio.map(item => item.name).join('、')}`);
  const sse = notes.filter(item => item.reason === 'sse');
  if (sse.length) lines.push(`注意：${sse.length} 个 MCP 服务声明为 sse 传输，本应用按 Streamable HTTP 调用，可能不可用。`);
  const errors = Array.isArray(result.install && result.install.errors) ? result.install.errors : [];
  if (errors.length) lines.push(`失败 ${errors.length} 项：${errors.map(item => `${item.kind} ${item.name}(${item.error})`).join('；')}`);
  // 未带 token 时 GitHub 限流很紧：少装的项必须报出来，否则模型会以为装全了
  const failed = Number(result.meta && result.meta.failed) || 0;
  if (failed > 0) lines.push(`另有 ${failed} 个文件没取到（多半是 GitHub 限流），本次结果可能不完整；可让用户在设置里填 GitHub token 提高限额后重试。`);
  return lines.join('\n');
}
