// 角色专属配置：存储（归一化/schema/幂等/删除钩子）+ 唯一解析层（override/回落/已删配置）。
//
// 用真实模块 + 仓库既有打桩范式（见 tests/characterDeleteCleanup.test.mjs）：babel 转译
// 源码、Module._load 注入内存版 AsyncStorage / SecureStore / FileSystem，然后编译执行
// **真实**的 storage 与 character 模块。断言打的是真实导出函数的行为，不是源码字符串。
//
// 覆盖的关键判定（改回错写法就会变红）：
// - 归一化：非字符串一律字符串化去空白、孤立模型名丢弃、schema 版本落 v1；
// - 幂等：同一份配置反复保存盘上一致；归一化后全空 → 盘上不留空壳条目；
// - 损坏存储：先备份原始值再按「无配置」处理（不静默覆盖）；
// - 角色删除钩子：注册了 characterRuntimeOverrides，且只清被删角色的那一条；
// - 四类解析：有覆盖用覆盖、无覆盖回落全局、覆盖指向已删配置 → 回落全局 + missing 标记；
// - 薄适配：getCharacterApiConfigs 的 activeId/activeModel 按专属口径，且**无覆盖时与
//   getApiConfigs() 完全一致**（零行为变化）。
//
// 密钥纪律：本文件最后一条断言「专属配置键里没有任何密钥字段」，并在保存了带 apiKey 的
// 全局配置后检查该键的原始落盘文本——防止将来有人把密钥塞进本域。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const SRC_DIR = path.resolve('src');

function loadModule(absPath) {
  const cached = Module._cache[absPath];
  if (cached) return cached.exports;
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: absPath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const mod = new Module(absPath);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  Module._cache[absPath] = mod;
  try {
    mod._compile(code, absPath);
  } catch (error) {
    delete Module._cache[absPath];
    throw error;
  }
  return mod.exports;
}

