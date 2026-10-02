// API 配置存储领域。从 src/storage.js 原样外提（无行为变化）。
// 含密钥：读写统一走 io.js 的 *WithSecrets 入口。

import {
  backupCorruptValue,
  createMutationQueue,
  readJsonStatusWithSecrets,
  setJsonWithSecrets,
} from './io.js';

const API_CONFIG_KEY = '@easychat2_api_config';
const API_CONFIGS_KEY = '@easychat2_api_configs';

// API 配置是「整表覆盖」写入：调用方（设置页、聊天页模型切换）都基于各自
// 内存快照构造完整列表后整体落盘，两次并发保存会互相覆盖。这里用队列把
// saveApiConfigs 串行化，避免交错写；首启迁移写保持不入队（只读路径内触发、
// 仅缺键时发生）。读路径（getApiConfigs/getActiveApiConfig）不入队，避免与
// 入队的 save 形成同队列重入。
const apiConfigsMutation = createMutationQueue();

const DEFAULT_API_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: ''
};

function makeApiConfigId() {
  return `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeApiConfig(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const legacyModel = String(source.model || source.activeModel || DEFAULT_API_CONFIG.model);
  const providedModels = Array.isArray(source.models)
    ? source.models.map(item => String(item || '').trim()).filter(Boolean)
    : null;
  const models = providedModels !== null ? providedModels : [legacyModel];
  const requestedActive = String(source.activeModel || '');
  const activeModel = models.includes(requestedActive)
    ? requestedActive
    : (models.includes(legacyModel) ? legacyModel : (models[0] || ''));
  return {
    id: String(source.id || `cfg-${index}`),
    name: String(source.name || `配置 ${index + 1}`),
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : DEFAULT_API_CONFIG.baseUrl,
    apiKey: String(source.apiKey || ''),
    vendorId: String(source.vendorId || ''),
    protocol: source.protocol === 'anthropic' ? 'anthropic' : 'openai',
    authHeader: String(source.authHeader || 'Authorization'),
    authScheme: source.authScheme === undefined || source.authScheme === null
      ? 'Bearer '
      : String(source.authScheme),
    apiKeyUrl: String(source.apiKeyUrl || ''),
    models,
    activeModel,
    supportsThinking: source.supportsThinking === true,
    supportsVision: source.supportsVision === true,
    supportsAudio: source.supportsAudio === true,
    thinking: {
      field: String((source.thinking && source.thinking.field) || 'reasoning_effort')
        || 'reasoning_effort',
      format: ['effort', 'boolean', 'object'].includes(source.thinking && source.thinking.format)
        ? source.thinking.format
        : 'effort',
    },
  };
}

export function getActiveModel(config) {
  if (!config) return DEFAULT_API_CONFIG.model;
  return String(config.activeModel || '')
    || (Array.isArray(config.models) && config.models[0])
    || String(config.model || '')
    || DEFAULT_API_CONFIG.model;
}

function ensureUniqueApiConfigIds(list) {
  const seen = new Set();
  return list.map((item, index) => {
    let id = String(item.id);
    if (seen.has(id)) {
      let candidate = `${id}-${index}`;
      let bump = index;
      while (seen.has(candidate)) {
        bump += 1;
        candidate = `${id}-${index}-${bump}`;
      }
      id = candidate;
    }
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

async function persistApiConfigs(configs, activeId) {
  await setJsonWithSecrets(API_CONFIGS_KEY, { configs, activeId });
}

export async function getApiConfigs() {
  const stored = await readJsonStatusWithSecrets(API_CONFIGS_KEY);
  let payload = stored.status === 'ok' ? stored.value : null;
  const shapeInvalid = payload !== null
    && (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.configs));
  if (stored.status === 'corrupt' || shapeInvalid) {
    // 以前这里直接抛错：用户会卡在“读不到配置”，原始数据既没备份也无法自愈。
    // 现在先备份原始值，再按“缺失”重建默认配置。
    await backupCorruptValue(API_CONFIGS_KEY);
    payload = null;
  }
  let configs = [];
  let activeId = '';
  let needsPersist = false;

  if (payload) {
    configs = ensureUniqueApiConfigIds(payload.configs.map(normalizeApiConfig));
    activeId = String(payload.activeId || '');
  } else {
    // 旧单配置键：仅迁移用，读失败绝不覆盖；密钥可能为明文，hydrate 后随新结构一并转引用。
    const legacy = await readJsonStatusWithSecrets(API_CONFIG_KEY);
    if (legacy.status === 'corrupt') await backupCorruptValue(API_CONFIG_KEY);
    const legacyValue = legacy.status === 'ok'
      && legacy.value && typeof legacy.value === 'object' && !Array.isArray(legacy.value)
      ? legacy.value
      : null;
    const seed = legacyValue
      ? { ...legacyValue, id: 'default', name: '默认配置' }
      : { id: 'default', name: '默认配置' };
    configs = [normalizeApiConfig(seed, 0)];
    needsPersist = true;
  }

  if (configs.length === 0) {
    configs = [normalizeApiConfig({ id: 'default', name: '默认配置' }, 0)];
    needsPersist = true;
  }
  if (!configs.some(item => item.id === activeId)) {
    activeId = configs[0].id;
    needsPersist = true;
  }
  if (needsPersist) {
    try {
      await persistApiConfigs(configs, activeId);
    } catch (error) {}
  }
  return { configs, activeId };
}

export function saveApiConfigs(configs, activeId) {
  return apiConfigsMutation.enqueue(async () => {
    const normalized = ensureUniqueApiConfigIds(
      (Array.isArray(configs) ? configs : []).map(normalizeApiConfig)
    );
    const list = normalized.length
      ? normalized
      : [normalizeApiConfig({ id: 'default', name: '默认配置' }, 0)];
    const resolvedActive = list.some(item => item.id === activeId)
      ? String(activeId)
      : list[0].id;
    await persistApiConfigs(list, resolvedActive);
    return { configs: list, activeId: resolvedActive };
  });
}

export function createApiConfig(partial = {}) {
  return normalizeApiConfig({ id: makeApiConfigId(), ...partial });
}

export async function getActiveApiConfig() {
  const { configs, activeId } = await getApiConfigs();
  return configs.find(item => item.id === activeId) || configs[0];
}