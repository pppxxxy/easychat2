// 本地 OpenAI 兼容服务的 JS 桥：启停、状态、请求监听与回写。
// 原生模块由 plugins/withLocalApiServer.js 在 prebuild 时注入 android/ 工程。
// 顶层不 import react-native（惰性 require），保证纯 Node 测试可直接加载纯函数。

import { normalizeLocalModelApiServer } from './modelState.js';
import { describeModelError, recordModelLog } from './modelLogs.js';
import { tActive } from '../i18n/index.js';

const EVENT_REQUEST = 'LocalApiServer:onRequest';

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
  return modules.LocalApiServer || null;
}

export function isLocalApiServerAvailable() {
  return Boolean(getNative());
}

function unavailableError() {
  const error = new Error(tActive('error.localModel.apiServerUnsupported'));
  error.code = 'LOCAL_API_UNAVAILABLE';
  return error;
}

// JS 侧生成稳定的本地 API 密钥：留空启动时生成一次并持久化，重启后不变。
// Math.random 非密码学随机，但密钥仅用于本机回环端点的鉴权展示；原生侧对空密钥
// 还会用 SecureRandom 再生成一道（双保险），此处保证「发给原生的密钥永不为空」，
// 这样旧原生构建（无自动生成）也被一并堵上。
export function generateLocalApiKey() {
  let key = 'local-';
  for (let round = 0; round < 4; round += 1) {
    key += Math.random().toString(36).slice(2, 10);
  }
  return key;
}

// 启动服务：host 固定回环，端口/apiKey 规范化后交给原生。
// apiKey 为空时自动生成稳定密钥（并随结果返回，调用方负责持久化与展示），
// 原生永远收到非空密钥 —— 免鉴权放行已在两端同时移除。
export async function startLocalApiServer({ port, apiKey, modelId } = {}) {
  const native = getNative();
  if (!native || typeof native.start !== 'function') throw unavailableError();
  const normalized = normalizeLocalModelApiServer({ enabled: true, port, apiKey });
  const effectiveApiKey = normalized.apiKey && normalized.apiKey.trim()
    ? normalized.apiKey.trim()
    : generateLocalApiKey();
  const result = await native.start(
    normalized.host,
    normalized.port,
    effectiveApiKey,
    String(modelId || 'local-model')
  );
  recordModelLog('api', `本地 API 服务已启动 127.0.0.1:${normalized.port}${normalized.apiKey ? '' : '（已自动生成随机密钥）'}`);
  return {
    ...result,
    // 优先取原生回显（新构建可能自行生成）；旧构建无该字段时回落 JS 生成的值。
    apiKey: String((result && result.apiKey) || effectiveApiKey),
  };
}

export async function stopLocalApiServer() {
  const native = getNative();
  if (!native || typeof native.stop !== 'function') return true;
  try {
    return await native.stop();
  } finally {
    recordModelLog('api', '本地 API 服务已停止');
  }
}

export async function getLocalApiServerStatus() {
  const native = getNative();
  if (!native || typeof native.getStatus !== 'function') return { running: false, host: '127.0.0.1', port: 0 };
  try {
    return await native.getStatus();
  } catch (error) {
    return { running: false, host: '127.0.0.1', port: 0 };
  }
}

// 解析原生事件：兼容 JSON 字符串 / 对象 / 数组三种编组，统一成 { requestId, path, body }。
export function parseLocalApiServerRequest(raw) {
  let payload = raw;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (error) {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const requestId = String(payload.requestId || '').trim();
  if (!requestId) return null;
  let body = payload.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (error) {
      body = {};
    }
  }
  return {
    requestId,
    path: String(payload.path || ''),
    body: body && typeof body === 'object' && !Array.isArray(body) ? body : {},
  };
}

export function addLocalApiServerRequestListener(callback) {
  const native = getNative();
  const rn = getReactNative();
  if (!native || !rn || typeof rn.NativeEventEmitter !== 'function') return () => {};
  const emitter = new rn.NativeEventEmitter(native);
  const subscription = emitter.addListener(EVENT_REQUEST, raw => {
    const event = parseLocalApiServerRequest(raw);
    if (event && typeof callback === 'function') callback(event);
  });
  return () => subscription.remove();
}

export async function respondLocalApiServer(requestId, response) {
  const native = getNative();
  if (!native || typeof native.respond !== 'function') return false;
  return native.respond(String(requestId || ''), JSON.stringify(response || {}));
}

// 把原生请求接到推理函数：收到请求 -> runInference(messages, model) -> 回写 { text, model }。
// addListener/respond 可注入（便于单测），默认走真实原生桥。
// 串行化：外部 OpenAI 客户端可能并发打本机端点；llama.rn 的常驻 context **非并发安全**
// （两个 completion 同时跑轻则串话、重则原生崩溃）。这里用一条 FIFO promise 链把请求排队，
// 同一时刻只处理一个；跨模块（与聊天推理争用）仍靠 App 侧 tryAcquireResource 兜底。
export function attachLocalApiServerInference({ model, runInference, addListener, respond } = {}) {
  if (typeof runInference !== 'function') return () => {};
  const listen = typeof addListener === 'function' ? addListener : addLocalApiServerRequestListener;
  const reply = typeof respond === 'function' ? respond : respondLocalApiServer;
  const modelId = String((model && model.id) || 'local-model');
  let queue = Promise.resolve();
  const handle = async event => {
    try {
      const messages = Array.isArray(event.body && event.body.messages) ? event.body.messages : [];
      const text = await runInference(messages, model);
      await reply(event.requestId, { text: typeof text === 'string' ? text : '', model: modelId });
    } catch (error) {
      recordModelLog('api', `本地 API 推理失败：${describeModelError(error)}`, { level: 'error' });
      await reply(event.requestId, { text: '', model: modelId });
    }
  };
  return listen(event => {
    queue = queue.then(() => handle(event)).catch(() => {});
    return queue;
  });
}
