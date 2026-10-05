// GitHub MCP 工具 → agent 注册表的桥（连接后把分级过滤过的 github_* 工具挂进
// 工具注册表；未连接或目录为空时摘除）。
//
// 风险分级的**双保险执行门**：riskGate.js 决定「注册不注册」，本模块在每次
// tools/call 前再查一遍 classifyMcpTool——就算注册表被塞进脏工具，执行也进不去。
// 硬禁止类（删除/强推/管理）没有任何解锁途径：没有开关、没有确认弹框，
// 用户同意也不行（2026-10-05 用户裁决）。
//
// 本模块零静态存储依赖（storage.js 走惰性 require）：静态引用会把 expo 系
// 原生模块拖进 Node 测试环境（assistant.js 的既有教训）。

import { registerTool, unregisterTool, listRegisteredTools } from '../agent/tools/registry.js';
import { classifyMcpTool, MCP_TOOL_TIERS } from '../mcp/riskGate.js';

export const GITHUB_TOOL_PREFIX = 'github_';
// 网络工具比文件工具慢得多（GitHub API 偶发数秒），给独立的长超时。
const MCP_TOOL_TIMEOUT_MS = 45000;
// 工具结果直接进模型上下文：超大输出（整个文件/长列表）截断，防止撑爆上下文。
const MCP_RESULT_CHAR_LIMIT = 16000;

// 注册前置判定（纯函数，与 shellGateReason 同风格）。返回 '' 表示可注册。
export function mcpGateReason(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  if (source.enabled !== true) return 'SWITCH_OFF';
  if (!Array.isArray(source.toolCatalog) || source.toolCatalog.length === 0) return 'NO_CATALOG';
  return '';
}

// 会话复用：同一连接（端点+凭据指纹）在一个运行期里共享一个 MCP 会话，
// 避免每次工具调用都重跑 initialize 握手。404 会话失效由 client 自动重初始化。
let sharedSession = null;
let sharedSessionKey = '';

function acquireSession(settings, { fetchImpl, sessionFactory } = {}) {
  if (typeof sessionFactory === 'function') return sessionFactory(settings, { fetchImpl });
  if (sharedSession && sharedSessionKey === sessionKey(settings)) return sharedSession;
  // 惰性 require：Node 测试环境不起 RN 存储。
  const { createGithubMcpSessionFromSettings } = require('../storage.js');
  sharedSession = createGithubMcpSessionFromSettings(settings, { fetchImpl });
  sharedSessionKey = sessionKey(settings);
  return sharedSession;
}

function sessionKey(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const token = source.authMethod === 'oauth' ? source.githubAccessToken : source.githubToken;
  return `${source.endpoint}::${source.authMethod}::${token ? `len:${token.length}` : 'none'}`;
}

function releaseSession() {
  if (sharedSession && typeof sharedSession.close === 'function') sharedSession.close();
  sharedSession = null;
  sharedSessionKey = '';
}

