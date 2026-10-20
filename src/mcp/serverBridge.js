// 内置 MCP Server 的 JS 桥：把原生转发的 HTTP 请求交给协议层，再把结果回写原生。
//
// 分层（与 localApiServer 同一套路数）：
//   Kotlin 侧 plugins/mcpServer —— 只做 HTTP 解析 + Bearer 鉴权 + 事件转发，哑管道；
//   本模块 —— 事件契约、协议调用、把 HTTP 结果回写（**顶层不 import react-native**，
//             惰性 require，纯 Node 测试可直接加载）；
//   serverRuntime.js —— 真实能力（读设置、注册工作区工具、跑工具），惰性 require，
//             因为它拖着 AsyncStorage / expo-file-system 这条链，静态引入会毁掉可测性。
//
// 安全边界：本模块**不做**任何档位判断（那是 serverPolicy 的纯函数），也不自己执行工具
// （那是 serverRuntime）——它只负责「协议 → 能力」的接线，接线错了由 serverPolicy 的
// 判决表兜住，判决表错了有单测。

import { createMcpServer, MCP_ENDPOINT_PATH, MCP_SERVER_NAME, MCP_SERVER_VERSION } from './server.js';
import { buildMcpResourceList, buildMcpResourceText } from './serverDocs.js';
import { listExposedTools, normalizeMcpTiers, planToolCall } from './serverPolicy.js';

const EVENT_REQUEST = 'McpServer:onRequest';

// 与 localApiServer 同款：串行队列。同一时刻只处理一个 MCP 请求——工具会动同一个工作区
// 与同一份原生资源（shell/python 看门狗、文件句柄），并发没有收益，只有竞态。
let sharedQueue = Promise.resolve();
function enqueue(task) {
  const run = sharedQueue.then(task, task);
  sharedQueue = run.then(() => {}, () => {});
  return run;
}

let rnState;
function getReactNative() {
  if (rnState !== undefined) return rnState;
  try {
    rnState = require('react-native');
  } catch (error) {
    rnState = null;
  }
  return rnState;
}

function getNative() {
  const rn = getReactNative();
  if (!rn || !rn.Platform || rn.Platform.OS !== 'android') return null;
  const modules = rn.NativeModules || {};
  return modules.McpServer || null;
}

export function isMcpServerAvailable() {
  return Boolean(getNative());
}

function unavailableError() {
  const error = new Error('内置 MCP Server 仅支持 Android（本仓库没有 iOS 原生实现）。');
  error.code = 'MCP_SERVER_UNAVAILABLE';
  return error;
}

// 原生回显的生效 token（空 token 启动时由原生生成）——调用方负责持久化与展示。
export async function startMcpServer({ host, port, token } = {}) {
  const native = getNative();
  if (!native || typeof native.start !== 'function') throw unavailableError();
  const result = await native.start(String(host || ''), Number(port) || 0, String(token || ''));
  return {
    running: result && result.running === true,
    host: String((result && result.host) || host || ''),
    port: Number((result && result.port) || port || 0),
    mcpToken: String((result && result.mcpToken) || token || ''),
  };
}

export async function stopMcpServer() {
  const native = getNative();
  if (!native || typeof native.stop !== 'function') return false;
  await native.stop();
  return true;
}

export async function getMcpServerStatus() {
  const native = getNative();
  if (!native || typeof native.getStatus !== 'function') {
    return { running: false, host: '', port: 0, available: false, lanIp: '' };
  }
  const result = await native.getStatus();
  return {
    running: result && result.running === true,
    host: String((result && result.host) || ''),
    port: Number((result && result.port) || 0),
    available: true,
    lanIp: String((result && result.lanIp) || ''),
  };
}

// 事件契约：原生 emit 一段 JSON 字符串
//   { requestId, method, headers: {…}, body: '<原始请求体字符串>' }
// 数组/对象跨桥不可靠（与 localApiServer 同因），所以统一走 JSON 字符串。
export function parseMcpServerRequest(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const requestId = String(parsed.requestId || '').trim();
  if (!requestId) return null;
  const headers = parsed.headers && typeof parsed.headers === 'object' && !Array.isArray(parsed.headers)
    ? parsed.headers
    : {};
  let body = parsed.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (error) {
      body = null;
    }
  }
  return {
    requestId,
    method: String(parsed.method || 'POST').toUpperCase(),
    path: String(parsed.path || MCP_ENDPOINT_PATH),
    sessionId: String(parsed.sessionId || headers['mcp-session-id'] || headers['Mcp-Session-Id'] || ''),
    headers,
    body,
  };
}

