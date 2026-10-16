// 角色专属配置：**四类消费点各自真的读了 override** 的行为测试。
//
// 加载方式（仓库既有范式：babel 转译 + Module._load 打桩，见 tests/characterRuntimeConfig.test.mjs）：
// 真实 storage / 真实解析层 / 真实消费者模块；只把叶子依赖（AsyncStorage、SecureStore、
// FileSystem、React 的 hook 调度器、TTS 引擎、图片识别引擎、i18n）换成内存/记录替身。
//
// 为什么消费点也要单独测：解析层对不代表消费点接了它。这个仓库已经被「改了定义方、
// 漏了调用方」咬了五次以上，所以每一类消费点都有一条**执行真实消费者代码**的断言：
// - TTS + 音声：真跑 useChatTts 的播报回调（React 用最小 hook 替身），看它交给引擎的
//   provider/config 是不是角色专属的那一份；
// - OCR：真跑 applyImageRecognitionToMessages，看它转给识别引擎的 settings 是不是
//   角色生效的那一份；
// - 转写：真跑 resolveCharacterTranscription（聊天页与工作区共用的唯一入口）；
// - 聊天 API：真跑 getCharacterApiConfigs，看 activeId / activeModel / 请求覆盖片段。
//
// 文件末尾的「接线钉」是**最小**的源码级断言，只覆盖 Node 里跑不起来的 RN 屏幕
//（ChatScreen / ChatPanel / useChatSend 是巨型 hook 组件）：它们钉的是「这一处仍然
// 从解析层取」，而不是新功能的行为——行为在上面与 tests/characterRuntimeConfig.test.mjs。
// 每条都做过注入验证（改回旧写法即变红），见提交说明。

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
const ROOT = path.resolve('.');

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

// React 的最小 hook 替身：只让 useChatTts 这类「自包含 hook」能在 Node 里被调用一次。
// useEffect 同步执行一次（hook 里那条 effect 只做 ref 同步，同步跑等价于挂载后跑），
// 否则 ref 永远停在初值、测出来的就不是真实行为。stateSeeds 用于模拟「父组件已经把
// 全局 TTS 设置灌进来」这一步（真实调用方是 ChatScreen，Node 里跑不起来）。
// 不是领域对象的假实现——被测模块（useChatTts / 解析层 / 存储）全部是真的。
let stateSeeds = [];
const fakeReact = {
  useState: initial => [
    stateSeeds.length > 0 ? stateSeeds.shift() : (typeof initial === 'function' ? initial() : initial),
    () => {},
  ],
  useRef: initial => ({ current: initial }),
  useCallback: fn => fn,
  useEffect: fn => { fn(); },
  useMemo: fn => fn(),
};
// 与 seedGlobals() 里的全局 TTS 设置一致（模拟 ChatScreen 灌进来的那一份）。
const seedGlobalTtsState = () => {
  stateSeeds = [{
    autoBroadcast: false,
    activeProvider: 'siliconflow',
    providers: { siliconflow: { apiKey: 'sk-tts', model: 'tts-model', voice: 'global-voice' } },
  }];
};

