// 本地模型设置与路径纯函数，不依赖 RN/Expo，便于单测。

// 模型下载源预设：官方 Hugging Face 与国内镜像 hf-mirror.com。
export const LOCAL_MODEL_DOWNLOAD_SOURCES = [
  {
    id: 'huggingface',
    name: 'Hugging Face',
    baseUrl: 'https://huggingface.co',
    note: '官方源，需国际网络可达。',
  },
  {
    id: 'hf-mirror',
    name: 'HF Mirror（国内镜像）',
    baseUrl: 'https://hf-mirror.com',
    note: '国内直连镜像，地址与官方一致，替换域名即可。',
  },
];

export function buildModelDownloadUrl(baseUrl, repoPath) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const path = String(repoPath || '').trim().replace(/^\/+/, '');
  if (!base || !path) return '';
  return `${base}/${path}`;
}

export const DEFAULT_LOCAL_MODEL_SETTINGS = {
  enabled: false,
  modelId: '',
  modelName: '',
  modelUrl: '',
  modelPath: '',
  modelSha256: '',
  modelBytes: 0,
  contextSize: 2048,
  gpuLayers: 0,
  updatedAt: 0,
};

export function normalizeLocalModelSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bytes = Number(source.modelBytes);
  const contextSize = Number(source.contextSize);
  const gpuLayers = Number(source.gpuLayers);
  return {
    ...DEFAULT_LOCAL_MODEL_SETTINGS,
    enabled: source.enabled === true,
    modelId: String(source.modelId || ''),
    modelName: String(source.modelName || ''),
    modelUrl: String(source.modelUrl || ''),
    modelPath: String(source.modelPath || ''),
    modelSha256: String(source.modelSha256 || ''),
    modelBytes: Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0,
    contextSize: Number.isFinite(contextSize) && contextSize > 0 ? Math.max(512, Math.floor(contextSize)) : 2048,
    gpuLayers: Number.isFinite(gpuLayers) && gpuLayers >= 0 ? Math.floor(gpuLayers) : 0,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : 0,
  };
}

export function localModelPath(modelId, extension = 'gguf') {
  const safeId = String(modelId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${safeId || 'model'}.${extension}`;
}

export function isLocalModelReady(settings, fileInfo = null) {
  const normalized = normalizeLocalModelSettings(settings);
  if (!normalized.enabled || !normalized.modelId || !normalized.modelPath) return false;
  if (fileInfo && fileInfo.exists === false) return false;
  if (fileInfo && Number(normalized.modelBytes) > 0 && Number(fileInfo.size) !== Number(normalized.modelBytes)) return false;
  return true;
}
