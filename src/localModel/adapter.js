// 可选 llama.rn 适配器。未包含原生模块或模型未就绪时保持在线 API 可用。

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

export async function runLocalModel(messages, settings, { onToken, signal } = {}) {
  const module = getModule();
  if (!module || typeof module.initLlama !== 'function') {
    const error = new Error('当前构建未包含本地模型能力');
    error.code = 'LOCAL_MODEL_UNAVAILABLE';
    throw error;
  }
  if (signal?.aborted) {
    const error = new Error('本地模型请求已取消');
    error.name = 'AbortError';
    throw error;
  }
  const context = await module.initLlama({
    model: String(settings.modelPath || ''),
    use_mlock: true,
    n_ctx: Number(settings.contextSize) || 2048,
    n_gpu_layers: Number(settings.gpuLayers) || 0,
  });
  try {
    let fullText = '';
    const result = await context.completion({ messages, n_predict: 512 }, data => {
      if (data && data.token) {
        fullText += data.token;
        if (typeof onToken === 'function') onToken(fullText);
      }
    });
    return { ...result, text: result && typeof result.text === 'string' ? result.text : fullText };
  } finally {
    if (typeof context.release === 'function') await context.release();
    else if (typeof module.releaseAllLlama === 'function') await module.releaseAllLlama();
  }
}
