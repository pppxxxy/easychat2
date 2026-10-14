// API 配置存储领域。从 src/storage.js 原样外提（无行为变化）。
// 含密钥：读写统一走 io.js 的 *WithSecrets 入口。

import {
  backupCorruptValue,
  createMutationQueue,
  readJsonStatusWithSecrets,
  setJsonWithSecrets,
} from './io.js';
import { normalizeProtocol, normalizePromptCacheTtl } from '../apiProtocols.js';
// P0-7：降级模型的归一化是纯函数，放判定层同处（存储层只做「落盘即归一」）。
import { normalizeFallbackModels } from '../network/fallbackModels.js';
import { tActive } from '../i18n/index.js';

const API_CONFIG_KEY = '@easychat2_api_config';
const API_CONFIGS_KEY = '@easychat2_api_configs';

// 输出长度的默认值（tokens）：能力面板里「自定义参数」开启但该项留空时按它发送，
// 与面板上的提示文案一致。总开关关闭时完全不干预（不发 max_tokens）。
export const DEFAULT_MAX_OUTPUT_TOKENS = 32000;

// API 配置是「整表覆盖」写入：调用方（设置页、聊天页模型切换）都基于各自
// 内存快照构造完整列表后整体落盘，两次并发保存会互相覆盖。这里用队列把
// saveApiConfigs 串行化，避免交错写；首启迁移写保持不入队（只读路径内触发、
// 仅缺键时发生）。读路径（getApiConfigs/getActiveApiConfig）不入队，避免与
// 入队的 save 形成同队列重入。
const apiConfigsMutation = createMutationQueue();

// 兜底模型名与能力解析的默认值同源（modelCapabilities.js），避免两处各自漂移。
const DEFAULT_API_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  model: DEFAULT_MODEL_FALLBACK,
  apiKey: ''
};

function makeApiConfigId() {
  return `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- 模型能力解析 ----
//
// 实现在 `./modelCapabilities.js`（**零依赖纯函数叶子**），这里只做 re-export。
// 为什么外提：本文件 import 了 ./io.js，而 io.js 会加载 `expo-file-system/legacy`
// —— 该子路径在 Node 下不存在（tests/imageRecognitionEngine.test.mjs 顶部有记），
// 所以「凡是 import apiConfigs 的模块都进不了 Node 测试」。能力解析必须能被
// 纯函数直测（听歌侧的音频能力判定就踩过读错字段的坑），故拆到零依赖叶子。
// 公开 API 完全不变：下面 re-export 后，原有 `from './apiConfigs.js'` 的导入照旧可用。
//
// 注意：`export ... from` **不创建本地绑定**，所以本文件内部要用的符号必须另外 import。
import {
  DEFAULT_MODEL_FALLBACK,
  normalizeModelCapabilities,
} from './modelCapabilities.js';

export {
  CAPABILITY_DEFAULTS,
  DEFAULT_MODEL_FALLBACK,
  capabilitiesForModel,
  effectiveCapability,
  getActiveModel,
  normalizeCapabilityEntry,
  normalizeModelCapabilities,
  rawCapabilityForModel,
} from './modelCapabilities.js';

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
    name: String(source.name || tActive('apiPreset.numberedName', { index: index + 1 })),
    baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : DEFAULT_API_CONFIG.baseUrl,
    apiKey: String(source.apiKey || ''),
    vendorId: String(source.vendorId || ''),
    protocol: normalizeProtocol(source.protocol),
    // P1-1：Anthropic 显式缓存断点的 TTL（'off' / '5m' / '1h'）。只对 anthropic 协议生效，
    // 但**所有协议都存这个字段**——切协议来回切时不该丢用户的选择。
    promptCacheTtl: normalizePromptCacheTtl(source.promptCacheTtl),
    authHeader: String(source.authHeader || 'Authorization'),
    authScheme: source.authScheme === undefined || source.authScheme === null
      ? 'Bearer '
      : String(source.authScheme),
    apiKeyUrl: String(source.apiKeyUrl || ''),
    models,
    activeModel,
    // P0-7 降级链：主模型 429/5xx/超时/断网时按序换用的模型名（最多 3 个，去重保序）。
    // 归一化放在存储层：读盘与保存两个入口共用一份口径，api.js 拿到的必然是数组，
    // 不用在请求路径上再防一次「用户手改成了字符串」。
    fallbackModels: normalizeFallbackModels(source.fallbackModels),
    supportsThinking: source.supportsThinking === true,
    supportsVision: source.supportsVision === true,
    supportsVideo: source.supportsVideo === true,
    supportsAudio: source.supportsAudio === true,
    thinking: {
      field: String((source.thinking && source.thinking.field) || 'reasoning_effort')
        || 'reasoning_effort',
      format: ['effort', 'boolean', 'object'].includes(source.thinking && source.thinking.format)
        ? source.thinking.format
        : 'effort',
    },
    // 配置级字段保留只为（a）旧版本兼容读取（b）首次迁移的来源；运行时一律走
    // capabilitiesForModel（按模型解析），不再读这里的 supports*。
    modelCapabilities: normalizeModelCapabilities(source.modelCapabilities, models, {
      supportsThinking: source.supportsThinking === true,
      thinkingField: String((source.thinking && source.thinking.field) || '').trim() || 'reasoning_effort',
      thinkingFormat: ['effort', 'boolean', 'object'].includes(source.thinking && source.thinking.format)
        ? source.thinking.format
        : 'effort',
      supportsVision: source.supportsVision === true,
      supportsVideo: source.supportsVideo === true,
      supportsAudio: source.supportsAudio === true,
    }),
  };
}

// getActiveModel 已随能力解析一起外提到 ./modelCapabilities.js 并在此 re-export
// （定义只剩一处，避免两处兜底模型名各自漂移）。

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
      ? { ...legacyValue, id: 'default', name: tActive('apiPreset.defaultName') }
      : { id: 'default', name: tActive('apiPreset.defaultName') };
    configs = [normalizeApiConfig(seed, 0)];
    needsPersist = true;
  }

  if (configs.length === 0) {
    configs = [normalizeApiConfig({ id: 'default', name: tActive('apiPreset.defaultName') }, 0)];
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
      : [normalizeApiConfig({ id: 'default', name: tActive('apiPreset.defaultName') }, 0)];
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