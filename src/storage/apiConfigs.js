// API 配置存储领域。从 src/storage.js 原样外提（无行为变化）。
// 含密钥：读写统一走 io.js 的 *WithSecrets 入口。

import {
  backupCorruptValue,
  createMutationQueue,
  readJsonStatusWithSecrets,
  setJsonWithSecrets,
} from './io.js';
import { normalizeProtocol } from '../apiProtocols.js';

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

const DEFAULT_API_CONFIG = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: ''
};

function makeApiConfigId() {
  return `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- 模型能力：按「模型」一份，而不是按「API 配置」一份 ----
//
// 同一配置下不同模型的模态能力不同（一把 key 可能既有纯文本模型又有视觉模型），
// 因此思考/识图/视频/语音识别与思考字段名都挂在具体模型上：
//   config.modelCapabilities = { [modelName]: { supportsThinking, thinkingField,
//     thinkingFormat, supportsVision, supportsVideo, supportsAudio } }
// 旧版本把能力存在配置级——首次归一时物化成每个已有模型一份（保留旧行为）；
// 此后**新增模型不继承任何旧值**（未确认 = 全不支持，需要用户在能力弹层里显式确认）。

const CAPABILITY_DEFAULTS = {
  supportsThinking: false,
  thinkingField: 'reasoning_effort',
  thinkingFormat: 'effort',
  supportsVision: false,
  supportsVideo: false,
  supportsAudio: false,
  contextWindow: 0,
  // 模型的最大输出长度（tokens）；0 = 未声明（请求构造用默认 32000）。
  maxOutput: 0,
  // 「自定义参数」总开关（默认关闭）：关闭时高级项（思考字段名/格式、上下文窗口、
  // 输出长度）一律按默认值参与请求构造——用户填过的值保留在盘上但不生效，
  // 避免手改过的字段在用户以为「已关闭」时仍偷偷改变请求。
  customParams: false,
};

// 旧数据推断：写过非默认的思考字段名/格式，或填过上下文窗口/输出长度，
// 都说明用户本来就在自定义 —— 迁移时置 customParams=true，避免升级后被默认值静默覆盖。
function isCustomCapabilitySource(source) {
  const contextWindow = Math.max(0, Math.floor(Number(source.contextWindow)) || 0);
  const maxOutput = Math.max(0, Math.floor(Number(source.maxOutput)) || 0);
  const field = String(source.thinkingField || '').trim();
  const format = String(source.thinkingFormat || '').trim();
  return contextWindow > 0
    || maxOutput > 0
    || (field !== '' && field !== CAPABILITY_DEFAULTS.thinkingField)
    || (format !== '' && format !== CAPABILITY_DEFAULTS.thinkingFormat);
}

export function normalizeCapabilityEntry(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    supportsThinking: source.supportsThinking === true,
    thinkingField: String(source.thinkingField || '').trim() || 'reasoning_effort',
    thinkingFormat: ['effort', 'boolean', 'object'].includes(source.thinkingFormat)
      ? source.thinkingFormat
      : 'effort',
    supportsVision: source.supportsVision === true,
    supportsVideo: source.supportsVideo === true,
    supportsAudio: source.supportsAudio === true,
    // 模型声明的上下文窗口（tokens）；0 = 未声明（显示与自动压缩用保守默认）。
    contextWindow: Math.max(0, Math.floor(Number(source.contextWindow)) || 0),
    maxOutput: Math.max(0, Math.floor(Number(source.maxOutput)) || 0),
    // 老数据没写过这个标记：按 isCustomCapabilitySource 推断（含旧配置级迁移来的
    // enable_thinking 这类自定义字段名），新模型无条目 → 走默认关闭。
    customParams: source.customParams === undefined
      ? isCustomCapabilitySource(source)
      : source.customParams === true,
  };
}

// 生效能力：customParams 关闭时高级项一律回落默认（基础 supports* 开关不受影响）。
// 运行时消费点（请求构造、上下文占用）统一走这里；编辑器回填走 rawCapabilityForModel，
// 两者分开是为了「关掉开关后仍记得上次填的值」。
export function effectiveCapability(entry) {
  const caps = normalizeCapabilityEntry(entry);
  if (caps.customParams === true) return caps;
  return {
    ...caps,
    thinkingField: CAPABILITY_DEFAULTS.thinkingField,
    thinkingFormat: CAPABILITY_DEFAULTS.thinkingFormat,
    contextWindow: 0,
    maxOutput: 0,
  };
}

// 归一能力表：只保留 models 列表内、且有显式条目的模型；整张表缺失（从未迁移过的
// 旧数据）时用配置级旧字段物化一份给每个已有模型。已迁移过的数据里移除的模型条目
// 会被自然丢弃；新增模型则保持「无条目」= 待确认。
function normalizeModelCapabilities(raw, models, legacy) {
  const list = Array.isArray(models) ? models : [];
  const out = {};
  if (raw === undefined || raw === null) {
    list.forEach(model => { out[model] = normalizeCapabilityEntry(legacy); });
    return out;
  }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  list.forEach(model => {
    if (source[model] !== undefined) out[model] = normalizeCapabilityEntry(source[model]);
  });
  return out;
}

// 解析某模型的能力（纯函数，运行时统一入口）：无显式条目 = 未确认 = 全不支持。
// 返回**生效值**：customParams 关闭时高级项已回落默认，消费点无需各自判断开关。
export function capabilitiesForModel(config, model) {
  const name = String(model || '');
  const entry = config && config.modelCapabilities ? config.modelCapabilities[name] : null;
  return effectiveCapability(entry || CAPABILITY_DEFAULTS);
}

// 原始能力（能力编辑器回填用）：保留用户填过的高级项，
// 这样关掉「自定义参数」再打开，上次填的字段名/窗口还在。
export function rawCapabilityForModel(config, model) {
  const name = String(model || '');
  const entry = config && config.modelCapabilities ? config.modelCapabilities[name] : null;
  return normalizeCapabilityEntry(entry || CAPABILITY_DEFAULTS);
}

export { CAPABILITY_DEFAULTS };

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
    protocol: normalizeProtocol(source.protocol),
    authHeader: String(source.authHeader || 'Authorization'),
    authScheme: source.authScheme === undefined || source.authScheme === null
      ? 'Bearer '
      : String(source.authScheme),
    apiKeyUrl: String(source.apiKeyUrl || ''),
    models,
    activeModel,
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