function textFromMcpResult(result) {
  const parts = Array.isArray(result && result.content) ? result.content : [];
  const text = parts
    .map(part => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    || '（工具无文本输出）';
  if (text.length > MCP_RESULT_CHAR_LIMIT) {
    return `${text.slice(0, MCP_RESULT_CHAR_LIMIT)}\n…（输出过长已截断，原长 ${text.length} 字符；需要更多请缩小查询范围）`;
  }
  return text;
}

// 单次工具调用（执行层门 + 会话 + 结果整形）。
export async function callGithubMcpTool(settings, mcpName, args, hooks = {}) {
  // 硬禁双保险：注册时查过一次，执行前再查一次（不信任注册表状态）。
  if (classifyMcpTool(mcpName) === MCP_TOOL_TIERS.DENIED) {
    return {
      content: `安全策略禁止此操作：${mcpName}（删除/强推/管理类 GitHub 操作永远不可执行，即使用户同意）。`,
      isError: true,
    };
  }
  let session = null;
  try {
    session = await acquireSession(settings, hooks);
    if (!session) {
      return { content: 'GitHub MCP 未连接或缺少凭据，请在设置里重新连接。', isError: true };
    }
    const result = await session.callTool(mcpName, args);
    return { content: textFromMcpResult(result), isError: result && result.isError === true };
  } catch (error) {
    return { content: `GitHub 工具调用失败：${mcpErrorText(error)}`, isError: true };
  }
}

// 注册（幂等）：先摘掉本前缀全部旧工具再按当前目录重挂。
// 返回注册成功的工具名列表（供日志/走查）。
export function registerGithubMcpTools(settings, hooks = {}) {
  unregisterGithubMcpTools();
  if (mcpGateReason(settings)) return [];
  const registered = [];
  for (const tool of Array.isArray(settings.toolCatalog) ? settings.toolCatalog : []) {
    const mcpName = String(tool && tool.name || '').trim();
    if (!mcpName) continue;
    // 目录是连接时落盘的快照，风险分级在这里重查（不信快照）。
    const tier = classifyMcpTool(mcpName);
    if (tier === MCP_TOOL_TIERS.DENIED) continue;
    const toolName = GITHUB_TOOL_PREFIX + mcpName;
    registerTool({
      name: toolName,
      description: `GitHub（MCP）· ${String(tool.description || mcpName)}　[远程仓库操作；${tier === MCP_TOOL_TIERS.READONLY ? '只读' : '每次调用需用户确认'}]`,
      parameters: tool.parameters && typeof tool.parameters === 'object'
        ? tool.parameters
        : { type: 'object', properties: {} },
      readOnly: tier === MCP_TOOL_TIERS.READONLY,
      requiresConfirmation: tier === MCP_TOOL_TIERS.CONFIRM,
      timeoutMs: MCP_TOOL_TIMEOUT_MS,
      execute: (args, ctx) => callGithubMcpTool(settings, mcpName, args, {
        fetchImpl: ctx && ctx.fetchImpl,
        sessionFactory: hooks && hooks.sessionFactory,
      }),
    });
    registered.push(toolName);
  }
  return registered;
}

export function unregisterGithubMcpTools() {
  let removed = 0;
  for (const tool of listRegisteredTools()) {
    if (String(tool.name || '').startsWith(GITHUB_TOOL_PREFIX)) {
      unregisterTool(tool.name);
      removed += 1;
    }
  }
  releaseSession();
  return removed;
}

// 聊天回合的注册入口：读最新连接状态再注册（未连接时等价于全摘除）。
// getSettings 可注入（Node 测试环境没有 require，storage 只能惰性拿）。
export async function ensureGithubMcpToolsRegistered({ getSettings, ...hooks } = {}) {
  if (typeof getSettings === 'function') {
    return registerGithubMcpTools(await getSettings(), hooks);
  }
  // 惰性 require：RN/Metro 下成立（babel CJS 互操作）；Node 原生 ESM 走注入。
  const { getGithubMcpSettings } = require('../storage.js');
  const settings = await getGithubMcpSettings();
  return registerGithubMcpTools(settings, hooks);
}

// data 层错误 code → 给模型看的中文结果（工具结果是模型上下文的一部分，
// 中文与既有工具错误口径一致；设置页的用户文案走 t()，不在这里）。
const MCP_TOOL_ERROR_TEXT = {
  MCP_AUTH_FAILED: 'GitHub 认证失败：令牌无效、过期或权限不足，请在设置里重新连接。',
  MCP_HTTP_ERROR: 'GitHub MCP 请求失败，请稍后重试或缩小查询范围。',
  MCP_INVALID_RESPONSE: 'GitHub MCP 应答异常，请稍后重试。',
  GITHUB_NOT_CONNECTED: 'GitHub MCP 未连接，请在设置里重新连接。',
};

function mcpErrorText(error) {
  return (error && error.code && MCP_TOOL_ERROR_TEXT[error.code]) || (error && error.message) || '未知错误';
}
