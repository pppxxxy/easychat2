import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

function transform(relativePath) {
  const sourcePath = path.resolve(relativePath);
  return {
    sourcePath,
    code: babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
      babelrc: false,
      configFile: false,
      filename: sourcePath,
      presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
    }).code,
  };
}

// 先真加载 storage/apiConfigs.js（只打桩 AsyncStorage 与 io），拿到真实的
// capabilitiesForModel / createApiConfig —— 指纹与迁移测试必须跑真实现，
// 用简化桩会让「按模型解析」这条语义失去保护。
const store = new Map();
const AsyncStorageStub = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
};
const ioStub = {
  readJsonStatus: async key => {
    const raw = await AsyncStorageStub.getItem(key);
    if (raw === null || raw === undefined) return { status: 'missing' };
    try {
      return { status: 'ok', value: JSON.parse(raw) };
    } catch (error) {
      return { status: 'corrupt' };
    }
  },
  readJsonStatusWithSecrets: async key => {
    const raw = await AsyncStorageStub.getItem(key);
    if (raw === null || raw === undefined) return { status: 'missing' };
    try {
      return { status: 'ok', value: JSON.parse(raw) };
    } catch (error) {
      return { status: 'corrupt' };
    }
  },
  setJsonWithSecrets: async (key, value) => { store.set(key, JSON.stringify(value)); },
  createMutationQueue: () => {
    let single = Promise.resolve();
    return {
      enqueue(task) {
        const next = single.then(task, task);
        single = next.catch(() => {});
        return next;
      },
    };
  },
  backupCorruptValue: async () => {},
};

function loadWithStubs(relativePath, stubs) {
  const { sourcePath, code } = transform(relativePath);
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const base = String(request).split('/').pop();
    if (stubs[base]) return stubs[base];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const runtime = new Module(sourcePath);
    runtime.filename = sourcePath;
    runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
    runtime._compile(code, sourcePath);
    return runtime.exports;
  } finally {
    Module._load = originalLoad;
  }
}

const realApiConfigs = loadWithStubs('src/storage/apiConfigs.js', {
  'async-storage': AsyncStorageStub,
  '@react-native-async-storage/async-storage': AsyncStorageStub,
  'io.js': ioStub,
  'apiProtocols.js': loadWithStubs('src/apiProtocols.js', {}),
});

const storageMock = {
  DEFAULT_MAX_OUTPUT_TOKENS: 32000,
  getActiveApiConfig: async () => ({}),
  getActiveModel: config => String((config && config.activeModel) || (config && config.model) || ''),
  capabilitiesForModel: realApiConfigs.capabilitiesForModel,
  getSamplingSettings: async () => ({}),
  getThinkingSettings: async () => ({}),
};

const apiModule = loadWithStubs('src/network/api.js', {
  // 快赢1 后 api.js 直达 apiConfigs.js / settings.js（原经 storage.js 门面）——
  // 基名映射到同一份 mock，覆盖面不变。
  'storage.js': storageMock,
  'apiConfigs.js': storageMock,
  'settings.js': storageMock,
  'secrets.js': { registerSecretValues: () => {} },
});
const { getConfigFingerprint, EMPTY_REPLY_TEXT } = apiModule;

test('输出长度接线：仅自定义参数开启时介入，留空走默认 32000', () => {
  assert.equal(realApiConfigs.DEFAULT_MAX_OUTPUT_TOKENS, 32000, '输出长度默认值 32000');
  const source = fs.readFileSync(path.resolve('src/network/api.js'), 'utf8');
  assert.ok(
    source.includes('if (modelCaps.customParams === true) {'),
    '只在自定义参数开启时介入；关闭时完全不干预（不发 max_tokens，避免给不支持大输出的模型带上 32000）',
  );
  assert.ok(source.includes('samplingParams.max_tokens = modelCaps.maxOutput > 0'), '填了就按填的值走');
  assert.ok(
    source.includes('? modelCaps.maxOutput') && source.includes(': DEFAULT_MAX_OUTPUT_TOKENS'),
    '留空 = 默认 32000（与面板提示文案一致）',
  );
  assert.ok(
    source.includes('const modelCaps = capabilitiesForModel(config, model);'),
    '走生效能力（受「自定义参数」开关控制），不能直接读配置级字段',
  );
});
const { capabilitiesForModel, createApiConfig, rawCapabilityForModel } = realApiConfigs;

test('API 配置指纹覆盖地址、模型和密钥变化', () => {
  const base = {
    id: 'config-1',
    baseUrl: 'https://example.com/v1',
    activeModel: 'model-a',
    apiKey: 'key-a',
  };
  const original = getConfigFingerprint(base);
  assert.equal(original, getConfigFingerprint({ ...base }));
  assert.notEqual(original, getConfigFingerprint({ ...base, activeModel: 'model-b' }));
  assert.notEqual(original, getConfigFingerprint({ ...base, apiKey: 'key-b' }));
  assert.notEqual(original, getConfigFingerprint({ ...base, baseUrl: 'https://other.example/v1' }));
  assert.equal(original.includes('key-a'), false);
});

