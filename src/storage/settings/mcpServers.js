// MCP 服务器列表存储域（通用 MCP，2026-10-09 spec: 2026-10-09-agent-extensibility T1）。
//
// 形状（数组根，io 的密钥保护已支持数组路径）：
//   [{ id, name, endpoint, authMethod: 'token'|'oauth', mcpToken, headers: {},
//      enabled, connectedAt, toolCatalog: [...], deniedNames: [...], tierOverrides: {} }]
//
// 密钥：字段名用 **mcpToken** 而不是通用的 token——secretStore.SECRET_FIELDS 按
// 字段名全局匹配，收 `token` 会波及其它域的同名字段；`mcpToken` 已按名登记，
// 写盘自动搬进系统安全存储（Keystore），盘上只留引用，读盘回填明文。
// 任何日志/报错路径不得输出该字段。
//
// GitHub 兼容：旧键 @easychat2_github_mcp 经 serverFromGithubSettings 映射为
// 内置记录（id='github'），migrateGithubServer 幂等执行；**旧键不动**
// （回滚安全，旧版本仍可跑），新键是唯一事实源。

import { DEFAULT_GITHUB_MCP_ENDPOINT } from '../../mcp/client.js';
import { filterMcpToolsForRegistration } from '../../mcp/riskGate.js';
import { createMutationQueue, readJsonWithSecrets, setJsonWithSecrets } from '../io.js';

export const MCP_SERVERS_KEY = '@easychat2_mcp_servers';
export const GITHUB_SERVER_ID = 'github';
// 保留 id：内置服务器占用的命名空间。第三方服务器的 id 绝不能落在这里——
// 分级是**按 serverId 分域**的（riskGate：内置 GitHub 走只读白名单、第三方默认逐条确认），
// 所以 id 撞车等于把第三方工具偷换成 GitHub 白名单语义：恰好叫 search_code /
// get_file_contents 的第三方工具会被判只读、免确认自动放行（审查报告 BUG-2，P2）。
// 内置 GitHub 记录本身是 githubServerFromSettings **合成**的、不入存储，所以改写只可能
// 命中第三方记录，不会伤到内置那条。
export const RESERVED_MCP_SERVER_IDS = Object.freeze([GITHUB_SERVER_ID]);
export const MCP_AUTH_METHODS = Object.freeze(['token', 'oauth']);
export const MCP_OVERRIDE_TIERS = Object.freeze(['readonly', 'confirm', 'denied']);

const mcpServersMutation = createMutationQueue();

function isReservedServerId(id) {
  return RESERVED_MCP_SERVER_IDS.includes(String(id || '').trim());
}

// slug：工具命名空间用（`<slug>__<tool>`）。小写字母/数字/连字符，空则生成随机尾缀。
// 命中保留字时加**随机**尾缀（建库时只调一次，随机正好用来区分同名服务器）。
export function makeMcpServerId(name) {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (!slug) return `server-${Math.random().toString(36).slice(2, 8)}`;
  if (isReservedServerId(slug)) return `${slug}-${Math.random().toString(36).slice(2, 8)}`;
  return slug;
}

function normalizeHeaders(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    const name = String(key || '').trim();
    if (!name) continue;
    const text = String(value == null ? '' : value).trim();
    if (!text) continue;
    if (text.length > 512) continue;
    out[name] = text;
  }
  return out;
}

function normalizeTierOverrides(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    const name = String(key || '').trim();
    if (!name) continue;
    if (!MCP_OVERRIDE_TIERS.includes(value)) continue;
    out[name] = value;
  }
  return out;
}

function normalizeCatalog(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter(item => item && typeof item === 'object' && String(item.name || '').trim())
    .map(item => ({
      name: String(item.name),
      description: String(item.description || ''),
      parameters: item.parameters && typeof item.parameters === 'object'
        ? item.parameters
        : { type: 'object', properties: {} },
      tier: MCP_OVERRIDE_TIERS.includes(item.tier) ? item.tier : 'confirm',
    }));
}

export function normalizeMcpServer(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = String(source.id || '').trim();
  // id 是命名空间与前缀的依据，缺了就没法注册——直接判废（不做随机补救，
  // 免得每次读盘都换一个前缀，把已注册工具变成幽灵）。
  if (!id) return null;
  // 注意：**单条归一化不做保留字改写**。内置 GitHub 记录的构造器
  // （serverFromGithubSettings）也走这个函数，在这里一刀切会把它的 id 改成
  // github-x —— 白名单语义、github_ 前缀、ALREADY_MIGRATED 判定全废，
  // 那是把内置能力打坏，不是修 bug。改写只放在「第三方列表」那两条路径上
  // （见 toThirdPartyId），列表里本来就不该出现内置记录。
  const authMethod = MCP_AUTH_METHODS.includes(source.authMethod) ? source.authMethod : 'token';
  return {
    id,
    name: String(source.name || id).trim() || id,
    endpoint: String(source.endpoint || '').trim(),
    authMethod,
    mcpToken: String(source.mcpToken || ''),
    headers: normalizeHeaders(source.headers),
    enabled: source.enabled === true,
    connectedAt: Number(source.connectedAt) > 0 ? Number(source.connectedAt) : 0,
    // 内置标记：只有内置 GitHub 记录带它。它授权该记录**保留保留字 id**
    //（见 toThirdPartyId）；第三方服务器的记录永远不带，所以拿不到内置命名空间与分级语义。
    builtin: source.builtin === true,
    toolCatalog: normalizeCatalog(source.toolCatalog),
    deniedNames: (Array.isArray(source.deniedNames) ? source.deniedNames : [])
      .map(name => String(name || '').trim())
      .filter(Boolean),
    tierOverrides: normalizeTierOverrides(source.tierOverrides),
  };
}

