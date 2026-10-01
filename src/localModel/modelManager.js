// 本地模型元数据与文件生命周期。原生模型只接收 documentDirectory 下的本地路径。

import * as FileSystem from 'expo-file-system/legacy';
import {
  DEFAULT_LOCAL_MODEL_SETTINGS,
  localModelPath as safeLocalModelPath,
  normalizeLocalModelSettings,
} from './modelState.js';

export const LOCAL_MODEL_SETTINGS_KEY = '@easychat2_local_model';
export const LOCAL_MODEL_DIRECTORY = 'local-models';
export const LOCAL_MODEL_SETTINGS_VERSION = 1;


export function localModelDirectory() {
  return `${FileSystem.documentDirectory || FileSystem.cacheDirectory || ''}${LOCAL_MODEL_DIRECTORY}/`;
}

export function localModelPath(modelId, extension = 'gguf') {
  return `${localModelDirectory()}${safeLocalModelPath(modelId, extension)}`;
}

export async function getLocalModelFileInfo(settings) {
  const normalized = normalizeLocalModelSettings(settings);
  if (!normalized.modelPath) return { exists: false };
  return FileSystem.getInfoAsync(normalized.modelPath);
}

export async function downloadLocalModel({ modelId, modelName, modelUrl, modelSha256 = '', onProgress } = {}) {
  const id = String(modelId || '').trim();
  const url = String(modelUrl || '').trim();
  if (!id || !/^https?:\/\//i.test(url)) throw new Error('请填写有效的模型地址与模型 id');
  const destination = localModelPath(id);
  const temporary = `${destination}.download`;
  await FileSystem.makeDirectoryAsync(localModelDirectory(), { intermediates: true });
  await FileSystem.deleteAsync(temporary, { idempotent: true });
  const task = FileSystem.createDownloadResumable(url, temporary, {}, progress => {
    if (typeof onProgress !== 'function') return;
    const total = Number(progress.totalBytesExpectedToWrite);
    const written = Number(progress.totalBytesWritten);
    onProgress(total > 0 ? Math.min(1, written / total) : 0);
  });
  const result = await task.downloadAsync();
  if (!result || !result.uri) throw new Error('模型下载失败');
  const info = await FileSystem.getInfoAsync(result.uri);
  if (!info.exists || Number(info.size) <= 0) throw new Error('模型文件为空');
  await FileSystem.deleteAsync(destination, { idempotent: true });
  await FileSystem.moveAsync({ from: result.uri, to: destination });
  return {
    enabled: false,
    modelId: id,
    modelName: String(modelName || id),
    modelUrl: url,
    modelPath: destination,
    modelSha256: String(modelSha256 || ''),
    modelBytes: Number(info.size) || 0,
    contextSize: 2048,
    gpuLayers: 0,
    updatedAt: Date.now(),
  };
}

export async function deleteLocalModelFile(settings) {
  const normalized = normalizeLocalModelSettings(settings);
  if (normalized.modelPath) {
    await FileSystem.deleteAsync(normalized.modelPath, { idempotent: true });
  }
  return { ...DEFAULT_LOCAL_MODEL_SETTINGS };
}