const store = new Map();
const secure = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, String(value)); },
  removeItem: async key => { store.delete(key); },
  multiRemove: async keys => { (Array.isArray(keys) ? keys : []).forEach(key => store.delete(key)); },
  getAllKeys: async () => [...store.keys()],
};
const SecureStore = {
  setItemAsync: async (key, value) => { secure.set(key, String(value)); },
  getItemAsync: async key => (secure.has(key) ? secure.get(key) : null),
  deleteItemAsync: async key => { secure.delete(key); },
};
const FileSystem = {
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: async () => ({ exists: false }),
  makeDirectoryAsync: async () => {},
  writeAsStringAsync: async () => {},
  readAsStringAsync: async () => '',
  readDirectoryAsync: async () => [],
  deleteAsync: async () => {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: AsyncStorage };
  if (request === 'expo-secure-store') return { __esModule: true, ...SecureStore };
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
    return { __esModule: true, ...FileSystem };
  }
  if (request === 'expo-sqlite') return { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolvedBase = path.resolve(path.dirname(parent.filename), request);
    if (resolvedBase.startsWith(`${SRC_DIR}${path.sep}`)) {
      for (const candidate of [resolvedBase, `${resolvedBase}.js`, path.join(resolvedBase, 'index.js')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return loadModule(candidate);
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

const overridesStore = loadModule(path.resolve('src/storage/characterOverrides.js'));
const { runCharacterCleanup, __listCharacterCleanupHooks } = loadModule(
  path.resolve('src/storage/characterLifecycle.js')
);
const { saveApiConfigs, getApiConfigs } = loadModule(path.resolve('src/storage/apiConfigs.js'));
const { saveTtsSettings, saveTranscriptionSettings } = loadModule(
  path.resolve('src/storage/settings/tts.js')
);
const { saveImageRecognitionSettings } = loadModule(
  path.resolve('src/storage/settings/imageRecognition.js')
);
const runtime = loadModule(path.resolve('src/character/runtimeConfig.js'));

const KEY = overridesStore.CHARACTER_OVERRIDES_KEY;

function resetStore() {
  store.clear();
  secure.clear();
}

// 全局基线：两条聊天配置、两条转写配置、TTS 两个 provider、一条 OCR 配置。
async function seedGlobals() {
  await saveApiConfigs([
    { id: 'cfg-global', name: '全局配置', baseUrl: 'https://global.example/v1', apiKey: 'sk-global', models: ['global-model', 'global-model-2'], activeModel: 'global-model' },
    { id: 'cfg-char', name: '角色配置', baseUrl: 'https://char.example/v1', apiKey: 'sk-char', models: ['char-model', 'char-model-2'], activeModel: 'char-model' },
    { id: 'cfg-ocr', name: 'OCR 配置', baseUrl: 'https://ocr.example/v1', apiKey: 'sk-ocr', models: ['ocr-model', 'ocr-model-2'], activeModel: 'ocr-model' },
  ], 'cfg-global');
  await saveTtsSettings({
    autoBroadcast: false,
    activeProvider: 'siliconflow',
    providers: {
      siliconflow: { apiKey: 'sk-tts', model: 'tts-model', voice: 'global-voice' },
      stepfun: { apiKey: 'sk-step', model: 'step-tts', voice: 'step-voice' },
    },
  });
  await saveTranscriptionSettings({
    activeId: 'tr-global',
    configs: [
      { id: 'tr-global', name: '全局转写', baseUrl: 'https://tr.example/v1/audio/transcriptions', apiKey: 'sk-tr', model: 'whisper-1' },
      { id: 'tr-char', name: '角色转写', baseUrl: 'https://tr2.example/v1/audio/transcriptions', apiKey: 'sk-tr2', model: 'whisper-large' },
    ],
  });
  await saveImageRecognitionSettings({
    enabled: true,
    apiConfigId: 'cfg-global',
    model: 'global-ocr-model',
    screenWatchSource: 'ocr',
  });
}

test('归一化：非字符串字符串化去空白、schema 落 v1、缺省全空', () => {
  const defaults = overridesStore.normalizeCharacterOverrides(null);
  assert.equal(defaults.version, 1, 'schema 版本必须是 1');
  assert.deepEqual(
    Object.entries(defaults).filter(([key]) => key !== 'version').map(([, value]) => value),
    ['', '', '', '', '', '', ''],
    '缺省一律为空串（空 = 跟随全局）'
  );
  const normalized = overridesStore.normalizeCharacterOverrides({
    chatApiConfigId: '  cfg-char  ',
    chatModel: ' char-model-2 ',
    ttsProviderId: 123,
    ttsVoice: ' anna ',
    version: 99,
    junk: 'x',
  });
  assert.equal(normalized.chatApiConfigId, 'cfg-char', '去空白');
  assert.equal(normalized.chatModel, 'char-model-2');
  assert.equal(normalized.ttsProviderId, '123', '非字符串一律字符串化');
  assert.equal(normalized.ttsVoice, 'anna');
  assert.equal(normalized.version, 1, '未知版本按当前 schema 归一（读旧数据即等价可用）');
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'junk'), false, '未知字段丢弃');
});

test('归一化：没有选配置时，孤立的模型名被丢弃（不留半截状态）', () => {
  const normalized = overridesStore.normalizeCharacterOverrides({
    chatModel: 'orphan-model',
    ocrModel: 'orphan-ocr',
  });
  assert.equal(normalized.chatModel, '', 'chatModel 只在选了聊天配置时才有意义');
  assert.equal(normalized.ocrModel, '', 'ocrModel 只在选了 OCR 配置时才有意义');
});

test('计数与「全跟随全局」判定：四组，音色与 provider 同属一项', () => {
  assert.equal(overridesStore.countCharacterOverrides(null), 0);
  assert.equal(overridesStore.isEmptyCharacterOverrides(null), true);
  assert.equal(overridesStore.countCharacterOverrides({ ttsVoice: 'anna' }), 1, '只改音色也算配过 TTS 这一项');
  assert.equal(overridesStore.countCharacterOverrides({ ttsProviderId: 'stepfun' }), 1);
  assert.equal(overridesStore.countCharacterOverrides({
    chatApiConfigId: 'a',
    ocrApiConfigId: 'b',
    ttsProviderId: 'c',
    transcriptionConfigId: 'd',
  }), 4);
  assert.equal(overridesStore.isEmptyCharacterOverrides({ chatModel: 'x' }), true, '孤立模型名不算配过');
});

test('读写往返 + 幂等：反复保存盘上一致，全空则不留空壳条目', async () => {
  resetStore();
  const payload = {
    chatApiConfigId: 'cfg-char',
    chatModel: 'char-model-2',
    ocrApiConfigId: 'cfg-ocr',
    ocrModel: 'ocr-model-2',
    ttsProviderId: 'stepfun',
    ttsVoice: 'step-voice',
    transcriptionConfigId: 'tr-char',
  };
  await overridesStore.saveCharacterOverrides('c1', payload);
  const first = store.get(KEY);
  const loaded = await overridesStore.getCharacterOverrides('c1');
  assert.equal(loaded.chatApiConfigId, 'cfg-char');
  assert.equal(loaded.chatModel, 'char-model-2');
  assert.equal(loaded.ocrModel, 'ocr-model-2');
  assert.equal(loaded.ttsVoice, 'step-voice');
  assert.equal(loaded.transcriptionConfigId, 'tr-char');
  // 幂等：同一份再存一次，盘上逐字节一致
  await overridesStore.saveCharacterOverrides('c1', payload);
  assert.equal(store.get(KEY), first, '重复保存必须幂等（不产生漂移）');
  // 保存归一化后的结果（含 version）再存一次也一致
  await overridesStore.saveCharacterOverrides('c1', loaded);
  assert.equal(store.get(KEY), first, '回写读出的归一化结果同样幂等');
  // 清空 → 条目删除，不留空壳
  await overridesStore.saveCharacterOverrides('c1', { chatApiConfigId: '' });
  assert.deepEqual(JSON.parse(store.get(KEY)), {}, '全部跟随全局时盘上不留条目');
  assert.equal(overridesStore.isEmptyCharacterOverrides(await overridesStore.getCharacterOverrides('c1')), true);
});

test('损坏存储：先备份原始值再按「无配置」处理', async () => {
  resetStore();
  store.set(KEY, '{broken');
  const loaded = await overridesStore.getCharacterOverrides('c1');
  assert.equal(loaded.chatApiConfigId, '');
  assert.equal(
    store.get(`${KEY}__corrupt_backup`),
    '{broken',
    '损坏值必须先另存一份（用户逐条选过的 id 不能丢）'
  );
});

test('角色删除钩子：注册了本域，且只清被删角色的那一条', async () => {
  resetStore();
  assert.ok(
    __listCharacterCleanupHooks().includes('characterRuntimeOverrides'),
    'characterRuntimeOverrides 必须注册到角色生命周期'
  );
  await overridesStore.saveCharacterOverrides('c1', { chatApiConfigId: 'cfg-char' });
  await overridesStore.saveCharacterOverrides('c2', { ttsVoice: 'anna' });
  await runCharacterCleanup(['c1']);
  assert.equal(
    overridesStore.isEmptyCharacterOverrides(await overridesStore.getCharacterOverrides('c1')),
    true,
    '被删角色的专属配置必须清掉'
  );
  assert.equal(
    (await overridesStore.getCharacterOverrides('c2')).ttsVoice,
    'anna',
    '别人的专属配置不得连带清掉'
  );
});

test('解析层：没有任何覆盖时，四类都等于全局（零行为变化）', async () => {
  resetStore();
  await seedGlobals();
  const resolved = await runtime.resolveCharacterRuntimeConfig('c1');
  assert.equal(resolved.chat.configId, 'cfg-global');
  assert.equal(resolved.chat.model, 'global-model');
  assert.deepEqual(resolved.chat.requestOptions, {}, '无覆盖时不给请求选项（保持既有解析路径）');
  assert.equal(resolved.ocr.settings.apiConfigId, 'cfg-global');
  assert.equal(resolved.ocr.settings.model, 'global-ocr-model');
  assert.equal(resolved.ocr.settings.enabled, true, '总开关仍取全局');
  assert.equal(resolved.tts.providerId, 'siliconflow');
  assert.equal(resolved.tts.voice, 'global-voice');
  assert.equal(resolved.transcription.configId, 'tr-global');
  for (const item of [resolved.chat, resolved.ocr, resolved.tts, resolved.transcription]) {
    assert.equal(item.overridden, false);
    assert.equal(item.missing, false);
  }
  // 与全局读取逐字段一致（消费点无覆盖时拿到的东西与今天完全相同）
  const globalApi = await getApiConfigs();
  assert.deepEqual(
    resolved.chat.configs.map(item => ({ id: item.id, activeModel: item.activeModel })),
    globalApi.configs.map(item => ({ id: item.id, activeModel: item.activeModel }))
  );
});

test('解析层：聊天 API 覆盖生效（配置 + 模型都换）', async () => {
  resetStore();
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', {
    chatApiConfigId: 'cfg-char',
    chatModel: 'char-model-2',
  });
  const resolved = await runtime.resolveCharacterRuntimeConfig('c1');
  assert.equal(resolved.chat.overridden, true);
  assert.equal(resolved.chat.missing, false);
  assert.equal(resolved.chat.configId, 'cfg-char');
  assert.equal(resolved.chat.model, 'char-model-2');
  assert.deepEqual(resolved.chat.requestOptions, { configId: 'cfg-char', model: 'char-model-2' });
  // 薄适配：activeId 指向专属配置，且该条目的 activeModel 已被换成专属模型
  const adapted = await runtime.getCharacterApiConfigs('c1');
  assert.equal(adapted.activeId, 'cfg-char');
  assert.deepEqual(adapted.chatRequestOptions, { configId: 'cfg-char', model: 'char-model-2' });
  const current = adapted.configs.find(item => item.id === adapted.activeId);
  assert.equal(current.activeModel, 'char-model-2', 'getActiveModel(current) 必须给出专属模型');
  // 其它配置不受影响
  assert.equal(adapted.configs.find(item => item.id === 'cfg-global').activeModel, 'global-model');
});

