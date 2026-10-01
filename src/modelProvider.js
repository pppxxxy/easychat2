// 在线 API / 本地模型路由。在线 API 是默认路径，本地失败只回退一次。

import { recordDiagnostic } from './diagnostics.js';
import { isLocalModelModuleAvailable, runLocalModel } from './localModel/adapter.js';
import { classifyLocalModelError, recordModelLog } from './localModel/modelLogs.js';
import { isLocalModelItemReady, isLocalModelReady, normalizeLocalModelSettings } from './localModel/modelState.js';
import { tryAcquireResource } from './resourceMutex.js';

// 就绪判定（纯函数，便于单测）：优先按活动条目，其次回退旧单模型设置。
export function resolveLocalModelReadiness({ settings, item = null, fileInfo = null, moduleAvailable = false } = {}) {
  const normalized = normalizeLocalModelSettings(settings);
  if (!moduleAvailable) return { ready: false, reason: 'unavailable' };
  if (!normalized.enabled) return { ready: false, reason: 'disabled' };
  const ready = item ? isLocalModelItemReady(item, fileInfo) : isLocalModelReady(settings, fileInfo);
  return ready ? { ready: true, reason: '' } : { ready: false, reason: 'not-ready' };
}

export function canUseLocalModel(settings, fileInfo, item) {
  return resolveLocalModelReadiness({
    settings,
    item,
    fileInfo,
    moduleAvailable: isLocalModelModuleAvailable(),
  }).ready;
}

export async function sendWithModelProvider({ messages, localSettings, localItem, localFileInfo, onlineSend, onToken, signal }) {
  if (!canUseLocalModel(localSettings, localFileInfo, localItem)) {
    return onlineSend();
  }
  const release = tryAcquireResource('local-model');
  if (!release) {
    recordModelLog('api', '本地模型资源被占用，回退在线 API', { level: 'warn' });
    return onlineSend();
  }
  const model = localItem || localSettings;
  try {
    const result = await runLocalModel(messages, model, { onToken, signal });
    return result && typeof result.text === 'string' ? result.text : '';
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    const info = classifyLocalModelError(error);
    recordModelLog('api', `本地推理失败，回退在线 API：${info.message}`, { level: info.level });
    recordDiagnostic('api', error, 'local-model-fallback');
    return onlineSend();
  } finally {
    release();
  }
}
