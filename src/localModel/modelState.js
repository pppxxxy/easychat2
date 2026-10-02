// 本地模型设置、条目与路径纯函数，不依赖 RN/Expo，便于单测。
// 多模型设计：设置（enabled / activeModelId / apiServer）与每个模型条目分离，
// 条目按 id 拆键存储（见 src/storage/localModels.js），本文件只做规范化与迁移纯逻辑。

import {
  DEFAULT_LOCAL_MODEL_PARAMS,
  normalizeLocalModelParams,
} from './modelParams.js';
import { parseParamScaleB, parseQuantization } from './modelCompatibility.js';

// 存储键：设置键（兼容旧单模型）、多模型索引键、模型条目键前缀。
export const LOCAL_MODEL_SETTINGS_KEY = '@easychat2_local_model';
export const LOCAL_MODEL_INDEX_KEY = '@easychat2_local_model_index';
export const LOCAL_MODEL_ITEM_PREFIX = '@easychat2_local_model_item';
export const LOCAL_MODEL_ITEM_VERSION = 1;

// 模型下载源预设：官方 Hugging Face、国内镜像 hf-mirror.com 与魔搭社区。
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
  {
    id: 'modelscope',
    name: '魔搭社区',
    baseUrl: 'https://modelscope.cn',
    note: '国内 ModelScope，需用魔搭上架的 GGUF 仓库。',
  },
];

export function buildModelDownloadUrl(baseUrl, repoPath) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const path = String(repoPath || '').trim().replace(/^\/+/, '');
  if (!base || !path) return '';
  return `${base}/${path}`;
}

// 本地 OpenAI 兼容服务设置。host 固定回环地址，用户只能改端口与密钥。
export const DEFAULT_LOCAL_MODEL_API_SERVER = {
  enabled: false,
  host: '127.0.0.1',
  port: 8080,
  apiKey: '',
};

export function normalizeLocalModelApiServer(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const port = Math.trunc(Number(source.port));
  const validPort = Number.isFinite(port) && port >= 1024 && port <= 65535;
  return {
    enabled: source.enabled === true,
    host: DEFAULT_LOCAL_MODEL_API_SERVER.host,
    port: validPort ? port : DEFAULT_LOCAL_MODEL_API_SERVER.port,
    apiKey: String(source.apiKey || ''),
  };
}

export const DEFAULT_LOCAL_MODEL_SETTINGS = {
  enabled: false,
  // 旧单模型字段：迁移期保留，供既有面板与聊天路径继续读取，后续切换多模型后再收敛。
  modelId: '',
  modelName: '',
  modelUrl: '',
  modelPath: '',
  modelSha256: '',
  modelBytes: 0,
  contextSize: 2048,
  gpuLayers: 0,
  // 多模态输入默认关：仅当模型有能力且用户开启时，才把图片/音频发给本地推理。
  enableMediaInput: false,
  // 多模型字段：当前活动模型 id 与本地 API 服务设置。
  activeModelId: '',
  apiServer: { ...DEFAULT_LOCAL_MODEL_API_SERVER },
  updatedAt: 0,
};

export function normalizeLocalModelSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bytes = Number(source.modelBytes);
  const contextSize = Number(source.contextSize);
  const gpuLayers = Number(source.gpuLayers);
  return {
    enabled: source.enabled === true,
    modelId: String(source.modelId || ''),
    modelName: String(source.modelName || ''),
    modelUrl: String(source.modelUrl || ''),
    modelPath: String(source.modelPath || ''),
    modelSha256: String(source.modelSha256 || ''),
    modelBytes: Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0,
    contextSize: Number.isFinite(contextSize) && contextSize > 0 ? Math.max(512, Math.floor(contextSize)) : 2048,
    gpuLayers: Number.isFinite(gpuLayers) && gpuLayers >= 0 ? Math.floor(gpuLayers) : 0,
    enableMediaInput: source.enableMediaInput === true,
    activeModelId: String(source.activeModelId || '').trim(),
    apiServer: normalizeLocalModelApiServer(source.apiServer),
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : 0,
  };
}

