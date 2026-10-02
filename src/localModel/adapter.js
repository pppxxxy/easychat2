// 可选 llama.rn 适配器：常驻上下文 + 多模态初始化 + 运行日志。
// 未包含原生模块或模型未就绪时保持在线 API 可用；同一时刻只维护一个已加载上下文。

import { normalizeLocalModelParams } from './modelParams.js';
import { recordModelLog } from './modelLogs.js';

let moduleState;

function getModule() {
  if (moduleState !== undefined) return moduleState;
  try {
    moduleState = require('llama.rn');
  } catch (error) {
    moduleState = null;
  }
  return moduleState;
}

export function isLocalModelModuleAvailable() {
  const module = getModule();
  return Boolean(module && typeof module.initLlama === 'function');
}

let current = null;

function unavailableError() {
  const error = new Error('当前构建未包含本地模型能力');
  error.code = 'LOCAL_MODEL_UNAVAILABLE';
  return error;
}

// 合并顶层旧字段（contextSize/gpuLayers）与条目 params，得到有效参数。
function effectiveParams(model) {
  const source = model && typeof model === 'object' ? model : {};
  return normalizeLocalModelParams({
    contextSize: source.contextSize,
    gpuLayers: source.gpuLayers,
    ...(source.params && typeof source.params === 'object' ? source.params : {}),
  });
}

function modelKey(model) {
  const source = model && typeof model === 'object' ? model : {};
  const params = effectiveParams(source);
  return [
    String(source.modelPath || ''),
    params.contextSize,
    params.gpuLayers,
    String(source.mmprojPath || ''),
  ].join('|');
}

function buildContextParams(model) {
  const params = effectiveParams(model);
  return {
    model: String(model.modelPath || ''),
    use_mlock: true,
    n_ctx: params.contextSize,
    n_gpu_layers: params.gpuLayers,
  };
}

function buildCompletionParams(model, override) {
  const params = normalizeLocalModelParams({
    ...(model && model.params && typeof model.params === 'object' ? model.params : {}),
    ...(override && typeof override === 'object' ? override : {}),
  });
  return {
    n_predict: params.maxTokens,
    temperature: params.temperature,
    top_p: params.topP,
    top_k: params.topK,
    ...(params.threads > 0 ? { n_threads: params.threads } : {}),
  };
}

// 加载常驻上下文：key 命中直接复用；否则先释放旧模型再初始化。
export async function loadLocalModel(model, { onProgress } = {}) {
  const module = getModule();
  if (!module || typeof module.initLlama !== 'function') throw unavailableError();
  const modelPath = String((model && model.modelPath) || '');
  if (!modelPath) {
    const error = new Error('本地模型文件路径为空');
    error.code = 'LOAD_FAILED';
    throw error;
  }
  const key = modelKey(model);
  if (current && current.key === key) return current;
  await unloadLocalModel();

  recordModelLog('load', `开始加载 ${modelPath}`, { context: key });
  let context;
  try {
    context = await module.initLlama(buildContextParams(model), progress => {
      if (typeof onProgress === 'function') onProgress(progress);
    });
  } catch (error) {
    error.code = error.code || 'LOAD_FAILED';
    recordModelLog('load', `加载失败：${error.message}`, { level: 'error', context: key });
    throw error;
  }

  let support = { vision: false, audio: false };
  const mmprojPath = String((model && model.mmprojPath) || '');
  if (mmprojPath && typeof context.initMultimodal === 'function') {
    try {
      await context.initMultimodal({ path: mmprojPath, use_gpu: false });
      if (typeof context.getMultimodalSupport === 'function') {
        const info = await context.getMultimodalSupport();
        support = { vision: info && info.vision === true, audio: info && info.audio === true };
      }
    } catch (error) {
      recordModelLog('load', `多模态初始化失败：${error.message}`, { level: 'warn', context: key });
    }
  }

  current = { key, context, support };
  recordModelLog('load', '模型加载完成', { context: key });
  return current;
}

export async function unloadLocalModel() {
  if (!current) return;
  const { context, key } = current;
  current = null;
  try {
    if (context && typeof context.releaseMultimodal === 'function') await context.releaseMultimodal();
  } catch (error) {}
  try {
    if (context && typeof context.release === 'function') await context.release();
    else {
      const module = getModule();
      if (module && typeof module.releaseAllLlama === 'function') await module.releaseAllLlama();
    }
  } catch (error) {}
  recordModelLog('unload', '模型已释放', { context: key });
}

export function getLoadedLocalModelKey() {
  return current ? current.key : '';
}

export function getLoadedLocalModelSupport() {
  return current ? { ...current.support } : { vision: false, audio: false };
}

function abortError() {
  const error = new Error('本地模型请求已取消');
  error.name = 'AbortError';
  return error;
}

export async function runLocalModel(messages, model, { onToken, signal, params } = {}) {
  if (signal && signal.aborted) throw abortError();
  const loaded = await loadLocalModel(model);
  // 加载耗时较长：期间用户可能已取消，进入生成前必须复查，否则会白跑一整轮。
  if (signal && signal.aborted) throw abortError();
  const completionParams = {
    messages: Array.isArray(messages) ? messages : [],
    ...buildCompletionParams(model, params),
  };

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try {
      if (loaded.context && typeof loaded.context.stopCompletion === 'function') {
        loaded.context.stopCompletion().catch(() => {});
      }
    } catch (error) {}
  };
  if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort);

  const startedAt = Date.now();
  try {
    let fullText = '';
    const result = await loaded.context.completion(completionParams, data => {
      if (data && data.token) {
        fullText += data.token;
        if (typeof onToken === 'function') onToken(fullText);
      }
    });
    if (aborted) throw abortError();
    const text = result && typeof result.text === 'string' ? result.text : fullText;
    recordModelLog('chat', `推理完成（${text.length} 字，${Date.now() - startedAt}ms）`);
    return { ...result, text };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      recordModelLog('chat', '推理已取消', { level: 'info', context: String(model && model.modelPath || '') });
      throw error;
    }
    error.code = error.code || (aborted ? 'ABORTED' : 'INFERENCE_FAILED');
    recordModelLog('chat', `推理失败：${error.message}`, { level: 'error', context: String(model && model.modelPath || '') });
    throw error;
  } finally {
    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
  }
}