test('API 配置指纹覆盖语音识别能力标记（按模型的 supportsAudio）', () => {
  const base = {
    id: 'config-audio',
    baseUrl: 'https://example.com/v1',
    activeModel: 'model-a',
    apiKey: 'key-a',
  };
  const withoutAudio = getConfigFingerprint(base);
  assert.equal(getConfigFingerprint({ ...base, modelCapabilities: {} }), withoutAudio);
  assert.notEqual(
    withoutAudio,
    getConfigFingerprint({ ...base, modelCapabilities: { 'model-a': { supportsAudio: true } } })
  );
  // per-model 语义：能力挂在**别的模型**上，不影响当前模型的指纹。
  assert.equal(
    withoutAudio,
    getConfigFingerprint({ ...base, modelCapabilities: { 'model-b': { supportsAudio: true } } })
  );
});

test('模型能力迁移：旧配置级字段物化到每个已有模型，新增模型不继承', () => {
  // 模拟旧版本数据：能力存在配置级，没有 modelCapabilities 表。
  const migrated = createApiConfig({
    id: 'cfg-legacy',
    name: '旧配置',
    baseUrl: 'https://example.com/v1',
    models: ['model-a', 'model-b'],
    activeModel: 'model-a',
    supportsThinking: true,
    supportsVision: true,
    supportsVideo: false,
    supportsAudio: true,
    thinking: { field: 'enable_thinking', format: 'boolean' },
  });
  assert.deepEqual(Object.keys(migrated.modelCapabilities).sort(), ['model-a', 'model-b'], '每个已有模型物化一份');
  const a = capabilitiesForModel(migrated, 'model-a');
  assert.equal(a.supportsThinking, true, '迁移保留旧行为');
  assert.equal(a.supportsVision, true);
  assert.equal(a.supportsAudio, true);
  assert.equal(a.thinkingField, 'enable_thinking', '思考字段名一并迁移');
  assert.equal(a.thinkingFormat, 'boolean');

  // 已迁移过的数据：显式条目保留；**新增模型无条目 = 未确认 = 全不支持**。
  const withNewModel = createApiConfig({
    ...migrated,
    models: ['model-a', 'model-b', 'model-c'],
    activeModel: 'model-c',
  });
  assert.equal(capabilitiesForModel(withNewModel, 'model-a').supportsThinking, true, '旧条目保留');
  const c = capabilitiesForModel(withNewModel, 'model-c');
  assert.equal(c.supportsThinking, false, '新模型不继承任何旧能力');
  assert.equal(c.supportsVision, false);
  assert.equal(c.supportsAudio, false);
  assert.equal(c.thinkingField, 'reasoning_effort', '新模型用默认思考字段名');
  // 未确认的模型在表里没有条目（UI 据此显示「待确认」）。
  assert.equal('model-c' in withNewModel.modelCapabilities, false);

  // 非法思考格式归一为 effort；条目只保留在 models 列表内的模型。
  const cleaned = createApiConfig({
    ...withNewModel,
    models: ['model-a'],
    modelCapabilities: { 'model-a': { thinkingFormat: 'nonsense' }, 'gone-model': { supportsVision: true } },
  });
  assert.equal(capabilitiesForModel(cleaned, 'model-a').thinkingFormat, 'effort');
  assert.equal('gone-model' in cleaned.modelCapabilities, false, '移除的模型条目自然丢弃');
  // 覆盖 explicit false：条目里显式关闭能力时不得被旧字段复活。
  const explicitOff = createApiConfig({
    ...migrated,
    modelCapabilities: { 'model-a': { supportsThinking: false }, 'model-b': { supportsThinking: false } },
  });
  assert.equal(capabilitiesForModel(explicitOff, 'model-a').supportsThinking, false);
});