export function localModelPath(modelId, extension = 'gguf') {
  const safeId = String(modelId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${safeId || 'model'}.${extension}`;
}

// 旧单模型就绪判断：仍供既有在线/本地路由使用，切换多模型后再改为按 activeModelId。
export function isLocalModelReady(settings, fileInfo = null) {
  const normalized = normalizeLocalModelSettings(settings);
  if (!normalized.enabled || !normalized.modelId || !normalized.modelPath) return false;
  if (fileInfo && fileInfo.exists === false) return false;
  if (fileInfo && Number(normalized.modelBytes) > 0 && Number(fileInfo.size) !== Number(normalized.modelBytes)) return false;
  return true;
}

function toNonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function toNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function toTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export const DEFAULT_LOCAL_MODEL_ITEM = {
  id: '',
  name: '',
  sourceId: '',
  repoPath: '',
  modelUrl: '',
  modelPath: '',
  modelBytes: 0,
  modelSha256: '',
  quant: '',
  // 参数规模（十亿参数，如 1.5 表示 1.5B）；0 表示未知。
  paramSize: 0,
  imported: false,
  hasVision: false,
  hasAudio: false,
  mmprojUrl: '',
  mmprojPath: '',
  mmprojBytes: 0,
  version: LOCAL_MODEL_ITEM_VERSION,
  params: { ...DEFAULT_LOCAL_MODEL_PARAMS },
  createdAt: 0,
  updatedAt: 0,
};

export function normalizeLocalModelItem(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: String(source.id || '').trim(),
    name: String(source.name || ''),
    sourceId: String(source.sourceId || ''),
    repoPath: String(source.repoPath || ''),
    modelUrl: String(source.modelUrl || ''),
    modelPath: String(source.modelPath || ''),
    modelBytes: toNonNegativeInt(source.modelBytes),
    modelSha256: String(source.modelSha256 || ''),
    quant: String(source.quant || ''),
    paramSize: toNonNegativeNumber(source.paramSize),
    imported: source.imported === true,
    hasVision: source.hasVision === true,
    hasAudio: source.hasAudio === true,
    mmprojUrl: String(source.mmprojUrl || ''),
    mmprojPath: String(source.mmprojPath || ''),
    mmprojBytes: toNonNegativeInt(source.mmprojBytes),
    version: LOCAL_MODEL_ITEM_VERSION,
    params: normalizeLocalModelParams(source.params),
    createdAt: toTimestamp(source.createdAt),
    updatedAt: toTimestamp(source.updatedAt),
  };
}

// 索引只存列表渲染需要的轻量字段，避免为展示列表逐个读取模型条目。
export const DEFAULT_LOCAL_MODEL_INDEX_ENTRY = {
  id: '',
  name: '',
  quant: '',
  paramSize: 0,
  modelBytes: 0,
  hasVision: false,
  hasAudio: false,
  imported: false,
  addedAt: 0,
  updatedAt: 0,
};

export function normalizeLocalModelIndexEntry(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: String(source.id || '').trim(),
    name: String(source.name || ''),
    quant: String(source.quant || ''),
    paramSize: toNonNegativeNumber(source.paramSize),
    modelBytes: toNonNegativeInt(source.modelBytes),
    hasVision: source.hasVision === true,
    hasAudio: source.hasAudio === true,
    imported: source.imported === true,
    addedAt: toTimestamp(source.addedAt),
    updatedAt: toTimestamp(source.updatedAt),
  };
}

export function localModelIndexEntry(item) {
  const normalized = normalizeLocalModelItem(item);
  return {
    id: normalized.id,
    name: normalized.name,
    quant: normalized.quant,
    paramSize: normalized.paramSize,
    modelBytes: normalized.modelBytes,
    hasVision: normalized.hasVision,
    hasAudio: normalized.hasAudio,
    imported: normalized.imported,
    addedAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
  };
}

// 由文件名（或路径）推导安全稳定的模型 id：去目录、去 .gguf 扩展、非法字符转下划线。
export function localModelIdFromFileName(fileName) {
  return String(fileName || '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.gguf$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '');
}

// 由 mmproj 投影文件推断多模态能力：默认视作视觉，名称含 audio 视作听觉。
export function localModelCapabilities({ mmprojUrl = '', mmprojPath = '', hasVision = false, hasAudio = false } = {}) {
  const projector = `${mmprojUrl} ${mmprojPath}`;
  const hasProjector = Boolean(String(projector).trim());
  return {
    hasVision: hasVision === true || (hasProjector && !/audio/i.test(projector)),
    hasAudio: hasAudio === true || (hasProjector && /audio/i.test(projector)),
  };
}

// 从下载/导入结果构造模型条目：量化与参数规模缺省时按名称兜底解析。
export function buildLocalModelItem(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const name = String(source.name || source.id || '');
  const capabilities = localModelCapabilities({
    mmprojUrl: source.mmprojUrl,
    mmprojPath: source.mmprojPath,
    hasVision: source.hasVision,
    hasAudio: source.hasAudio,
  });
  const deriveText = [name, source.id, source.modelUrl].filter(Boolean).join(' ');
  const derivedQuant = String(source.quant || '').trim() || (parseQuantization(deriveText)?.label || '');
  const providedParam = Number(source.paramSize);
  const derivedParam = Number.isFinite(providedParam) && providedParam > 0
    ? providedParam
    : (parseParamScaleB(deriveText) || parseParamScaleB(source.quant) || 0);
  return normalizeLocalModelItem({
    ...source,
    name,
    quant: derivedQuant,
    paramSize: derivedParam,
    hasVision: capabilities.hasVision,
    hasAudio: capabilities.hasAudio,
  });
}

// 选用活动模型：activeModelId 为主，同时镜像旧单模型字段，让既有在线/本地路由无需改动即可读到。
export function applyActiveLocalModel(settings, item, now = Date.now()) {
  const normalizedSettings = normalizeLocalModelSettings(settings);
  const normalizedItem = normalizeLocalModelItem(item);
  if (!normalizedItem.id) return normalizedSettings;
  return {
    ...normalizedSettings,
    enabled: true,
    activeModelId: normalizedItem.id,
    modelId: normalizedItem.id,
    modelName: normalizedItem.name,
    modelUrl: normalizedItem.modelUrl,
    modelPath: normalizedItem.modelPath,
    modelBytes: normalizedItem.modelBytes,
    contextSize: normalizedItem.params.contextSize,
    gpuLayers: normalizedItem.params.gpuLayers,
    updatedAt: now,
  };
}

// 删除活动模型：清空指针与旧单模型字段，回到纯在线状态。
export function clearActiveLocalModel(settings, now = Date.now()) {
  const normalized = normalizeLocalModelSettings(settings);
  return {
    ...normalized,
    enabled: false,
    activeModelId: '',
    modelId: '',
    modelName: '',
    modelUrl: '',
    modelPath: '',
    modelBytes: 0,
    updatedAt: now,
  };
}

// 媒体入口由「已启用的活动模型 + 用户开关 + 模型能力」共同决定。
// 供发送前的附件校验使用，避免只看在线 API 配置而提前拦截本地模型的 mmproj 能力。
export function getLocalModelMediaCapabilities(settings, item) {
  const normalized = normalizeLocalModelSettings(settings);
  const source = item && typeof item === 'object' ? item : {};
  const enabled = normalized.enabled && normalized.enableMediaInput;
  return {
    vision: enabled && source.hasVision === true,
    audio: enabled && source.hasAudio === true,
  };
}

export function isLocalModelItemReady(item, fileInfo = null) {
  const normalized = normalizeLocalModelItem(item);
  if (!normalized.id || !normalized.modelPath) return false;
  if (fileInfo && fileInfo.exists === false) return false;
  if (fileInfo && normalized.modelBytes > 0 && Number(fileInfo.size) !== normalized.modelBytes) return false;
  return true;
}

// 旧单模型设置 → 多模型设置 + 条目。纯函数：只做结构转换，落盘由存储层负责。
// 没有旧模型时返回 null 条目，仅迁移设置结构。
export function migrateLegacyLocalModelSettings(legacy) {
  const source = legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy : {};
  const legacyId = String(source.modelId || '').trim();
  const hasModel = legacyId !== '' || String(source.modelPath || '').trim() !== '';
  const settings = normalizeLocalModelSettings({
    ...source,
    activeModelId: hasModel ? legacyId : String(source.activeModelId || '').trim(),
  });
  if (!hasModel) return { settings, item: null };
  const now = toTimestamp(source.updatedAt) || Date.now();
  const item = normalizeLocalModelItem({
    id: legacyId,
    name: source.modelName || legacyId,
    modelUrl: source.modelUrl,
    modelPath: source.modelPath,
    modelBytes: source.modelBytes,
    modelSha256: source.modelSha256,
    params: { contextSize: source.contextSize, gpuLayers: source.gpuLayers },
    createdAt: now,
    updatedAt: now,
  });
  return { settings, item: item.id ? item : null };
}