test('解析层：只换聊天配置不换模型 → 用该配置自带的模型', async () => {
  resetStore();
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', { chatApiConfigId: 'cfg-char' });
  const resolved = await runtime.resolveCharacterRuntimeConfig('c1');
  assert.equal(resolved.chat.configId, 'cfg-char');
  assert.equal(resolved.chat.model, 'char-model', '未指定专属模型时用专属配置自己的 activeModel');
});

test('解析层：OCR 模型 API 覆盖生效（配置 + 模型名）', async () => {
  resetStore();
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', {
    ocrApiConfigId: 'cfg-ocr',
    ocrModel: 'ocr-model-2',
  });
  const settings = await runtime.resolveCharacterOcrSettings('c1');
  assert.equal(settings.apiConfigId, 'cfg-ocr');
  assert.equal(settings.model, 'ocr-model-2');
  assert.equal(settings.enabled, true, '专属配置不改变全局总开关');
  assert.equal(settings.screenWatchSource, 'ocr', '其余字段沿用全局');
  const resolved = await runtime.resolveCharacterRuntimeConfig('c1');
  assert.equal(resolved.ocr.overridden, true);
  assert.equal(resolved.ocr.config.id, 'cfg-ocr');
});

test('解析层：只选 OCR 配置不填模型 → 用该配置的 activeModel', async () => {
  resetStore();
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', { ocrApiConfigId: 'cfg-ocr' });
  const settings = await runtime.resolveCharacterOcrSettings('c1');
  assert.equal(settings.apiConfigId, 'cfg-ocr');
  assert.equal(settings.model, 'ocr-model');
});

