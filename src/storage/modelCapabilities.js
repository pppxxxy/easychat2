// 模型能力解析（**零依赖纯函数叶子**）。
//
// 为什么单独一个文件：这些函数必须能被**在 Node 里直接 import 的纯模块**使用。
// storage/apiConfigs.js 虽然本身逻辑纯净，但它 import 了 ./io.js，而 io.js 会
// `import * as FileSystem from 'expo-file-system/legacy'` —— 这个子路径在 Node 下
// **不存在**（仓库既有记录：tests/imageRecognitionEngine.test.mjs 顶部注释）。
// 于是「凡是 import apiConfigs 的模块，都在 Node 里加载不了」，纯函数测试无从谈起。
//
// 因此能力解析外提到本文件：**不 import 任何东西**，可被任意测试与业务模块安全引用。
// apiConfigs.js 原样 re-export 下面这些符号，既有导入路径全部不变（公开 API 不变）。
//
// ---- 能力按「模型」一份，而不是按「API 配置」一份 ----
//
// 同一配置下不同模型的模态能力不同（一把 key 可能既有纯文本模型又有视觉模型），
// 因此思考/识图/视频/语音识别与思考字段名都挂在具体模型上：
//   config.modelCapabilities = { [modelName]: { supportsThinking, thinkingField,
//     thinkingFormat, supportsVision, supportsVideo, supportsAudio } }
// 旧版本把能力存在配置级——首次归一时物化成每个已有模型一份（保留旧行为）；
// 此后**新增模型不继承任何旧值**（未确认 = 全不支持，需要用户在能力弹层里显式确认）。

// getActiveModel 在拿不到配置时的兜底模型名。apiConfigs.js 的 DEFAULT_API_CONFIG
// 直接引用它，保证「兜底模型名」全仓单一来源。
export const DEFAULT_MODEL_FALLBACK = 'deepseek-chat';

export const CAPABILITY_DEFAULTS = {
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
//
// 这条 legacy 回落是「换口径后老用户不受影响」的**唯一**保证：配置级旧字段只在
// 这里被读取一次、物化成逐模型条目，运行时消费点一律走 capabilitiesForModel。
export function normalizeModelCapabilities(raw, models, legacy) {
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

export function getActiveModel(config) {
  if (!config) return DEFAULT_MODEL_FALLBACK;
  return String(config.activeModel || '')
    || (Array.isArray(config.models) && config.models[0])
    || String(config.model || '')
    || DEFAULT_MODEL_FALLBACK;
}
