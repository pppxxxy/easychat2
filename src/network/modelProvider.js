// 在线 API / 本地模型路由。在线 API 是默认路径，本地失败只回退一次。

import { recordDiagnostic } from '../storage/diagnostics.js';
import { isLocalModelModuleAvailable, runLocalModel } from '../localModel/adapter.js';
import { classifyLocalModelError, recordModelLog } from '../localModel/modelLogs.js';
import { isLocalModelItemReady, normalizeLocalModelSettings } from '../localModel/modelState.js';
import { setRuntimeFallback } from '../localModel/runtime.js';
import { tryAcquireResource } from '../resourceMutex.js';

// 就绪判定（纯函数，便于单测）：v5 Stage A 起只认活动条目（单一事实源），
// 不再回退旧单模型设置。moduleAvailable 为假或未启用时分级返回原因。
export function resolveLocalModelReadiness({ settings, item = null, fileInfo = null, moduleAvailable = false } = {}) {
  const normalized = normalizeLocalModelSettings(settings);
  if (!moduleAvailable) return { ready: false, reason: 'unavailable' };
  if (!normalized.enabled) return { ready: false, reason: 'disabled' };
  const ready = isLocalModelItemReady(item, fileInfo);
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
  onModelLoadProgress,
  conversationKey,
  signal,
  tools,
  onProviderResolved,
}) {
  // 路由结果通知（可选）：本地成功=local；本地未启用/被占用/推理失败回退在线=api。
  // 调用方（聊天发送链）据此给会话落 modelKind/modelName 标识——本地与云端的对话
  // 此前在会话列表里无法区分。注意本地→在线是静默回退，「本地模型」不能按设置推断，
  // 只能按「哪条链路真正产出了回复」标记。
  const notify = typeof onProviderResolved === 'function' ? onProviderResolved : null;
  const notifyApi = () => { if (notify) notify({ kind: 'api' }); };
  if (!canUseLocalModel(localSettings, localFileInfo, localItem)) {
    notifyApi();
    return onlineSend();
  }
  const release = tryAcquireResource('local-model');
  if (!release) {
    recordModelLog('api', '本地模型资源被占用，回退在线 API', { level: 'warn' });
    notifyApi();
    return onlineSend();
  }
  const model = localItem;
  try {
    // v1 本地模型不支持工具调用：请求了工具时降级为纯对话并留日志，不静默吞掉。
    if (Array.isArray(tools) && tools.length > 0) {
      recordModelLog('api', '本地模型暂不支持工具调用，已降级为纯对话', { level: 'warn' });
    }
    const result = await runLocalModel(messages, model, { onToken, onReasoning, onModelLoadProgress, conversationKey, signal });
    if (notify) {
      notify({
        kind: 'local',
        modelName: String((model && (model.name || model.modelName)) || '').trim(),
      });
    }
    return result && typeof result.text === 'string' ? result.text : '';
  } catch (error) {
    // 用统一分类判定取消：adapter 在 signal 已中止但异常 name 不是 AbortError 时
    // 会把 error.code 置为 'ABORTED'，只认 name 会漏判并多做一次在线回退。
    const info = classifyLocalModelError(error);
    if (info.code === 'ABORTED') throw error;
    recordModelLog('api', `本地推理失败，回退在线 API：${info.message}`, { level: info.level });
    recordDiagnostic('api', error, 'local-model-fallback');
    // 广播回退事件：聊天层引擎状态条据此展示 10 秒警告，用户才知道这条回复来自在线。
    setRuntimeFallback();
    notifyApi();
    return onlineSend();
  } finally {
    release();
  }
}
