// 可选 llama.rn 适配器：常驻上下文 + 多模态初始化 + 运行日志。
// 未包含原生模块或模型未就绪时保持在线 API 可用；同一时刻只维护一个已加载上下文。

import { normalizeLocalModelParams } from './modelParams.js';
import { describeModelError, formatBytes, recordModelLog } from './modelLogs.js';
import { trimMessagesToContext } from './localContext.js';
import { createThinkSplitter, splitThinkContent } from './thinkStream.js';
import { tActive } from '../i18n/index.js';

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
  const error = new Error(tActive('error.localModel.unavailable'));
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

export function buildContextParams(model) {
  const params = effectiveParams(model);
  return {
    model: String(model.modelPath || ''),
    use_mlock: true,
    n_ctx: params.contextSize,
    n_gpu_layers: params.gpuLayers,
  };
}

// 加载日志的可定位上下文：文件体积、上下文长度、GPU 层数、设备内存。
// 这些是「模型能不能跑起来」最关键的几个数字，出错时一眼能看出问题。
function buildLoadContext(model, key) {
  const source = model && typeof model === 'object' ? model : {};
  const params = effectiveParams(source);
  const parts = [];
  const fileSize = Number(source.modelBytes);
  if (Number.isFinite(fileSize) && fileSize > 0) parts.push(`文件=${formatBytes(fileSize)}`);
  parts.push(`上下文=${params.contextSize}`);
  parts.push(`GPU层=${params.gpuLayers}`);
  if (source.mmprojPath) parts.push(`mmproj=${String(source.mmprojPath).split('/').pop()}`);
  const totalMem = getTotalDeviceMemoryBytes();
  if (totalMem > 0) parts.push(`设备内存=${formatBytes(totalMem)}`);
  return `${parts.join(' ')} | ${key}`;
}

let deviceMemoryBytesCache;
function getTotalDeviceMemoryBytes() {
  if (deviceMemoryBytesCache === undefined) {
    try {
      // 惰性 require：避免在没有 expo-device 的纯 Node 测试环境里解析失败。
      const info = require('./deviceMemory.js').getDeviceMemoryInfo();
      deviceMemoryBytesCache = Number(info && info.totalMemoryBytes) || 0;
    } catch (error) {
      deviceMemoryBytesCache = 0;
    }
  }
  return deviceMemoryBytesCache;
}

export function buildCompletionParams(model, override) {
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
    const error = new Error(tActive('error.localModel.pathEmpty'));
    error.code = 'LOAD_FAILED';
    throw error;
  }
  const key = modelKey(model);
  if (current && current.key === key) return current;
  await unloadLocalModel();

  recordModelLog('load', `开始加载 ${modelPath}`, {
    context: buildLoadContext(model, key),
  });
  let context;
  try {
    context = await module.initLlama(buildContextParams(model), progress => {
      if (typeof onProgress === 'function') onProgress(progress);
    });
  } catch (error) {
    error.code = error.code || 'LOAD_FAILED';
    recordModelLog('load', `加载失败：${describeModelError(error)}`, { level: 'error', context: buildLoadContext(model, key) });
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
      recordModelLog('load', `多模态初始化失败：${describeModelError(error)}`, { level: 'warn', context: key });
    }
  }

  current = { key, context, support, conversationKey: '' };
  recordModelLog('load', `模型加载完成${support.vision || support.audio ? `（${[support.vision ? '视觉' : '', support.audio ? '音频' : ''].filter(Boolean).join('+')}）` : ''}`, { context: key });
  return current;
}

export async function unloadLocalModel() {
  if (!current) return;
  const { context, key } = current;
  current = null;
  let releaseFailed = false;
  try {
    if (context && typeof context.releaseMultimodal === 'function') await context.releaseMultimodal();
  } catch (error) {
    releaseFailed = true;
    recordModelLog('unload', `释放多模态失败：${describeModelError(error)}`, { level: 'warn', context: key });
  }
  try {
    if (context && typeof context.release === 'function') await context.release();
    else {
      const module = getModule();
      if (module && typeof module.releaseAllLlama === 'function') await module.releaseAllLlama();
    }
  } catch (error) {
    releaseFailed = true;
    recordModelLog('unload', `释放模型失败：${describeModelError(error)}`, { level: 'warn', context: key });
  }
  // 释放失败时上下文可能泄漏在原生侧，不能记成「已释放」误导排查。
  recordModelLog('unload', releaseFailed ? '模型释放未完全成功' : '模型已释放', { context: key });
}

export function getLoadedLocalModelKey() {
  return current ? current.key : '';
}

// 某个模型是否正是当前常驻上下文（供 UI 显示「已加载」）。
export function isLocalModelLoaded(model) {
  return Boolean(current && current.key === modelKey(model));
}

// 跨对话必须清 KV cache：常驻上下文会沿用上一段对话的缓存，导致新对话
// 「记得」上一段对话的内容（llama.rn clearCache 文档明确要求在对话间调用）。
// 混合架构模型（LFM2 等）的循环状态只能整体清除，部分删除无效。
export async function clearLocalModelCache() {
  if (!current || !current.context) return false;
  if (typeof current.context.clearCache !== 'function') return false;
  try {
    await current.context.clearCache();
    current.conversationKey = '';
    return true;
  } catch (error) {
    recordModelLog('chat', `清空上下文缓存失败：${describeModelError(error)}`, { level: 'warn' });
    return false;
  }
}