// ---- 记录型叶子替身 ----
const spoken = [];
const synthesized = [];
const ttsEngineStub = {
  speak: async args => { spoken.push(args); },
  synthesize: async args => { synthesized.push(args); return { mode: 'audio', base64: 'QUJD', mime: 'audio/mp3' }; },
  stop: async () => {},
  isSystemProvider: provider => String((provider && provider.engine) || '') === 'system',
};
const engine = { planCalls: [], fileCalls: [] };
const imageRecognitionStub = {
  decideAttachOriginal: () => false,
  decideImageRecognitionAction: () => 'continue',
  resolveImageRecognitionPlan: async settings => {
    engine.planCalls.push(settings);
    return { ready: true, reason: '', settings, config: { id: String((settings && settings.apiConfigId) || '') } };
  },
  describeImageFiles: async (uris, options) => {
    engine.fileCalls.push({ uris, options });
    return {
      descriptions: (Array.isArray(uris) ? uris : []).map(uri => ({ sourceUri: uri, description: '描述' })),
      failureCount: 0,
      skipped: false,
      attachOriginal: false,
      reason: '',
    };
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: AsyncStorage };
  if (request === 'expo-secure-store') return { __esModule: true, ...SecureStore };
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
    return { __esModule: true, ...FileSystem };
  }
  if (request === 'expo-sqlite') return { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };
  if (request === 'react') return { __esModule: true, ...fakeReact };
  if (request === 'react-native') return { __esModule: true, Alert: { alert: () => {} } };
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  if (request.endsWith('/i18n/I18nContext.js')) {
    return { __esModule: true, useTranslation: () => ({ t: key => String(key) }) };
  }
  if (request.endsWith('/tts/index.js')) return { __esModule: true, ...ttsEngineStub };
  if (request.endsWith('/imageRecognition/index.js')) return { __esModule: true, ...imageRecognitionStub };
  if (request.endsWith('/storage/settings.js')) {
    return { __esModule: true, saveTtsSettings: async settings => settings };
  }
  if (request.endsWith('/storage/mediaProtection.js')) {
    return { __esModule: true, markMediaWrite: () => {}, isRecentMediaUri: () => false };
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

const runtime = loadModule(path.resolve('src/character/runtimeConfig.js'));
const overridesStore = loadModule(path.resolve('src/storage/characterOverrides.js'));
const { saveApiConfigs } = loadModule(path.resolve('src/storage/apiConfigs.js'));
const { saveTtsSettings, saveTranscriptionSettings } = loadModule(path.resolve('src/storage/settings/tts.js'));
const { saveImageRecognitionSettings } = loadModule(path.resolve('src/storage/settings/imageRecognition.js'));
const { applyImageRecognitionToMessages } = loadModule(path.resolve('src/chat/imageRecognitionSend.js'));
const useChatTts = loadModule(path.resolve('src/chat/useChatTts.js')).default;

async function seedGlobals() {
  store.clear();
  secure.clear();
  spoken.length = 0;
  synthesized.length = 0;
  engine.planCalls.length = 0;
  engine.fileCalls.length = 0;
  await saveApiConfigs([
    { id: 'cfg-global', name: '全局配置', baseUrl: 'https://global.example/v1', apiKey: 'sk-global', models: ['global-model'], activeModel: 'global-model' },
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

const imageMessage = () => [{ id: 'm1', image: { uri: 'file:///a.jpg' } }];

// ---- 3. 语音转文字消费点 ----
test('转写消费点：有专属转写配置时用它（含专属密钥来源）', async () => {
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', { transcriptionConfigId: 'tr-char' });
  const target = await runtime.resolveCharacterTranscription('c1');
  assert.equal(target.source, 'dedicated');
  assert.equal(target.baseUrl, 'https://tr2.example/v1/audio/transcriptions');
  assert.equal(target.model, 'whisper-large');
  assert.equal(target.apiKey, 'sk-tr2', '密钥仍来自既有转写配置（本域不新增密钥字段）');
});

test('转写消费点：没有专属配置时回落全局；专属配置被删也回落全局', async () => {
  await seedGlobals();
  const fallback = await runtime.resolveCharacterTranscription('c1');
  assert.equal(fallback.source, 'dedicated');
  assert.equal(fallback.baseUrl, 'https://tr.example/v1/audio/transcriptions', '无覆盖 = 全局转写配置');

  await overridesStore.saveCharacterOverrides('c1', { transcriptionConfigId: 'tr-deleted' });
  const afterDelete = await runtime.resolveCharacterTranscription('c1');
  assert.equal(afterDelete.baseUrl, 'https://tr.example/v1/audio/transcriptions', '指向已删配置 → 回落全局（不报错）');
});

test('转写消费点：全局没有独立转写配置时，「复用聊天来源」跟着角色的专属聊天 API', async () => {
  await seedGlobals();
  await saveTranscriptionSettings({ activeId: '', configs: [] });
  await overridesStore.saveCharacterOverrides('c1', { chatApiConfigId: 'cfg-char' });
  const target = await runtime.resolveCharacterTranscription('c1');
  assert.equal(target.source, 'reused');
  assert.equal(target.baseUrl, 'https://char.example/v1', '复用来源用的是专属聊天配置，不是全局那条');
  assert.equal(target.apiKey, 'sk-char');
});

// ---- 2. OCR 消费点 ----
test('OCR 消费点：转给识别引擎的 settings 是角色生效值（专属配置 + 专属模型）', async () => {
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', {
    ocrApiConfigId: 'cfg-ocr',
    ocrModel: 'ocr-model-2',
  });
  const settings = await runtime.resolveCharacterOcrSettings('c1');
  await applyImageRecognitionToMessages(imageMessage(), { settings });

  assert.equal(engine.fileCalls.length, 1, '必须真的走到识别引擎');
  assert.equal(engine.fileCalls[0].options.settings.apiConfigId, 'cfg-ocr');
  assert.equal(engine.fileCalls[0].options.settings.model, 'ocr-model-2');
  assert.equal(engine.fileCalls[0].options.settings.enabled, true, '总开关仍取全局');
});

test('OCR 消费点：无覆盖时转给引擎的是全局设置（零行为变化）；指向已删配置同样回落', async () => {
  await seedGlobals();
  const global = await runtime.resolveCharacterOcrSettings('c1');
  await applyImageRecognitionToMessages(imageMessage(), { settings: global });
  assert.equal(engine.fileCalls[0].options.settings.apiConfigId, 'cfg-global');
  assert.equal(engine.fileCalls[0].options.settings.model, 'global-ocr-model');

  await overridesStore.saveCharacterOverrides('c1', { ocrApiConfigId: 'cfg-deleted' });
  engine.fileCalls.length = 0;
  const afterDelete = await runtime.resolveCharacterOcrSettings('c1');
  await applyImageRecognitionToMessages(imageMessage(), { settings: afterDelete });
  assert.equal(engine.fileCalls[0].options.settings.apiConfigId, 'cfg-global', '失效的覆盖回落全局');
});

// ---- 1. TTS + 音声消费点 ----
test('TTS 消费点：播报交给引擎的是角色专属 provider 与专属音声', async () => {
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', {
    ttsProviderId: 'stepfun',
    ttsVoice: 'char-voice',
  });
  seedGlobalTtsState();
  const tts = useChatTts({ characterId: 'c1' });
  await tts.broadcastMessage('你好', 'manual');

  assert.equal(spoken.length, 1, '必须真的调用引擎播报');
  assert.equal(spoken[0].provider.id, 'stepfun', '引擎拿到的是专属 provider');
  assert.equal(spoken[0].config.voice, 'char-voice', '引擎拿到的是专属音声');
  assert.equal(spoken[0].config.apiKey, 'sk-step', '密钥仍来自既有 provider 配置');
});

