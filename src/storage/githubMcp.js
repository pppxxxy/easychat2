// GitHub MCP 连接存储域：认证凭据、连接状态与工具目录持久化在单一键下。
// 从 storage 门面转发；归一化在这里（不引 workspace/settings，两个域解耦）。
//
// 凭据安全：githubToken / githubAccessToken / githubRefreshToken 三个字段名
// 已登记进 secretStore 的 SECRET_FIELDS，经 io 的 setJsonWithSecrets 写盘时
// 自动搬进系统安全存储（Keystore），盘上只留引用；读盘时回填明文。
// 任何日志/报错路径都不得输出这三个字段（token 不进异常消息是 client.js 的约定）。
//
// 工具目录（toolCatalog）：连接成功时 initialize + tools/list 过滤后的**可注册**
// 工具（已过风险分级，见 src/mcp/riskGate.js）。缓存到盘上是为了聊天回合零网络
// 就能注册工具——只有重新连接/手动刷新才重新拉取。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { createMutationQueue, setJsonWithSecrets, readJsonWithSecrets } from './io.js';
import { createMcpSession, DEFAULT_GITHUB_MCP_ENDPOINT } from '../mcp/client.js';
import { filterMcpToolsForRegistration } from '../mcp/riskGate.js';

export const GITHUB_MCP_KEY = '@easychat2_github_mcp';

const GITHUB_MCP_MUTATION = createMutationQueue();

// 错误带稳定 code：设置页按 code 映射 t()（本域零 i18n 依赖，Node 直测）。
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export const GITHUB_AUTH_METHODS = Object.freeze(['pat', 'oauth']);

export function normalizeGithubMcpSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const endpoint = String(source.endpoint || '').trim() || DEFAULT_GITHUB_MCP_ENDPOINT;
  const authMethod = GITHUB_AUTH_METHODS.includes(source.authMethod) ? source.authMethod : 'pat';
  const catalog = Array.isArray(source.toolCatalog)
    ? source.toolCatalog
      .filter(item => item && typeof item === 'object' && String(item.name || '').trim())
      .map(item => ({
        name: String(item.name),
        description: String(item.description || ''),
        parameters: item.parameters && typeof item.parameters === 'object'
          ? item.parameters
          : { type: 'object', properties: {} },
        tier: item.tier === 'confirm' ? 'confirm' : 'readonly',
      }))
    : [];
  return {
    enabled: source.enabled === true,
    endpoint,
    authMethod,
    // 三个密钥字段必须保持字段名不变（SECRET_FIELDS 按名匹配）。
    githubToken: String(source.githubToken || ''),
    githubAccessToken: String(source.githubAccessToken || ''),
    githubRefreshToken: String(source.githubRefreshToken || ''),
    accountLogin: String(source.accountLogin || ''),
    connectedAt: Number(source.connectedAt) > 0 ? Number(source.connectedAt) : 0,
    toolCatalog: catalog,
    deniedNames: Array.isArray(source.deniedNames) ? source.deniedNames.map(String) : [],
  };
}

export async function getGithubMcpSettings() {
  const raw = await readJsonWithSecrets(GITHUB_MCP_KEY, null);
  return normalizeGithubMcpSettings(raw);
}

async function saveGithubMcpSettingsInternal(settings) {
  const normalized = normalizeGithubMcpSettings(settings);
  await setJsonWithSecrets(GITHUB_MCP_KEY, normalized);
  return normalized;
}

// 全部写入走队列串行：连接/断开/刷新目录可能由不同界面并发触发，
// 读-改-写交错会把彼此的更新覆盖掉（与 workspace 域同一教训）。
export async function patchGithubMcpSettings(patch) {
  return GITHUB_MCP_MUTATION.enqueue(async () => {
    const current = await getGithubMcpSettings();
    const merged = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
    return saveGithubMcpSettingsInternal(merged);
  });
}

export async function clearGithubMcpCredentials() {
  return patchGithubMcpSettings({
    enabled: false,
    authMethod: 'pat',
    githubToken: '',
    githubAccessToken: '',
    githubRefreshToken: '',
    accountLogin: '',
    connectedAt: 0,
    toolCatalog: [],
    deniedNames: [],
  });
}

// 供设置域以外的模块读取（agent 注册路径需要 settings + 会话工厂）。
export async function createGithubMcpSessionFromSettings(settings, { fetchImpl } = {}) {
  const resolved = settings && typeof settings === 'object' ? settings : await getGithubMcpSettings();
  if (!resolved.enabled) return null;
  const token = resolved.authMethod === 'oauth' ? resolved.githubAccessToken : resolved.githubToken;
  if (!token) return null;
  return createMcpSession({ endpoint: resolved.endpoint, token, fetchImpl });
}

// 连接验证（PAT 或 OAuth access token 均走这里）：initialize + tools/list，
// 过风险分级后把可注册目录写盘。返回摘要给 UI 展示。
export async function connectGithubMcpWithToken({
  token,
  authMethod = 'pat',
  endpoint = DEFAULT_GITHUB_MCP_ENDPOINT,
  accountLogin = '',
  fetchImpl,
} = {}) {
  const trimmed = String(token || '').trim();
  if (!trimmed) throw fail('GITHUB_TOKEN_EMPTY', 'token is empty');
  if (!/^https:\/\//.test(String(endpoint))) throw fail('GITHUB_ENDPOINT_HTTPS', 'MCP endpoint must be https.');
  let session = null;
  try {
    session = createMcpSession({ endpoint: String(endpoint), token: trimmed, fetchImpl });
    const tools = await session.listTools();
    const { allowed, deniedNames } = filterMcpToolsForRegistration(tools);
    const saved = await patchGithubMcpSettings({
      enabled: true,
      authMethod,
      endpoint: String(endpoint),
      ...(authMethod === 'pat'
        ? { githubToken: trimmed, githubAccessToken: '', githubRefreshToken: '' }
        : { githubAccessToken: trimmed, githubRefreshToken: '', githubToken: '' }),
      accountLogin: String(accountLogin || ''),
      connectedAt: Date.now(),
      toolCatalog: allowed,
      deniedNames,
    });
    return {
      login: saved.accountLogin,
      allowedCount: allowed.length,
      confirmCount: allowed.filter(item => item.tier === 'confirm').length,
      deniedCount: deniedNames.length,
      totalCount: tools.length,
    };
  } finally {
    if (session) session.close();
  }
}

// 用存量凭据重新拉目录（连接失效时 UI 提示重连；这里是「工具目录刷新」入口）。
export async function refreshGithubMcpToolCatalog({ fetchImpl } = {}) {
  const settings = await getGithubMcpSettings();
  const token = settings.authMethod === 'oauth' ? settings.githubAccessToken : settings.githubToken;
  if (!settings.enabled || !token) throw fail('GITHUB_NOT_CONNECTED', 'GitHub MCP is not connected.');
  let session = null;
  try {
    session = createMcpSession({ endpoint: settings.endpoint, token, fetchImpl });
    const tools = await session.listTools();
    const { allowed, deniedNames } = filterMcpToolsForRegistration(tools);
    await patchGithubMcpSettings({ toolCatalog: allowed, deniedNames });
    return { allowedCount: allowed.length, deniedCount: deniedNames.length };
  } finally {
    if (session) session.close();
  }
}

// 兜底导出：测试需要直接清键。
export async function resetGithubMcpStorageForTests() {
  await AsyncStorage.removeItem(GITHUB_MCP_KEY);
}
