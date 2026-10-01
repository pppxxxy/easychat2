// 在线 API / 本地模型路由。在线 API 是默认路径，本地失败只回退一次。

import { isLocalModelModuleAvailable, runLocalModel } from './localModel/adapter.js';
import { isLocalModelReady, normalizeLocalModelSettings } from './localModel/modelState.js';
import { tryAcquireResource } from './resourceMutex.js';

export function canUseLocalModel(settings, fileInfo) {
  return normalizeLocalModelSettings(settings).enabled
    && isLocalModelModuleAvailable()
    && isLocalModelReady(settings, fileInfo);
}

export async function sendWithModelProvider({ messages, localSettings, localFileInfo, onlineSend, onToken, signal }) {
  if (!canUseLocalModel(localSettings, localFileInfo)) {
    return onlineSend();
  }
  const release = tryAcquireResource('local-model');
  if (!release) return onlineSend();
  try {
    const result = await runLocalModel(messages, localSettings, { onToken, signal });
    return result && typeof result.text === 'string' ? result.text : '';
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    return onlineSend();
  } finally {
    release();
  }
}