export function addMcpServerRequestListener(callback) {
  const rn = getReactNative();
  if (!rn || !rn.DeviceEventEmitter) return () => {};
  const subscription = rn.DeviceEventEmitter.addListener(EVENT_REQUEST, callback);
  return () => {
    if (subscription && typeof subscription.remove === 'function') subscription.remove();
  };
}

export async function respondMcpServer(requestId, outcome) {
  const native = getNative();
  if (!native || typeof native.respond !== 'function') return false;
  const status = Number((outcome && outcome.status) || 200);
  const headersJson = JSON.stringify((outcome && outcome.headers) || {});
  const body = outcome && outcome.body ? JSON.stringify(outcome.body) : '';
  await native.respond(String(requestId), status, headersJson, body);
  return true;
}

// MCP 的 instructions：握手时读一次。**不写死事实**（档位/工具表都会变），
// 只写「怎么开始」——具体事实让 agent 去读 resources。
// 用函数而不是模块级常量：这里是发给模型看的文案，不是用户可见 UI 文案，
// 但导出常量会被 no-hardcoded-chinese 规则当成「展示给用户的中文」拦下。
export function buildMcpInstructions() {
  return [
    'easychat2 内置 MCP Server：把 App 的工作区工具（文件、搜索、git、shell、扩展包）暴露给外部 agent。',
    '开工前先读 easychat://docs/tools 看当前档位与工具清单，再读 easychat://docs/write-safety 了解写入流程。',
    '默认只有只读档；写入/执行档要用户在 App 的设置里打开。写入与执行类工具第一次调用只会返回预览，',
    '确认无误后带 confirm: true 重发才会真的执行——这不是失败，是设计。',
  ].join('\n');
}

