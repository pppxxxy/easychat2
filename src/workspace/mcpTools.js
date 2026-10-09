// MCP 工具 → agent 注册表的桥（通用多服务器，2026-10-09 spec: agent-extensibility T1）。
//
// 兼容层：内置 GitHub 保持 `github_` 前缀与全部旧导出（registerGithubMcpTools /
// callGithubMcpTool / ensureGithubMcpToolsRegistered / unregisterGithubMcpTools），
// 已配 token 的用户与既有测试零感知；第三方服务器用 `<id>__<tool>` 命名空间隔离。
//
// 风险分级的**双保险执行门**：riskGate.js 决定「注册不注册」，本模块在每次
// tools/call 前按同一套规则再查一遍——就算注册表被塞进脏工具，执行也进不去。
// 硬禁止类（删除/强推/管理）跨服务器全局无解锁途径：没有开关、没有确认弹框，
// 用户同意也不行（2026-10-05 用户裁决）。
//
// 本模块零静态存储依赖（storage 走惰性 require）：静态引用会把 expo 系原生模块
// 拖进 Node 测试环境（assistant.js 的既有教训）。mcp/client.js 是纯 JS，可静态引。

import { registerTool, unregisterTool, listRegisteredTools } from '../agent/tools/registry.js';
import { createMcpSession } from '../mcp/client.js';
import { GITHUB_SERVER_ID, GITHUB_TOOL_PREFIX } from '../mcp/constants.js';
import { classifyMcpTool, MCP_TOOL_TIERS } from '../mcp/riskGate.js';

// 常量抽到 mcp/constants.js（零依赖，与 mcpServers / client 共用一份——
// 原先「两处各定义一份、靠注释同步」的隐患就此消除）；re-export 兼容既有引用点。
export { GITHUB_TOOL_PREFIX };
// 网络工具比文件工具慢得多（GitHub API 偶发数秒），给独立的长超时。
const MCP_TOOL_TIMEOUT_MS = 45000;
// 工具结果直接进模型上下文：超大输出（整个文件/长列表）截断，防止撑爆上下文。
const MCP_RESULT_CHAR_LIMIT = 16000;
// 第三方命名空间形态：`<slug>__`。用于全量摘除时识别（比 includes('__') 精确，
// 不会误伤其它域恰好带双下划线的工具名）。
const MCP_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]*__/;

// 工具名前缀：内置 github 保持 `github_`（兼容既有工具名与用户配置）；
// 第三方服务器 `<id>__`（命名空间隔离，两台同名工具不打架）。
export function mcpToolPrefix(server) {
  const id = String((server && server.id) || '').trim();
  if (!id) return '';
  return id === GITHUB_SERVER_ID ? GITHUB_TOOL_PREFIX : `${id}__`;
}

// 注册前置判定（纯函数，与 shellGateReason 同风格）。返回 '' 表示可注册。
// 对服务器记录同样适用：enabled + toolCatalog 非空。
export function mcpGateReason(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  if (source.enabled !== true) return 'SWITCH_OFF';
  if (!Array.isArray(source.toolCatalog) || source.toolCatalog.length === 0) return 'NO_CATALOG';
  return '';
}

// 会话复用：按服务器 id 各持一份（端点+凭据指纹为键），避免每次工具调用都重跑
// initialize 握手。404 会话失效由 client 自动重初始化。
const mcpSessions = new Map();

function serverSessionKey(server) {
  const token = String((server && server.mcpToken) || '');
  return `${(server && server.endpoint) || ''}::${(server && server.authMethod) || ''}::${token ? `len:${token.length}` : 'none'}`;
}

function acquireServerSession(server, { fetchImpl, sessionFactory } = {}) {
  if (typeof sessionFactory === 'function') return sessionFactory(server, { fetchImpl });
  // **token 不是会话的前置条件**（2026-10-09 修，审查报告 BUG-1）：
  // client 层是「有 token 才加 Authorization 头」（client.js `if (token)`），空 token 合法
  // ——本地自建 / 无鉴权的 MCP 服务器正是靠这条通路。此前这里要求 mcpToken 非空，后果是
  // 「添加成功 → 连接测试通过 → 目录落盘 → 工具注册成功 → 每次调用都报未连接」，
  // 而且文案把用户指去「重新连接」——重连也修不好。只要求 endpoint。
  //
  // 内置 GitHub 不受影响：它的记录由 githubServerFromSettings 合成，无凭据时整个记录
  // 都不存在（返回 null），轮不到这里判断。
  if (!server || !server.endpoint) return null;
  const id = String(server.id || '');
  const key = serverSessionKey(server);
  const cached = mcpSessions.get(id);
  if (cached && cached.key === key) return cached.session;
  if (cached && cached.session && typeof cached.session.close === 'function') cached.session.close();
  const session = createMcpSession({
    endpoint: server.endpoint,
    token: server.mcpToken,
    headers: server.headers,
    fetchImpl,
  });
  mcpSessions.set(id, { key, session });
  return session;
}

