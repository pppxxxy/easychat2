// 内置 MCP Server 设置存储域（让 Codex / Claude Code 等外部 agent 连进 App）。
//
// 形状：{ enabled, scope: 'loopback'|'lan', port, mcpToken, tiers: { read, write, exec } }
//
// 密钥：字段名用 **mcpToken** —— secretStore.SECRET_FIELDS 按字段名全局匹配且已登记该名，
// 写盘自动搬进系统安全存储（Keystore），盘上只留引用，读盘回填明文；诊断日志也按登记表脱敏。
// 空串表示「启动时由原生自动生成随机 token 并回显」，照抄 LocalApiServer 的做法——
// 绝不放行匿名请求。
//
// 默认值：**服务器默认关闭**（与 Tavo 一致），范围默认仅本机回环，三个档位默认只开只读。
// 这三条默认值就是安全边界，改动等于放宽默认暴露面，必须写进提交说明。

import { MCP_DEFAULT_TIERS, normalizeMcpTiers } from '../../mcp/serverPolicy.js';
import { createMutationQueue, readJsonWithSecrets, setJsonWithSecrets } from '../io.js';

export const MCP_SERVER_KEY = '@easychat2_mcp_server';
export const MCP_SERVER_SCOPES = Object.freeze(['loopback', 'lan']);
// 默认端口：避开 8080（本地 API 服务默认）与 8686（JS SDK 默认基址），也不占 Tavo 的 7347——
// 同一台手机上两个 App 都开服务器时端口不能撞。
export const MCP_SERVER_PORT_DEFAULT = 8737;
export const MCP_SERVER_PORT_MIN = 1024;
export const MCP_SERVER_PORT_MAX = 65535;

const mcpServerMutation = createMutationQueue();

export function normalizeMcpServerSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const port = Math.trunc(Number(source && source.port));
  const scope = String((source && source.scope) || '').trim();
  return {
    enabled: source ? source.enabled === true : false,
    scope: MCP_SERVER_SCOPES.includes(scope) ? scope : 'loopback',
    port: Number.isFinite(port) && port >= MCP_SERVER_PORT_MIN && port <= MCP_SERVER_PORT_MAX
      ? port
      : MCP_SERVER_PORT_DEFAULT,
    mcpToken: String((source && source.mcpToken) || '').trim(),
    tiers: normalizeMcpTiers(source && source.tiers),
  };
}

export async function getMcpServerSettings() {
  const raw = await readJsonWithSecrets(MCP_SERVER_KEY, null);
  return normalizeMcpServerSettings(raw);
}

export async function saveMcpServerSettings(settings) {
  const normalized = normalizeMcpServerSettings(settings);
  await mcpServerMutation.enqueue(async () => {
    await setJsonWithSecrets(MCP_SERVER_KEY, normalized);
  });
  return normalized;
}

// 局部更新：读现值 → 合并补丁 → 归一化写回。
// 理由同 patchAppearanceSettings：这份设置由多个界面/时机写入（设置页改档位与端口、
// 启动成功时回写原生生成的 token），整体写会让后写的那个把前一个改的字段归一回默认值
// ——最糟的形态是「回写 token 时把 enabled 归回 false」，服务当场变成「开着但配置说关着」。
export async function patchMcpServerSettings(patch) {
  const current = await getMcpServerSettings();
  const merged = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
  const normalized = normalizeMcpServerSettings(merged);
  await mcpServerMutation.enqueue(async () => {
    await setJsonWithSecrets(MCP_SERVER_KEY, normalized);
  });
  return normalized;
}

export { MCP_DEFAULT_TIERS };