test('解析层：TTS API + 音声覆盖生效（换 provider 与音色）', async () => {
  resetStore();
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', {
    ttsProviderId: 'stepfun',
    ttsVoice: 'char-voice',
  });
  const speak = await runtime.resolveCharacterTtsSpeak('c1');
  assert.equal(speak.providerId, 'stepfun');
  assert.equal(speak.provider.id, 'stepfun');
  assert.equal(speak.config.voice, 'char-voice');
  assert.equal(speak.config.apiKey, 'sk-step', '密钥仍来自既有 provider 配置（不新增密钥存储）');
  assert.equal(speak.config.model, 'step-tts');
});

test('解析层：只换音色不换 provider → 音色覆盖到全局 provider 上', async () => {
  resetStore();
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', { ttsVoice: 'char-voice' });
  const speak = await runtime.resolveCharacterTtsSpeak('c1');
  assert.equal(speak.providerId, 'siliconflow');
  assert.equal(speak.config.voice, 'char-voice');
  assert.equal(speak.config.model, 'tts-model', 'provider 配置的其它字段沿用全局');
  // 不填音色 → 跟随全局音色（不写空值把用户填过的音色抹掉）
  await overridesStore.saveCharacterOverrides('c1', { ttsProviderId: 'stepfun' });
  const followGlobal = await runtime.resolveCharacterTtsSpeak('c1');
  assert.equal(followGlobal.providerId, 'stepfun');
  assert.equal(followGlobal.config.voice, 'step-voice');
});

