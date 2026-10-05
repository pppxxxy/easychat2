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
  getActiveApiConfig: async () => ({}),
  getActiveModel: config => String((config && config.activeModel) || (config && config.model) || ''),
  capabilitiesForModel: realApiConfigs.capabilitiesForModel,
  getSamplingSettings: async () => ({}),
  getThinkingSettings: async () => ({}),
};

const apiModule = loadWithStubs('src/network/api.js', {
  'storage.js': storageMock,
  'secrets.js': { registerSecretValues: () => {} },
});
const { getConfigFingerprint, EMPTY_REPLY_TEXT } = apiModule;
const { capabilitiesForModel, createApiConfig } = realApiConfigs;

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

test('空回复占位文本保持稳定判等', () => {
  assert.equal(String(` ${EMPTY_REPLY_TEXT} `).trim(), EMPTY_REPLY_TEXT);
});