// 第三方列表专用：保留字 id 一律改写（**固定**尾缀，不随机）。
// 为什么固定：本函数在每次读盘都会跑（getMcpServers → normalizeMcpServers），
// 随机 id 会让命名空间前缀每次都变、已注册工具全成幽灵——与上面「空 id 判废」
// 同一条理由；唯一性交给下面的同 id 去重。
// 为什么只改没有 builtin 标记的：内置 GitHub 记录**确实会合法地进这个列表**
// （migrateGithubServer 迁移旧设置时写入），它必须保住保留字 id，否则白名单语义、
// github_ 前缀、ALREADY_MIGRATED 判定全废。所以判据不是「在列表里」而是「有没有标记」。
function toThirdPartyId(server) {
  if (!server || server.builtin === true || !isReservedServerId(server.id)) return server;
  return { ...server, id: `${server.id}-x` };
}

// 同 id 去重（保留先出现的），保证命名空间唯一。
export function normalizeMcpServers(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const server = toThirdPartyId(normalizeMcpServer(item));
    if (!server || seen.has(server.id)) continue;
    seen.add(server.id);
    out.push(server);
  }
  return out;
}

export async function getMcpServers() {
  const raw = await readJsonWithSecrets(MCP_SERVERS_KEY, null).catch(() => null);
  return normalizeMcpServers(raw);
}

export function saveMcpServers(list) {
  return mcpServersMutation.enqueue(async () => {
    const normalized = normalizeMcpServers(list);
    await setJsonWithSecrets(MCP_SERVERS_KEY, normalized);
    return normalized;
  });
}

// 纯函数（供 UI/reducer 直用）：按 id 覆盖或追加。
export function upsertMcpServer(list, server) {
  // 写入路径同样过保留字改写：这是「外部传入」的入口（UI 建服务器 / 改服务器），
  // 手改存储或老数据里的 id='github' 会在这里被拉回第三方命名空间。
  const next = toThirdPartyId(normalizeMcpServer(server));
  const current = normalizeMcpServers(list);
  if (!next) return current;
  const index = current.findIndex(item => item.id === next.id);
  if (index === -1) return [...current, next];
  const out = [...current];
  out[index] = next;
  return out;
}

// 纯函数：按 id 删除；返回 [新列表, 是否删掉了]。
export function removeMcpServer(list, id) {
  const target = String(id || '').trim();
  const current = normalizeMcpServers(list);
  const next = current.filter(item => item.id !== target);
  return [next, next.length !== current.length];
}

// 旧 GitHub 设置 → 内置记录（纯函数，可直测）。未连接（无凭据）返回 null。
export function serverFromGithubSettings(settings) {
  const source = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : null;
  if (!source) return null;
  const token = source.authMethod === 'oauth' ? source.githubAccessToken : source.githubToken;
  if (!String(token || '').trim()) return null;
  return normalizeMcpServer({
    id: GITHUB_SERVER_ID,
    name: 'GitHub',
    // 内置标记：授权这条记录保留保留字 id（第三方记录没有它，见 toThirdPartyId）。
    builtin: true,
    endpoint: String(source.endpoint || '').trim() || DEFAULT_GITHUB_MCP_ENDPOINT,
    authMethod: source.authMethod === 'oauth' ? 'oauth' : 'token',
    mcpToken: String(token),
    enabled: source.enabled === true,
    connectedAt: source.connectedAt,
    toolCatalog: source.toolCatalog,
    deniedNames: source.deniedNames,
  });
}

// 幂等迁移：列表里已有 github 记录 / 旧设置无凭据 / 读失败 → 都不动新键。
// 惰性 require githubMcp：Node 测试环境没有它注入的依赖时不至于炸静态引用。
export async function migrateGithubServer({ getGithubSettings } = {}) {
  const load = typeof getGithubSettings === 'function'
    ? getGithubSettings
    : () => require('../githubMcp.js').getGithubMcpSettings();
  let settings = null;
  try {
    settings = await load();
  } catch (error) {
    return { migrated: false, reason: 'READ_FAILED' };
  }
  const legacy = serverFromGithubSettings(settings);
  if (!legacy) return { migrated: false, reason: 'NO_CREDENTIALS' };
  const list = await getMcpServers();
  if (list.some(item => item.id === GITHUB_SERVER_ID)) {
    return { migrated: false, reason: 'ALREADY_MIGRATED' };
  }
  await saveMcpServers([...list, legacy]);
  return { migrated: true, server: legacy };
}

// 连接成功后的服务器记录更新（纯函数，供 hook 直用、Node 直测）：
// 写目录（按服务器分域过滤）+ 连接时间 + 置为启用。tools 为空时也保留记录
// （用户看到「已连接但无可用工具」比静默失败清楚）。
export function applyConnectResult(server, tools) {
  const normalized = normalizeMcpServer(server);
  if (!normalized) return null;
  const { allowed, deniedNames } = filterMcpToolsForRegistration(tools, {
    serverId: normalized.id,
    tierOverrides: normalized.tierOverrides,
  });
  return normalizeMcpServer({
    ...normalized,
    enabled: true,
    connectedAt: Date.now(),
    toolCatalog: allowed,
    deniedNames,
  });
}

// 自定义请求头的 UI 输入格式：每行 `名称: 值`。比 JSON 友好、且能容错
// （空行、无冒号的行、空值一律忽略）。
export function parseHeadersText(text) {
  const out = {};
  String(text == null ? '' : text).split('\n').forEach(line => {
    const index = line.indexOf(':');
    if (index <= 0) return;
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (name && value) out[name] = value;
  });
  return out;
}

// 测试用：直接清键。
export async function resetMcpServersForTests() {
  await setJsonWithSecrets(MCP_SERVERS_KEY, []);
}
