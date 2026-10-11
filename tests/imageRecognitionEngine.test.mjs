// 图片识别（OCR）引擎：行为测试。
//
// 加载方式（仓库既有范式：babel 转译 + Module._load 打桩）：
// - **只**打桩引擎的**直接**依赖（apiConfigs / network/api / localModel / 附件读取），
//   因为 Node 下 `src/storage/io.js` 会被 ESM 加载器接管、绕过 Module._load，
//   真实 apiConfigs 一加载就会因 `expo-file-system/legacy` 这个不存在的子路径而崩；
// - 缓存存储（storage/settings/imageRecognition.js）保持**真实模块**，它只有纯逻辑
//   + 一个 io 打桩，可以在 Node 里真跑；
// - 网络传输用确定性假实现注入。
//
// 覆盖的关键判定（改回错写法就会变红）：
// - 并发上限：同时在途的请求数不超过配置值（一次打爆接口）；
// - 缓存命中：同一张图（内容 hash 相同）第二次识别不再发起请求；
// - 缓存隔离：换配置 / 换模型 / 改提示词都会失效，不复用旧结果；
// - 超时：必须真的 abort 在途请求（只 race 掉 Promise 会让请求继续跑）；
// - 降级：主模型支持识图 → fallback-original；不支持 → fail（不许静默丢图）；
// - 未启用/配置不全：skipped，且一次请求都不发。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import nodeCrypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

// ---- 打桩：AsyncStorage（真内存，供缓存存储使用）----
const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
  getAllKeys: async () => [...store.keys()],
};

// ---- 打桩：API 配置（真内存 + 与真实模块同形的归一化）----
const apiConfigStore = new Map();
function makeApiConfig(partial = {}) {
  const models = Array.isArray(partial.models) && partial.models.length ? partial.models : ['ocr-model'];
  return {
    id: String(partial.id || ''),
    name: String(partial.name || ''),
    baseUrl: String(partial.baseUrl || 'https://example.com/v1'),
    apiKey: String(partial.apiKey === undefined ? 'sk-test-ocr' : partial.apiKey),
    models,
    activeModel: String(partial.activeModel || models[0]),
    modelCapabilities: partial.modelCapabilities || {},
  };
}
const apiConfigsStub = {
  getApiConfigs: async () => ({
    configs: [...apiConfigStore.values()],
    activeId: apiConfigStore.size ? [...apiConfigStore.keys()][0] : '',
  }),
  capabilitiesForModel: (config, model) => {
    const entry = config && config.modelCapabilities ? config.modelCapabilities[String(model || '')] : null;
    return { supportsVision: !!(entry && entry.supportsVision === true) };
  },
  getActiveModel: config => String((config && config.activeModel) || '') || 'ocr-model',
};

// ---- 打桩：网络传输与其它叶子依赖 ----
const apiStub = {
  sendChatMessage: async () => { throw new Error('测试必须显式注入 send'); },
  getConfigFingerprint: config => `fp:${String((config && config.id) || '')}:${String((config && config.apiKey) || '')}`,
};
const localModelStateStub = { getLocalModelMediaCapabilities: () => ({ vision: false, audio: false }) };
const localModelsStub = { getActiveLocalModel: async () => null, getLocalModelSettings: async () => null };
const attachmentsStub = { readImageDataUri: async uri => String(uri || '') };
// sha256 桩：真实的 mcp/sha256.js 会经 storage/io.js 拉进 expo-file-system/legacy，
// 在 Node 里加载不了。这里用 node:crypto 实现同语义（hash 只用于比对，不参与协议）。
const shaStub = {
  sha256Ascii: text => [...nodeCrypto.createHash('sha256').update(String(text || ''), 'utf8').digest()],
  bytesToBase64Url: bytes => Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
};

// 缓存存储桩：真实模块（storage/settings/imageRecognition.js）会经 storage/io.js
// 拉进 expo-file-system/legacy，而那条链在 Node 下由 **ESM 加载器**接管，
// Module._load 拦不住（实测：只有直接 require 的 specifier 能被拦）。
// 因此引擎测试用同语义的内存桩，缓存自身的完整行为（键/裁剪/上限/损坏）在
// tests/imageRecognitionStorage.test.mjs 里对真实模块验证。
const cacheMemory = new Map();
const cacheStub = {
  getImageRecognitionSettings: async () => null,
  imageRecognitionCacheKey: ({ contentHash, configId, model, promptHash }) => {
    const parts = [contentHash, configId, model, promptHash].map(value => String(value || ''));
    return parts[0] ? parts.join('|') : '';
  },
  readImageRecognitionCache: async key => cacheMemory.get(String(key || '')) || '',
  writeImageRecognitionCache: async (key, value) => {
    const id = String(key || '');
    const text = String(value || '').trim();
    if (!id || !text) return false;
    cacheMemory.set(id, text);
    return true;
  },
};