test('TTS 消费点：无覆盖时用全局 provider 与全局音色（零行为变化）', async () => {
  await seedGlobals();
  seedGlobalTtsState();
  const tts = useChatTts({ characterId: 'c1' });
  await tts.broadcastMessage('你好', 'manual');
  assert.equal(spoken[0].provider.id, 'siliconflow');
  assert.equal(spoken[0].config.voice, 'global-voice');
});

test('TTS 消费点：专属 provider 被删 → 回落全局 provider，专属音声一并丢弃', async () => {
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', {
    ttsProviderId: 'provider-deleted',
    ttsVoice: 'char-voice',
  });
  seedGlobalTtsState();
  const tts = useChatTts({ characterId: 'c1' });
  await tts.broadcastMessage('你好', 'manual');
  assert.equal(spoken[0].provider.id, 'siliconflow', '回落全局 provider');
  assert.equal(
    spoken[0].config.voice,
    'global-voice',
    '音色 id 属于被删的那个 provider，套到回落 provider 上只会报「音色不存在」，故一并丢弃'
  );
});

test('TTS 消费点：只配了音声（不换 provider）→ 覆盖到全局 provider 上', async () => {
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', { ttsVoice: 'char-voice' });
  seedGlobalTtsState();
  const tts = useChatTts({ characterId: 'c1' });
  await tts.broadcastMessage('你好', 'manual');
  assert.equal(spoken[0].provider.id, 'siliconflow');
  assert.equal(spoken[0].config.voice, 'char-voice');
});

test('TTS 消费点：语音形态合成（synthesizeVoice）走同一份专属配置', async () => {
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', { ttsProviderId: 'stepfun', ttsVoice: 'char-voice' });
  seedGlobalTtsState();
  const tts = useChatTts({ characterId: 'c1' });
  const file = await tts.synthesizeVoice('m1', '回复文本');
  assert.ok(file && file.uri, '合成成功时返回落盘结果');
  assert.equal(synthesized.length, 1);
  assert.equal(synthesized[0].provider.id, 'stepfun');
  assert.equal(synthesized[0].config.voice, 'char-voice');
});

// ---- 4. 聊天 API 消费点 ----
test('聊天 API 消费点：getCharacterApiConfigs 的 activeId/activeModel/请求覆盖片段按专属口径', async () => {
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', {
    chatApiConfigId: 'cfg-char',
    chatModel: 'char-model-2',
  });
  const adapted = await runtime.getCharacterApiConfigs('c1');
  assert.equal(adapted.activeId, 'cfg-char');
  assert.deepEqual(adapted.chatRequestOptions, { configId: 'cfg-char', model: 'char-model-2' });
  const current = adapted.configs.find(item => item.id === adapted.activeId);
  assert.equal(current.activeModel, 'char-model-2');
});

test('聊天 API 消费点：无覆盖时与 getApiConfigs() 完全一致（零行为变化）', async () => {
  await seedGlobals();
  const adapted = await runtime.getCharacterApiConfigs('c1');
  const global = await loadModule(path.resolve('src/storage/apiConfigs.js')).getApiConfigs();
  assert.equal(adapted.activeId, global.activeId);
  assert.deepEqual(
    adapted.configs.map(item => ({ id: item.id, activeModel: item.activeModel })),
    global.configs.map(item => ({ id: item.id, activeModel: item.activeModel }))
  );
  assert.deepEqual(adapted.chatRequestOptions, {}, '无覆盖时不给请求覆盖片段');
});