export function getLoadedLocalModelSupport() {
  return current ? { ...current.support } : { vision: false, audio: false };
}

function abortError() {
  const error = new Error(tActive('error.localModel.requestCanceled'));
  error.name = 'AbortError';
  return error;
}

export async function runLocalModel(messages, model, { onToken, onReasoning, signal, params, conversationKey, onModelLoadProgress } = {}) {
  if (signal && signal.aborted) throw abortError();
  // 加载进度透传：聊天路径此前完全没有钩子，首条消息的 mmap 加载期间用户只看到「正在思考」。
  const loaded = await loadLocalModel(model, {
    onProgress: typeof onModelLoadProgress === 'function' ? onModelLoadProgress : undefined,
  });
  // 加载耗时较长：期间用户可能已取消，进入生成前必须复查，否则会白跑一整轮。
  if (signal && signal.aborted) throw abortError();

  // 会话切换时清 KV cache：常驻上下文跨对话会残留上一段对话的缓存，导致
  // 新对话的思考/回复「串」进上一段对话的内容。同一对话内保留缓存以复用前缀。
  const nextConversationKey = String(conversationKey || '');
  if (
    nextConversationKey
    && loaded.context
    && typeof loaded.context.clearCache === 'function'
    && loaded.conversationKey !== nextConversationKey
  ) {
    try {
      await loaded.context.clearCache();
      loaded.conversationKey = nextConversationKey;
      recordModelLog('chat', '已切换对话，清空上下文缓存');
    } catch (error) {
      recordModelLog('chat', `清空上下文缓存失败：${describeModelError(error)}`, { level: 'warn' });
    }
  }

  // 清缓存是 await 点：期间用户可能取消。AbortSignal 若已 aborted，之后再
  // addEventListener 不会触发回调，必须在这里复查，否则会白跑一整轮推理。
  if (signal && signal.aborted) throw abortError();

  const completionParams = {
    messages: Array.isArray(messages) ? messages : [],
    ...buildCompletionParams(model, params),
  };

  // 上下文预算：本地模型 n_ctx 是硬上限，全量历史迟早溢出（llama.cpp 静默截断/报错）。
  // 推理前按 contextSize 裁剪，保留 system 与最近若干轮；同时把要生成的最大 token 数
  // 预留下来，避免「提示刚好占满、生成无处可放」。
  const contextBudget = trimMessagesToContext(completionParams.messages, {
    contextSize: effectiveParams(model).contextSize,
    reserveOutputTokens: completionParams.n_predict,
  });
  if (contextBudget.removedCount > 0) {
    recordModelLog(
      'chat',
      `历史超上下文，裁剪 ${contextBudget.removedCount} 条（预算≈${contextBudget.budget} tokens，保留 ${contextBudget.messages.length} 条）`,
      { level: 'warn', context: `contextSize=${effectiveParams(model).contextSize}` }
    );
    completionParams.messages = contextBudget.messages;
  }

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
  const runContext = [
    `消息=${Array.isArray(messages) ? messages.length : 0}`,
    `上下文=${effectiveParams(model).contextSize}`,
    `maxTokens=${completionParams.n_predict}`,
    `temp=${completionParams.temperature}`,
  ].join(' ');
  recordModelLog('chat', '开始推理', { context: runContext });
  try {
    // 本地推理模型把思考过程以内联标签输出（无 reasoning_content 字段），两种形态：
    // ① 输出以 <think> 开头、</think> 结束（R1/QwQ）；② 开标签在聊天模板的生成
    // 前缀里、只见 </think>（Qwen3 系）。这里按流拆分，思考走 onReasoning、
    // 正文走 onToken，避免思考被当正文。
    const splitter = createThinkSplitter();
    const result = await loaded.context.completion(completionParams, data => {
      if (data && data.token) {
        splitter.push(data.token);
        if (typeof onToken === 'function') onToken(splitter.text());
        if (typeof onReasoning === 'function') onReasoning(splitter.reasoning());
      }
    });
    if (aborted) throw abortError();
    const rawText = result && typeof result.text === 'string' ? result.text : splitter.raw();
    const split = splitThinkContent(rawText);
    recordModelLog('chat', `推理完成（${split.text.length} 字${split.reasoning ? `，思考 ${split.reasoning.length} 字` : ''}，${Date.now() - startedAt}ms）`);
    return { ...result, text: split.text, reasoning: split.reasoning };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      recordModelLog('chat', '推理已取消', { level: 'info', context: String(model && model.modelPath || '') });
      throw error;
    }
    error.code = error.code || (aborted ? 'ABORTED' : 'INFERENCE_FAILED');
    recordModelLog('chat', `推理失败：${describeModelError(error)}`, { level: 'error', context: runContext });
    throw error;
  } finally {
    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
  }
}