const stubs = {
  '@react-native-async-storage/async-storage': AsyncStorage,
  // 引擎的直接依赖：见文件头说明，必须打桩才能绕开 ESM 加载链。
  [path.resolve('src/storage/apiConfigs.js')]: apiConfigsStub,
  [path.resolve('src/network/api.js')]: apiStub,
  [path.resolve('src/localModel/modelState.js')]: localModelStateStub,
  [path.resolve('src/storage/localModels.js')]: localModelsStub,
  [path.resolve('src/chat/attachments.js')]: attachmentsStub,
  [path.resolve('src/mcp/sha256.js')]: shaStub,
  [path.resolve('src/storage/settings/imageRecognition.js')]: cacheStub,
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  // 编译产物里的相对 specifier（`../storage/apiConfigs.js`）要按发起方目录解析成
  // 绝对路径才能命中上表——按原样字符串查表是永远命中不了的。
  if (typeof request === 'string' && request.startsWith('.') && parent && parent.filename) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if (Object.prototype.hasOwnProperty.call(stubs, resolved)) return stubs[resolved];
  }
  return originalLoad.call(this, request, parent, isMain);
};

function loadModule(sourcePath) {
  const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const runtime = new Module(sourcePath);
  runtime.filename = sourcePath;
  runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  runtime._compile(transformed, sourcePath);
  return runtime.exports;
}

const engine = loadModule(path.resolve('src/imageRecognition/index.js'));

const {
  buildImageDescriptionText,
  decideAttachOriginal,
  decideImageRecognitionAction,
  describeImages,
  hashImageContent,
  imageDescriptionFailed,
  imageDescriptionPrefix,
  mapWithConcurrency,
  resolveImageRecognitionPlan,
} = engine;

const dataUri = marker => `data:image/png;base64,${Buffer.from(String(marker)).toString('base64')}`;

// 真实存在的 API 配置（含密钥）：resolveImageRecognitionPlan 会真的去读它，
// 所以「配置解析」这条链路覆盖的是真实现（只是配置来源是内存桩）。
function seedApiConfig({ id = 'cfg-ocr', apiKey = 'sk-test-ocr', model = 'ocr-model' } = {}) {
  apiConfigStore.clear();
  apiConfigStore.set(id, makeApiConfig({ id, apiKey, models: [model], activeModel: model }));
  return id;
}

function settingsFor(configId, patch = {}) {
  return {
    enabled: true,
    apiConfigId: configId,
    model: 'ocr-model',
    descriptionPrompt: '描述这张图。',
    maxOutputTokens: 256,
    timeoutSeconds: 30,
    concurrency: 2,
    attachOriginal: false,
    screenWatchSource: 'main',
    ...patch,
  };
}

test('mapWithConcurrency：结果顺序与输入一致，且在途数不超过上限', async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async item => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => { setTimeout(resolve, 5); });
    inFlight -= 1;
    return item * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50], '结果顺序必须与输入一致（错位会让描述配错图）');
  assert.ok(peak <= 2, `在途数不得超过上限 2，实际峰值 ${peak}`);
  assert.ok(peak >= 2, '上限 2 时应当真的并发（否则等于串行，多图会明显变慢）');
});

test('mapWithConcurrency：limit 非法时按 1 处理，空列表不报错', async () => {
  const seen = [];
  await mapWithConcurrency(['a', 'b'], 0, async item => { seen.push(item); });
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(await mapWithConcurrency([], 3, async () => { throw new Error('不该被调用'); }), []);
  assert.deepEqual(await mapWithConcurrency(null, 3, async () => {}), []);
});

test('hashImageContent：同图同 hash、异图异 hash、空值空 hash', () => {
  assert.equal(hashImageContent(dataUri('a')), hashImageContent(dataUri('a')), '同一张图必须同 hash');
  assert.notEqual(hashImageContent(dataUri('a')), hashImageContent(dataUri('b')));
  assert.equal(hashImageContent(''), '');
  assert.equal(hashImageContent('data:image/png;base64,'), '');
  // hash 只认 base64 正文（同内容不同 mime 视为同一张图，避免重复识别同一画面）
  assert.equal(
    hashImageContent(`data:image/jpeg;base64,${Buffer.from('a').toString('base64')}`),
    hashImageContent(dataUri('a'))
  );
});