test('模型能力：输出长度与「自定义参数」总开关的归一与生效回落', () => {
  const base = {
    id: 'cfg-params',
    models: ['m1', 'm2'],
    activeModel: 'm1',
  };
  const on = createApiConfig({
    ...base,
    modelCapabilities: {
      m1: { customParams: true, contextWindow: 128000, maxOutput: 8192 },
      m2: { customParams: true, maxOutput: 4096 },
    },
  });
  assert.equal(capabilitiesForModel(on, 'm1').maxOutput, 8192, '自定义开启时输出长度生效');
  assert.equal(capabilitiesForModel(on, 'm1').contextWindow, 128000);
  assert.equal(capabilitiesForModel(on, 'm2').maxOutput, 4096);
  assert.equal(capabilitiesForModel(on, 'm2').contextWindow, 0, '未填的项仍为未声明');

  // 关掉总开关：高级项一律回落默认（消费点不必各自判断开关），但原始值仍在盘上
  const off = createApiConfig({
    ...base,
    modelCapabilities: {
      m1: { customParams: false, contextWindow: 128000, maxOutput: 8192 },
    },
  });
  const m1off = capabilitiesForModel(off, 'm1');
  assert.equal(m1off.maxOutput, 0, '关闭时输出长度回落未声明');
  assert.equal(m1off.contextWindow, 0, '关闭时上下文窗口回落未声明');
  assert.equal(m1off.thinkingField, 'reasoning_effort', '关闭时思考字段名回落默认');
  assert.equal(rawCapabilityForModel(off, 'm1').maxOutput, 8192,
    '原始值保留：重新打开开关能恢复上次填的值');

  // 老数据没写过 customParams 但填过高级项 → 迁移为自定义，不能被静默忽略
  const legacyFilled = createApiConfig({
    ...base,
    modelCapabilities: { m1: { contextWindow: 100000 } },
  });
  assert.equal(capabilitiesForModel(legacyFilled, 'm1').customParams, true,
    '填过高级项的老数据视为本来就在自定义');
  assert.equal(capabilitiesForModel(legacyFilled, 'm1').contextWindow, 100000);

  // 空白条目 = 未自定义（新模型默认关闭）
  const empty = createApiConfig({ ...base, modelCapabilities: { m1: {} } });
  assert.equal(capabilitiesForModel(empty, 'm1').customParams, false, '新条目默认关闭自定义参数');
  assert.equal(capabilitiesForModel(empty, 'm1').maxOutput, 0);

  // 非法值收敛
  const messy = createApiConfig({
    ...base,
    modelCapabilities: { m1: { customParams: true, maxOutput: -5, contextWindow: 'abc' } },
  });
  assert.equal(capabilitiesForModel(messy, 'm1').maxOutput, 0, '非法输出长度收敛为 0');
  assert.equal(capabilitiesForModel(messy, 'm1').contextWindow, 0, '非法窗口收敛为 0');
});

test('每模型 contextWindow：声明窗口收敛为非负整数，未声明为 0', () => {
  // 迁移路径：旧配置级字段没有 contextWindow，物化后为 0（运行时落到本地 n_ctx / 默认窗口）。
  const legacy = createApiConfig({
    id: 'cfg-ctx-legacy',
    name: '旧配置',
    baseUrl: 'https://example.com/v1',
    models: ['model-a'],
    activeModel: 'model-a',
    supportsThinking: true,
  });
  assert.equal(capabilitiesForModel(legacy, 'model-a').contextWindow, 0);

  const declared = createApiConfig({
    id: 'cfg-ctx',
    name: '声明窗口',
    baseUrl: 'https://example.com/v1',
    models: ['model-a', 'model-b'],
    activeModel: 'model-a',
    modelCapabilities: {
      'model-a': { contextWindow: 128000 },
      'model-b': { contextWindow: 'abc' },
    },
  });
  assert.equal(capabilitiesForModel(declared, 'model-a').contextWindow, 128000, '正常声明保留');
  assert.equal(capabilitiesForModel(declared, 'model-b').contextWindow, 0, '非法输入归 0');

  const fractional = createApiConfig({
    id: 'cfg-ctx-frac',
    name: '小数',
    baseUrl: 'https://example.com/v1',
    models: ['model-a'],
    activeModel: 'model-a',
    modelCapabilities: { 'model-a': { contextWindow: 4096.9 } },
  });
  assert.equal(capabilitiesForModel(fractional, 'model-a').contextWindow, 4096, '小数向下取整');
});

test('降级模型（P0-7）：落盘即归一，未配置是空数组', () => {
  const untouched = createApiConfig({ id: 'cfg-fb0', models: ['m1'], activeModel: 'm1' });
  assert.deepEqual(untouched.fallbackModels, [], '未配置 = 空数组，请求路径不必再防字符串');

  // 设置页里用户边打边存的是**原始字符串**：归一必须能收下它（逗号/中文逗号/分号/空格/换行）。
  const typed = createApiConfig({
    id: 'cfg-fb1',
    models: ['m1'],
    activeModel: 'm1',
    fallbackModels: ' m2 , m3；m2\nm4 ',
  });
  assert.deepEqual(typed.fallbackModels, ['m2', 'm3', 'm4'], '去空去重保序，最多 3 个');

  const arrayForm = createApiConfig({
    id: 'cfg-fb2',
    models: ['m1'],
    activeModel: 'm1',
    fallbackModels: ['m2', '', 'm2', null],
  });
  assert.deepEqual(arrayForm.fallbackModels, ['m2'], '数组形态同样归一（旧数据/程序化写入）');

  // 归一后的配置再过一次归一必须稳定（读盘 → 保存 的幂等性）。
  assert.deepEqual(createApiConfig(typed).fallbackModels, typed.fallbackModels);
});

test('空回复占位文本保持稳定判等', () => {
  assert.equal(String(` ${EMPTY_REPLY_TEXT} `).trim(), EMPTY_REPLY_TEXT);
});