test('聊天 API 消费点：专属配置被删 → activeId 回落全局且不带请求覆盖片段', async () => {
  await seedGlobals();
  await overridesStore.saveCharacterOverrides('c1', { chatApiConfigId: 'cfg-deleted', chatModel: 'x' });
  const adapted = await runtime.getCharacterApiConfigs('c1');
  assert.equal(adapted.activeId, 'cfg-global');
  assert.deepEqual(adapted.chatRequestOptions, {}, '失效的覆盖不得进请求选项');
});

// ---- 接线钉（最小）：Node 里跑不起来的 RN 屏幕仍必须从解析层取 ----
// 行为侧已由上面的消费点测试与 tests/characterRuntimeConfig.test.mjs 覆盖；这里只钉
// 「这一处没被改回自己读全局」，每条都做过注入验证（改回旧写法即红）。
test('接线：四类消费点都从唯一解析层取，且不再自己读全局', () => {
  const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const chatSend = read('src/chat/useChatSend.js');
  assert.ok(chatSend.includes("from '../character/runtimeConfig.js'"), 'useChatSend 必须引入解析层');
  assert.ok(chatSend.includes('getCharacterApiConfigs('), '聊天 API 走解析层');
  assert.ok(chatSend.includes('resolveCharacterOcrSettings('), 'OCR 走解析层');
  assert.equal(chatSend.includes('getApiConfigs('), false, '不得再自己读全局 API 配置表');

  const chatScreen = read('src/ChatScreen.js');
  assert.ok(chatScreen.includes('resolveCharacterTranscription('), '聊天页转写走解析层');
  assert.equal(chatScreen.includes('getTranscriptionSettings'), false, '不得再自己读全局转写设置');

  const chatPanel = read('src/workspace/screen/ChatPanel.js');
  assert.ok(chatPanel.includes('resolveCharacterTranscription('), '工作区转写走解析层');
  // FEAT-AC12：工作区回合的**请求装配**已外提到 chatPanelRequest.js（行数棘轮），
  // 所以解析层调用点在新文件里。两文件合读，判据不变（仍要求走解析层）。
  const chatPanelTurn = chatPanel + read('src/workspace/screen/chatPanelRequest.js');
  assert.ok(chatPanelTurn.includes('getCharacterApiConfigs('), '工作区对话走解析层');
  assert.equal(chatPanelTurn.includes('getTranscriptionSettings'), false, '不得再自己读全局转写设置');

  const chatTts = read('src/chat/useChatTts.js');
  assert.ok(chatTts.includes('resolveCharacterTtsSpeak('), 'TTS 走解析层');
  assert.equal(chatTts.includes('getTtsProvider('), false, '不得再自己按全局 activeProvider 取 provider');

  const screenWatch = read('src/screenWatch/useScreenWatchComments.js');
  assert.ok(screenWatch.includes('resolveCharacterOcrSettings('), '看屏幕 OCR 走解析层');
  assert.ok(screenWatch.includes('getCharacterApiConfigs('), '看屏幕的视觉门控按角色生效配置判定');
});

test('接线：角色编辑页装配了「专属配置」折叠区', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/character/CharacterDetailScreen.js'), 'utf8');
  assert.ok(source.includes("from './CharacterOverridesSection.js'"), '必须引入专属配置组件');
  assert.ok(source.includes('<CharacterOverridesSection characterId='), '必须装配它并带上角色 id');
});

// P1-4 的结构回归锚。仓库没有组件渲染基建（react-native 在 Node 下 import 不进来），
// 所以照 tests/uiSheet.test.mjs 的两层法：**行为**由 storage 侧的
// getCharacterOverridesStatus 三态测试覆盖（tests/characterRuntimeConfig.test.mjs），
// 这里只钉「界面不得再把读失败当成没配过」这个已修复的回归。
test('P1-4 结构锚：专属配置读失败必须明说，不得当成「没配过」', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/character/CharacterOverridesSection.js'), 'utf8');
  assert.ok(source.includes('getCharacterOverridesStatus(id)'), '必须走三态读（ok/missing/corrupt）');
  assert.equal(
    source.includes('getCharacterOverrides(id)'),
    false,
    '不得再用「读不到就 catch 成 null → 按空覆盖渲染」的旧写法（读失败会静默显示成「配过 0 项」）'
  );
  assert.ok(source.includes('if (loadFailed)'), '读失败必须走单独分支');
  assert.ok(
    source.includes("t('character.overrides.loadFailed')"),
    '读失败必须渲染可见提示（与 saveFailed 同族），绝不静默留白'
  );
});
