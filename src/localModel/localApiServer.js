// 本地 OpenAI 兼容服务的 JS 桥：启停、状态、请求监听与回写。
// 原生模块由 plugins/withLocalApiServer.js 在 prebuild 时注入 android/ 工程。
// 顶层不 import react-native（惰性 require），保证纯 Node 测试可直接加载纯函数。

import { normalizeLocalModelApiServer } from './modelState.js';
import { recordModelLog } from './modelLogs.js';

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
  const error = new Error('当前环境不支持本地 API 服务（仅 Android 原生构建可用）');
  error.code = 'LOCAL_API_UNAVAILABLE';
  return error;
}

// 启动服务：host 固定回环，端口/apiKey 规范化后交给原生。
export async function startLocalApiServer({ port, apiKey, modelId } = {}) {
  const native = getNative();
  if (!native || typeof native.start !== 'function') throw unavailableError();
  const normalized = normalizeLocalModelApiServer({ enabled: true, port, apiKey });
  const result = await native.start(
    normalized.host,
    normalized.port,
    normalized.apiKey || '',
    String(modelId || 'local-model')
  );
  recordModelLog('api', `本地 API 服务已启动 127.0.0.1:${normalized.port}`);
  return result;
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
export function attachLocalApiServerInference({ model, runInference, addListener, respond } = {}) {
  if (typeof runInference !== 'function') return () => {};
  const listen = typeof addListener === 'function' ? addListener : addLocalApiServerRequestListener;
  const reply = typeof respond === 'function' ? respond : respondLocalApiServer;
  const modelId = String((model && model.id) || 'local-model');
  return listen(async event => {
    try {
      const messages = Array.isArray(event.body && event.body.messages) ? event.body.messages : [];
      const text = await runInference(messages, model);
      await reply(event.requestId, { text: typeof text === 'string' ? text : '', model: modelId });
    } catch (error) {
      recordModelLog('api', `本地 API 推理失败：${error.message}`, { level: 'error' });
      await reply(event.requestId, { text: '', model: modelId });
    }
  });
}