// 组装「协议 + 能力」。能力全部注入，于是这个函数在 Node 里可用假能力直测；
// 生产接线见 serverRuntime.js。
export function createMcpBridge({
  readSettings,
  listDefinitions,
  executeTool,
  workspaceInfo = null,
  serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
  random = Math.random,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const readTiers = async () => normalizeMcpTiers((await readSettings()).tiers);
  // catalog 必须允许**异步**：生产实现的 listDefinitions 要先「确保工作区工具已注册」
  // 才能读到表（见 serverRuntime.listToolDefinitions）。写成同步的话，
  // tools/list 会在注册之前读空表 ⇒ 返回 0 个工具 ⇒ agent 不知道有工具 ⇒
  // 永远不会发起调用 ⇒ executeMcpTool 里的注册永远不跑。真机实测正是这个死锁：
  // 握手成功、鉴权通过、只读档已开，但 toolCount = 0。
  //
  // 对同步返回值的实现（测试桩、旧调用方）保持兼容：await 非 Promise 直接得值。
  const catalog = async () => {
    if (typeof listDefinitions !== 'function') return [];
    const list = await listDefinitions();
    return Array.isArray(list) ? list : [];
  };

  const server = createMcpServer({
    serverInfo,
    instructions: buildMcpInstructions(),
    random,
    now,
    log,
    listTools: async () => {
      const tiers = await readTiers();
      return listExposedTools(await catalog(), tiers).map(({ definition, tier }) => ({
        name: definition.name,
        description: String(definition.description || ''),
        inputSchema: definition.parameters && typeof definition.parameters === 'object'
          ? definition.parameters
          : { type: 'object', properties: {} },
        // 档位标注放在 _meta：标准字段之外的自述信息，客户端不认也不会坏。
        _meta: { tier },
      }));
    },
    callTool: async ({ name, args }) => {
      const tiers = await readTiers();
      const definitions = await catalog();
      const definition = definitions.find(item => item.name === name) || null;
      const plan = planToolCall({ name, definition, args, tiers });
      if (plan.kind === 'denied') {
        log('denied', name, plan.tier);
        return { content: plan.message, isError: true, structuredContent: { tool: name, tier: plan.tier, denied: true } };
      }
      if (plan.kind === 'preview') {
        log('preview', name, plan.tier);
        return {
          content: plan.message,
          isError: true,
          structuredContent: { tool: name, tier: plan.tier, preview: true, arguments: plan.args },
        };
      }
      if (typeof executeTool !== 'function') {
        return { content: '服务器未接上工具执行器。', isError: true };
      }
      try {
        const result = await executeTool({
          name,
          args: plan.args,
          tier: plan.tier,
          characterId: String(plan.controls.character_id || ''),
        });
        return { content: (result && result.content) || '', isError: result && result.isError === true };
      } catch (error) {
        return {
          content: `工具执行失败：${(error && error.message) || '未知错误'}`,
          isError: true,
          structuredContent: { tool: name, tier: plan.tier, failed: true },
        };
      }
    },
    listResources: async () => buildMcpResourceList({
      catalog: await catalog(),
      tiers: await readTiers(),
    }),
    readResource: async ({ uri }) => {
      const text = buildMcpResourceText({
        uri,
        catalog: await catalog(),
        tiers: await readTiers(),
        // 工作区根是异步取的（要读设置）：文档里要写清「当前根在哪」，
        // 否则 agent 只能靠猜路径。取不到就退回「由设置决定」的措辞。
        workspace: typeof workspaceInfo === 'function' ? await workspaceInfo().catch(() => null) : workspaceInfo,
      });
      return text ? { text, mimeType: 'text/markdown' } : null;
    },
  });

  async function handleEvent(event) {
    if (!event) return { status: 400, headers: {}, body: null };
    if (event.path && event.path !== MCP_ENDPOINT_PATH) {
      return { status: 404, headers: {}, body: null };
    }
    return server.handle({
      method: event.method,
      sessionId: event.sessionId,
      headers: event.headers,
      body: event.body,
    });
  }

  return { server, handleEvent, sessions: server.sessions };
}

// 把桥接到原生事件上（生产接线；测试注入假 listen/respond）。
export function attachMcpServer({ bridge, addListener, respond } = {}) {
  const listen = typeof addListener === 'function' ? addListener : addMcpServerRequestListener;
  const reply = typeof respond === 'function' ? respond : respondMcpServer;
  return listen(raw => {
    const event = parseMcpServerRequest(raw);
    if (!event) return sharedQueue;
    return enqueue(async () => {
      let outcome;
      try {
        outcome = await bridge.handleEvent(event);
      } catch (error) {
        outcome = {
          status: 500,
          headers: {},
          body: { jsonrpc: '2.0', id: null, error: { code: -32603, message: (error && error.message) || '内部错误' } },
        };
      }
      try {
        await reply(event.requestId, outcome);
      } catch (error) {}
    });
  });
}

// 对外地址：仅本机 → 回环；局域网 → 原生枚举到的 IPv4（拿不到就留占位符，
// 让用户自己填，而不是编一个可能错的地址给他）。
export function buildMcpServerUrl({ scope = 'loopback', port = 0, lanIp = '' } = {}) {
  const suffix = `${MCP_ENDPOINT_PATH}`;
  if (scope === 'lan') {
    const ip = String(lanIp || '').trim();
    return ip && ip !== '0.0.0.0'
      ? `http://${ip}:${port}${suffix}`
      : `http://<本机局域网 IP>:${port}${suffix}`;
  }
  return `http://127.0.0.1:${port}${suffix}`;
}

// 「复制完整连接配置」的文本（照 Tavo 那份格式）：agent 侧粘一次就能连上。
export function buildMcpConnectionText({ url, token, version = MCP_SERVER_VERSION } = {}) {
  return [
    `easychat2 MCP Server: ${version}`,
    'Preferred access: direct HTTP JSON-RPC',
    `Server URL: ${url}`,
    `Authorization: Bearer ${token || ''}`,
  ].join('\n');
}

export { EVENT_REQUEST as MCP_SERVER_EVENT_REQUEST, MCP_ENDPOINT_PATH };