function releaseServerSession(id) {
  const key = String(id || '');
  const cached = mcpSessions.get(key);
  if (cached && cached.session && typeof cached.session.close === 'function') cached.session.close();
  mcpSessions.delete(key);
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
export async function callMcpTool(server, mcpName, args, hooks = {}) {
  const source = server && typeof server === 'object' ? server : null;
  const label = (source && (source.name || source.id)) || 'MCP';
  // 硬禁 + 分级双保险：注册时查过一次，执行前按同一套规则再查一次（不信任注册表状态）。
  const tier = classifyMcpTool(mcpName, {
    serverId: source ? source.id : GITHUB_SERVER_ID,
    tierOverrides: source ? source.tierOverrides : null,
  });
  if (tier === MCP_TOOL_TIERS.DENIED) {
    return {
      content: `安全策略禁止此操作：${mcpName}（删除/强推/管理类操作永远不可执行，即使用户同意）。`,
      isError: true,
    };
  }
  try {
    const session = await acquireServerSession(source, hooks);
    if (!session) {
      return { content: `${label} 未连接或缺少凭据，请在设置里重新连接。`, isError: true };
    }
    const result = await session.callTool(mcpName, args);
    return { content: textFromMcpResult(result), isError: result && result.isError === true };
  } catch (error) {
    return { content: `${label} 工具调用失败：${mcpErrorText(error)}`, isError: true };
  }
}

// 注册（幂等）：先摘掉本服务器前缀的全部旧工具，再按当前目录重挂。
// 返回注册成功的工具名列表（供日志/走查）。
export function registerMcpServerTools(server, hooks = {}) {
  const source = server && typeof server === 'object' ? server : null;
  const prefix = mcpToolPrefix(source);
  if (!prefix) return [];
  unregisterMcpServerTools(source);
  if (mcpGateReason(source)) return [];
  const label = source.name || source.id;
  const registered = [];
  for (const tool of Array.isArray(source.toolCatalog) ? source.toolCatalog : []) {
    const mcpName = String((tool && tool.name) || '').trim();
    if (!mcpName) continue;
    // 目录是连接时落盘的快照，风险分级在这里重查（不信快照）。
    const tier = classifyMcpTool(mcpName, { serverId: source.id, tierOverrides: source.tierOverrides });
    if (tier === MCP_TOOL_TIERS.DENIED) continue;
    const toolName = prefix + mcpName;
    registerTool({
      name: toolName,
      description: `${label}（MCP）· ${String(tool.description || mcpName)}　[远程工具；${tier === MCP_TOOL_TIERS.READONLY ? '只读' : '每次调用需用户确认'}]`,
      parameters: tool.parameters && typeof tool.parameters === 'object'
        ? tool.parameters
        : { type: 'object', properties: {} },
      readOnly: tier === MCP_TOOL_TIERS.READONLY,
      requiresConfirmation: tier === MCP_TOOL_TIERS.CONFIRM,
      timeoutMs: MCP_TOOL_TIMEOUT_MS,
      execute: (args, ctx) => callMcpTool(source, mcpName, args, {
        fetchImpl: ctx && ctx.fetchImpl,
        sessionFactory: hooks && hooks.sessionFactory,
      }),
    });
    registered.push(toolName);
  }
  return registered;
}

export function unregisterMcpServerTools(server) {
  const prefix = mcpToolPrefix(server);
  if (!prefix) return 0;
  let removed = 0;
  for (const tool of listRegisteredTools()) {
    if (String(tool.name || '').startsWith(prefix)) {
      unregisterTool(tool.name);
      removed += 1;
    }
  }
  releaseServerSession(server && server.id);
  return removed;
}

// 注册全部启用服务器（聊天回合入口）：先全摘（防禁用/删除的服务器残留），再逐台注册。
export function registerAllMcpTools(servers, hooks = {}) {
  unregisterAllMcpTools();
  const list = Array.isArray(servers) ? servers : [];
  const registered = [];
  for (const server of list) {
    if (!server || server.enabled !== true) continue;
    registered.push(...registerMcpServerTools(server, hooks));
  }
  return registered;
}

export function unregisterAllMcpTools() {
  let removed = 0;
  for (const tool of listRegisteredTools()) {
    const name = String(tool.name || '');
    if (name.startsWith(GITHUB_TOOL_PREFIX) || MCP_NAMESPACE_PATTERN.test(name)) {
      unregisterTool(name);
      removed += 1;
    }
  }
  mcpSessions.forEach(entry => {
    if (entry.session && typeof entry.session.close === 'function') entry.session.close();
  });
  mcpSessions.clear();
  return removed;
}

// 聊天回合的注册入口：读最新服务器列表再注册（未启用/空目录等价于全摘除）。
// getServers 可注入（Node 测试环境没有 RN 存储，只能惰性拿）。
export async function ensureMcpToolsRegistered({ getServers, ...hooks } = {}) {
  const load = typeof getServers === 'function'
    ? getServers
    : () => require('../storage/settings/mcpServers.js').getMcpServers();
  let servers = [];
  try {
    servers = await load();
  } catch (error) {
    servers = [];
  }
  return registerAllMcpTools(servers, hooks);
}

// ---------- GitHub 兼容层（既有调用点与测试零感知） ----------

// 旧 GitHub 设置形状 → 通用服务器记录（轻量内联映射，不引 storage 的归一化）。
export function githubServerFromSettings(settings) {
  const source = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const token = source.authMethod === 'oauth' ? source.githubAccessToken : source.githubToken;
  if (!String(token || '').trim()) return null;
  return {
    id: GITHUB_SERVER_ID,
    name: 'GitHub',
    endpoint: String(source.endpoint || ''),
    authMethod: source.authMethod === 'oauth' ? 'oauth' : 'token',
    mcpToken: String(token),
    headers: {},
    enabled: source.enabled === true,
    toolCatalog: Array.isArray(source.toolCatalog) ? source.toolCatalog : [],
    deniedNames: Array.isArray(source.deniedNames) ? source.deniedNames : [],
    tierOverrides: {},
  };
}

export function registerGithubMcpTools(settings, hooks = {}) {
  const server = githubServerFromSettings(settings);
  if (!server) {
    unregisterGithubMcpTools();
    return [];
  }
  return registerMcpServerTools(server, hooks);
}

export function unregisterGithubMcpTools() {
  return unregisterMcpServerTools({ id: GITHUB_SERVER_ID });
}

export function callGithubMcpTool(settings, mcpName, args, hooks = {}) {
  const server = githubServerFromSettings(settings) || { id: GITHUB_SERVER_ID, name: 'GitHub' };
  return callMcpTool(server, mcpName, args, hooks);
}

export async function ensureGithubMcpToolsRegistered({ getSettings, ...hooks } = {}) {
  if (typeof getSettings === 'function') {
    return registerGithubMcpTools(await getSettings(), hooks);
  }
  // 惰性 require：RN/Metro 下成立（babel CJS 互操作）；Node 原生 ESM 走注入。
  const { getGithubMcpSettings } = require('../storage/githubMcp.js');
  const settings = await getGithubMcpSettings();
  return registerGithubMcpTools(settings, hooks);
}

// data 层错误 code → 给模型看的中文结果（工具结果是模型上下文的一部分，
// 中文与既有工具错误口径一致；设置页的用户文案走 t()，不在这里）。
const MCP_TOOL_ERROR_TEXT = {
  MCP_AUTH_FAILED: '认证失败：令牌无效、过期或权限不足，请在设置里重新连接。',
  MCP_HTTP_ERROR: 'MCP 请求失败，请稍后重试或缩小查询范围。',
  MCP_INVALID_RESPONSE: 'MCP 应答异常，请稍后重试。',
  // client.js 实际会抛的 code 必须全部有中文口径：漏一个，error.message（英文原文）
  // 就会进模型上下文，破坏「工具结果统一中文」的既有约定（审查报告 BUG-3）。
  MCP_TIMEOUT: 'MCP 请求超时（服务端 30 秒无响应）：冷启动的服务端较慢，请重试一次。',
  MCP_NO_FETCH: '当前环境没有可用的网络请求能力，无法访问 MCP 服务端。',
  GITHUB_NOT_CONNECTED: 'MCP 未连接，请在设置里重新连接。',
};

function mcpErrorText(error) {
  return (error && error.code && MCP_TOOL_ERROR_TEXT[error.code]) || (error && error.message) || '未知错误';
}