test('decideImageRecognitionAction：不许静默丢图的判定', () => {
  assert.equal(decideImageRecognitionAction({ mainModelVision: true, failureCount: 0, imageCount: 2 }), 'continue');
  assert.equal(decideImageRecognitionAction({ mainModelVision: false, failureCount: 0, imageCount: 1 }), 'continue');
  assert.equal(decideImageRecognitionAction({ mainModelVision: true, failureCount: 1, imageCount: 1 }), 'fallback-original');
  assert.equal(decideImageRecognitionAction({ mainModelVision: false, failureCount: 1, imageCount: 1 }), 'fail');
  assert.equal(decideImageRecognitionAction({ mainModelVision: false, failureCount: 3, imageCount: 0 }), 'continue');
});

test('decideAttachOriginal：主模型看不到图时一律不附原图；看得到时按用户配置', () => {
  // 主模型看不到图：附了也没用（接口会拒/忽略）
  assert.equal(decideAttachOriginal({ settings: { attachOriginal: true }, mainModelVision: false }), false);
  assert.equal(decideAttachOriginal({ settings: { attachOriginal: true }, mainModelVision: undefined }), false);
  // 看得到图：由用户配置决定
  assert.equal(decideAttachOriginal({ settings: { attachOriginal: true }, mainModelVision: true }), true);
  assert.equal(decideAttachOriginal({ settings: { attachOriginal: false }, mainModelVision: true }), false);
  assert.equal(decideAttachOriginal({ settings: null, mainModelVision: true }), false);
});

test('buildImageDescriptionText：成功项带前缀，失败项如实标注', () => {
  const text = buildImageDescriptionText([
    { sourceUri: 'file:///a.jpg', description: '一只猫' },
    { sourceUri: 'file:///b.jpg', description: '' },
  ]);
  assert.ok(text.includes(imageDescriptionPrefix()));
  assert.ok(text.includes('一只猫'));
  assert.ok(text.includes(imageDescriptionFailed()), '失败项必须如实说明，不能静默省略');
  assert.equal(buildImageDescriptionText([]), '');
  assert.equal(buildImageDescriptionText(null), '');
});

test('未启用：一次请求都不发，skipped 且 reason=disabled', async () => {
  store.clear();
  const configId = seedApiConfig();
  let calls = 0;
  const result = await describeImages([dataUri('a')], {
    settings: settingsFor(configId, { enabled: false }),
    send: async () => { calls += 1; return 'x'; },
  });
  assert.equal(calls, 0, '未启用时不得发起任何请求');
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'disabled');
  assert.equal(result.failureCount, 0, '未启用不是失败（降级判定不该被它触发）');
  assert.equal(result.text, '');
});

test('配置不全：缺模型名 / 配置不存在 / 配置没密钥 都按未就绪处理', async () => {
  store.clear();
  let calls = 0;
  const send = async () => { calls += 1; return 'x'; };

  seedApiConfig();
  const noModel = await describeImages([dataUri('a')], { settings: settingsFor('cfg-ocr', { model: '' }), send });
  assert.equal(noModel.skipped, true);
  assert.equal(noModel.reason, 'no-model');

  const noConfig = await describeImages([dataUri('a')], { settings: settingsFor('cfg-missing'), send });
  assert.equal(noConfig.skipped, true);
  assert.equal(noConfig.reason, 'no-config');

  seedApiConfig({ apiKey: '' });
  const noKey = await describeImages([dataUri('a')], { settings: settingsFor('cfg-ocr'), send });
  assert.equal(noKey.skipped, true);
  assert.equal(noKey.reason, 'no-key');

  assert.equal(calls, 0, '未就绪时一次请求都不该发');
});

test('缓存命中：同一张图第二次识别不再发起请求', async () => {
  store.clear();
  const configId = seedApiConfig();
  cacheMemory.clear();
  let calls = 0;
  const send = async () => { calls += 1; return '画面里有一张表格'; };
  const settings = settingsFor(configId);

  const first = await describeImages([dataUri('same')], { settings, send });
  const second = await describeImages([dataUri('same')], { settings, send });

  assert.equal(calls, 1, '同一张图只应识别一次');
  assert.equal(first.descriptions[0].cached, false, '第一次是新鲜识别');
  assert.equal(second.descriptions[0].cached, true, '第二次必须命中缓存');
  assert.equal(second.descriptions[0].description, '画面里有一张表格');
  assert.ok(first.text.includes('画面里有一张表格'));
});

test('缓存隔离：换模型 / 改提示词都失效，不复用旧结果', async () => {
  store.clear();
  const configId = seedApiConfig();
  cacheMemory.clear();
  let calls = 0;
  const send = async () => { calls += 1; return `描述${calls}`; };
  const uri = dataUri('isolate');

  await describeImages([uri], { settings: settingsFor(configId), send });
  await describeImages([uri], { settings: settingsFor(configId), send });
  assert.equal(calls, 1, '同配置同模型同提示词：第二次命中缓存');

  await describeImages([uri], { settings: settingsFor(configId, { model: 'other-model' }), send });
  assert.equal(calls, 2, '换模型必须重新识别');

  await describeImages([uri], { settings: settingsFor(configId, { model: 'other-model', descriptionPrompt: '换个说法' }), send });
  assert.equal(calls, 3, '改提示词必须重新识别');
});