test('解析层：语音转文字 API 覆盖生效（转写的「复用聊天来源」也跟着角色走）', async () => {
  resetStore();
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', {
    chatApiConfigId: 'cfg-char',
    transcriptionConfigId: 'tr-char',
  });
  const sources = await runtime.resolveCharacterTranscriptionSources('c1');
  assert.equal(sources.dedicated.id, 'tr-char');
  assert.equal(sources.dedicated.apiKey, 'sk-tr2');
  assert.equal(sources.chatConfig.id, 'cfg-char', '复用聊天来源时用的是角色专属聊天配置');
});

test('解析层：覆盖指向已删配置 → 回落全局并报 missing（四类一致）', async () => {
  resetStore();
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', {
    chatApiConfigId: 'cfg-deleted',
    ocrApiConfigId: 'cfg-deleted',
    ttsProviderId: 'provider-deleted',
    transcriptionConfigId: 'tr-deleted',
  });
  const resolved = await runtime.resolveCharacterRuntimeConfig('c1');

  // 聊天：回落全局，且不再给请求覆盖选项（否则请求会去找一条不存在的配置）
  assert.equal(resolved.chat.overridden, true, '用户确实配过（界面要显示「专属」标记）');
  assert.equal(resolved.chat.missing, true, '界面必须能提示「已失效」');
  assert.equal(resolved.chat.missingId, 'cfg-deleted');
  assert.equal(resolved.chat.configId, 'cfg-global', '回落全局');
  assert.equal(resolved.chat.model, 'global-model', '模型一起回落，不出现串味');
  assert.deepEqual(resolved.chat.requestOptions, {}, '失效的覆盖不得进请求选项');

  assert.equal(resolved.ocr.missing, true);
  assert.equal(resolved.ocr.missingId, 'cfg-deleted');
  assert.equal(resolved.ocr.settings.apiConfigId, 'cfg-global', 'OCR 回落全局');
  assert.equal(resolved.ocr.settings.model, 'global-ocr-model');

  assert.equal(resolved.tts.missing, true);
  assert.equal(resolved.tts.missingId, 'provider-deleted');
  assert.equal(resolved.tts.providerId, 'siliconflow', 'TTS 回落全局 provider');
  assert.equal(resolved.tts.voice, 'global-voice');

  assert.equal(resolved.transcription.missing, true);
  assert.equal(resolved.transcription.missingId, 'tr-deleted');
  assert.equal(resolved.transcription.configId, 'tr-global', '转写回落全局');
});

test('解析层：全局也缺该配置时（转写 activeId 为空）→ dedicated 为空，交给「复用聊天来源」', async () => {
  resetStore();
  await seedGlobals();
  await saveTranscriptionSettings({ activeId: '', configs: [] });
  await overridesStore.saveCharacterOverrides('c1', { transcriptionConfigId: 'tr-deleted' });
  const sources = await runtime.resolveCharacterTranscriptionSources('c1');
  assert.equal(sources.dedicated, null, '全局没有独立转写配置 → dedicated 为空（既有「复用聊天来源」语义）');
  assert.ok(sources.chatConfig, '仍拿得到聊天配置供复用');
});

test('密钥纪律：专属配置键里没有任何密钥字段，也不含任何密钥明文', async () => {
  resetStore();
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', {
    chatApiConfigId: 'cfg-char',
    ocrApiConfigId: 'cfg-ocr',
    ttsProviderId: 'stepfun',
    ttsVoice: 'anna',
    transcriptionConfigId: 'tr-char',
  });
  const raw = store.get(KEY);
  assert.equal(/"apiKey"|"secret"|"token"|"appSecretKey"/i.test(raw), false, '不得出现任何密钥字段名');
  for (const secret of ['sk-global', 'sk-char', 'sk-ocr', 'sk-tts', 'sk-step', 'sk-tr', 'sk-tr2']) {
    assert.equal(raw.includes(secret), false, `不得落盘任何密钥明文（${secret}）`);
  }
  // 只引用既有 id
  assert.ok(raw.includes('cfg-char') && raw.includes('stepfun') && raw.includes('tr-char'));
});
