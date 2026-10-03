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

export async function sendWithModelProvider({
  messages,
  localSettings,
  localItem,
  localFileInfo,
  onlineSend,
  onToken,
  onReasoning,
  conversationKey,
  signal,
  tools,
}) {
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
    // v1 本地模型不支持工具调用：请求了工具时降级为纯对话并留日志，不静默吞掉。
    if (Array.isArray(tools) && tools.length > 0) {
      recordModelLog('api', '本地模型暂不支持工具调用，已降级为纯对话', { level: 'warn' });
    }
    const result = await runLocalModel(messages, model, { onToken, onReasoning, conversationKey, signal });
    return result && typeof result.text === 'string' ? result.text : '';
  } catch (error) {
    // 用统一分类判定取消：adapter 在 signal 已中止但异常 name 不是 AbortError 时
    // 会把 error.code 置为 'ABORTED'，只认 name 会漏判并多做一次在线回退。
    const info = classifyLocalModelError(error);
    if (info.code === 'ABORTED') throw error;
    recordModelLog('api', `本地推理失败，回退在线 API：${info.message}`, { level: info.level });
    recordDiagnostic('api', error, 'local-model-fallback');
    return onlineSend();
  } finally {
    release();
  }
}
