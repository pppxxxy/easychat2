// 本地模型运行时状态（v5 Stage A）：模块级单例 + 订阅广播。
//
// 动机：加载进度此前只接到面板内的数据 hook——从聊天发起第一条消息触发加载时，
// 用户看到的是无反馈的等待；内存占用、失败回退也都不为聊天层所知。这里把「引擎
// 状态」抽成一个可订阅的单一来源，adapter 在 load/unload 的**入口与出口**发事件，
// 推理/裁剪/think 流路径本身一行不动。
//
// 状态机：idle → loading(progress) → ready(modelId, ramEstimate, support) → error
//         （error 后可再次 loading；unload 回到 idle）
//
// 纯模块单例（无 RN/Expo 依赖），可直接 Node 测试。

let state = { status: 'idle', progress: 0, modelId: '', ramEstimate: 0, support: { vision: false, audio: false }, error: '' };
const listeners = new Set();

function emit() {
  const snapshot = getRuntimeState();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {}
  }
}

export function getRuntimeState() {
  return { ...state, support: { ...state.support } };
}

export function subscribeRuntime(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setRuntimeLoading(modelId = '', progress = 0) {
  state = {
    status: 'loading',
    progress: Math.max(0, Math.min(100, Math.round(Number(progress) || 0))),
    modelId: String(modelId || ''),
    ramEstimate: 0,
    support: { vision: false, audio: false },
    error: '',
  };
  emit();
}

export function setRuntimeProgress(progress) {
  if (state.status !== 'loading') return;
  state = { ...state, progress: Math.max(0, Math.min(100, Math.round(Number(progress) || 0))) };
  emit();
}

export function setRuntimeReady({ modelId = '', ramEstimate = 0, support } = {}) {
  state = {
    status: 'ready',
    progress: 100,
    modelId: String(modelId || ''),
    ramEstimate: Number(ramEstimate) > 0 ? Number(ramEstimate) : 0,
    support: {
      vision: Boolean(support && support.vision),
      audio: Boolean(support && support.audio),
    },
    error: '',
  };
  emit();
}

export function setRuntimeError(error, modelId = '') {
  state = {
    status: 'error',
    progress: 0,
    modelId: String(modelId || state.modelId || ''),
    ramEstimate: 0,
    support: { vision: false, audio: false },
    error: String((error && error.message) || error || ''),
  };
  emit();
}

export function setRuntimeIdle() {
  state = { status: 'idle', progress: 0, modelId: '', ramEstimate: 0, support: { vision: false, audio: false }, error: '' };
  emit();
}

// 仅测试用：清空订阅者与状态。
export function __resetRuntimeForTests() {
  listeners.clear();
  state = { status: 'idle', progress: 0, modelId: '', ramEstimate: 0, support: { vision: false, audio: false }, error: '' };
}