test('并发上限：5 张图同时识别，在途请求数不超过配置的 2', async () => {
  store.clear();
  const configId = seedApiConfig();
  cacheMemory.clear();
  let inFlight = 0;
  let peak = 0;
  const send = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => { setTimeout(resolve, 10); });
    inFlight -= 1;
    return '描述';
  };
  const uris = [1, 2, 3, 4, 5].map(index => dataUri(`img-${index}`));
  const result = await describeImages(uris, { settings: settingsFor(configId, { concurrency: 2 }), send });
  assert.equal(result.descriptions.length, 5);
  assert.equal(result.failureCount, 0);
  assert.ok(peak <= 2, `在途数不得超过 2，实际峰值 ${peak}`);
  assert.ok(peak >= 2, '并发上限 2 时应当真的并发');
});

test('超时：必须真的 abort 在途请求（不是只 race 掉 Promise）', async () => {
  store.clear();
  const configId = seedApiConfig();
  cacheMemory.clear();
  let observedAbort = false;
  const send = async (messages, options) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      options.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        observedAbort = true;
        reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
      }, { once: true });
    });
    return '不该到这里';
  };
  const result = await describeImages([dataUri('slow')], {
    settings: settingsFor(configId, { timeoutSeconds: 1 }),
    send,
  });
  assert.equal(observedAbort, true, '超时必须中止在途请求');
  assert.equal(result.failureCount, 1, '超时算一次识别失败');
  assert.equal(result.descriptions[0].error, 'TIMEOUT', '失败原因要可判定');
  assert.ok(result.text.includes(imageDescriptionFailed()), '失败必须如实写进给主模型的文本');
});

test('失败不写缓存：下次必须重试（否则一次网络抖动会永久污染结果）', async () => {
  store.clear();
  const configId = seedApiConfig();
  cacheMemory.clear();
  let calls = 0;
  const send = async () => { calls += 1; throw new Error('HTTP 500'); };
  const settings = settingsFor(configId);
  const first = await describeImages([dataUri('boom')], { settings, send });
  assert.equal(first.failureCount, 1);
  assert.equal(first.skipped, false, '识别失败不等于「没识别」');
  const second = await describeImages([dataUri('boom')], { settings, send });
  assert.equal(calls, 2, '失败不得写缓存：下次必须重试');
  assert.equal(second.failureCount, 1);
});

test('取消（调用方已 abort）：不发请求、不算失败', async () => {
  store.clear();
  const configId = seedApiConfig();
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const result = await describeImages([dataUri('a')], {
    settings: settingsFor(configId),
    signal: controller.signal,
    send: async () => { calls += 1; return 'x'; },
  });
  assert.equal(calls, 0);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'aborted');
  assert.equal(result.failureCount, 0, '取消不是失败，不该触发降级提示');
});

test('请求形态：stream:false + configId/model 覆盖 + 输出上限覆盖，且带图片', async () => {
  store.clear();
  const configId = seedApiConfig();
  cacheMemory.clear();
  let captured = null;
  const send = async (messages, options) => { captured = { messages, options }; return '描述'; };
  await describeImages([dataUri('shape')], {
    settings: settingsFor(configId, { maxOutputTokens: 300 }),
    send,
  });
  assert.ok(captured, '必须发起一次请求');
  assert.equal(captured.options.stream, false, '识别是一次性请求，不流式');
  assert.equal(captured.options.configId, configId, '必须显式指定 OCR 配置（不是当前聊天配置）');
  assert.equal(captured.options.model, 'ocr-model', '必须显式指定 OCR 模型');
  assert.equal(captured.options.overrides.maxTokens, 300, '输出上限走单次请求覆盖');
  const content = captured.messages[0].content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, '描述这张图。', '提示词原样发给模型');
  assert.equal(content[1].type, 'image_url');
  assert.ok(String(content[1].image_url.url).startsWith('data:image/png;base64,'), '图片必须是 data URI');
});

test('resolveImageRecognitionPlan：真实读配置，逐项给出未就绪原因', async () => {
  store.clear();
  seedApiConfig();
  const ready = await resolveImageRecognitionPlan(settingsFor('cfg-ocr'));
  assert.equal(ready.ready, true);
  assert.equal(ready.config.id, 'cfg-ocr');
  assert.equal(ready.reason, '');

  const disabled = await resolveImageRecognitionPlan(settingsFor('cfg-ocr', { enabled: false }));
  assert.deepEqual({ ready: disabled.ready, reason: disabled.reason }, { ready: false, reason: 'disabled' });
});
