import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOCAL_MODEL_ITEM,
  DEFAULT_LOCAL_MODEL_SETTINGS,
  LOCAL_MODEL_DOWNLOAD_SOURCES,
  LOCAL_MODEL_INDEX_KEY,
  LOCAL_MODEL_ITEM_PREFIX,
  LOCAL_MODEL_SETTINGS_KEY,
  applyActiveLocalModel,
  buildModelDownloadUrl,
  buildLocalModelItem,
  clearActiveLocalModel,
  getLocalModelMediaCapabilities,
  isLocalModelItemReady,
  isLocalModelReady,
  localModelCapabilities,
  localModelIdFromFileName,
  localModelIndexEntry,
  localModelPath,
  migrateLegacyLocalModelSettings,
  normalizeLocalModelApiServer,
  normalizeLocalModelIndexEntry,
  normalizeLocalModelItem,
  normalizeLocalModelSettings,
} from '../src/localModel/modelState.js';
import {
  DEFAULT_LOCAL_MODEL_PARAMS,
  LOCAL_MODEL_PARAM_FIELDS,
  normalizeLocalModelParams,
  validateLocalModelParams,
} from '../src/localModel/modelParams.js';
import {
  getResourceOwner,
  resetResourceMutexForTests,
  tryAcquireResource,
  withResource,
} from '../src/resourceMutex.js';
import { canUseLocalModel, resolveLocalModelReadiness, sendWithModelProvider } from '../src/modelProvider.js';

test('normalizeLocalModelSettings：非法值回退安全默认值', () => {
  const settings = normalizeLocalModelSettings({ enabled: true, modelId: 'q4', contextSize: 1, gpuLayers: -2 });
  assert.equal(settings.enabled, true);
  assert.equal(settings.contextSize, 512);
  assert.equal(settings.gpuLayers, 0);
  assert.equal(normalizeLocalModelSettings(null).modelId, DEFAULT_LOCAL_MODEL_SETTINGS.modelId);
});

test('模型下载源预设包含 Hugging Face 与 hf-mirror，并可拼接仓库路径', () => {
  const ids = LOCAL_MODEL_DOWNLOAD_SOURCES.map(source => source.id);
  assert.ok(ids.includes('huggingface'));
  assert.ok(ids.includes('hf-mirror'));
  const mirror = LOCAL_MODEL_DOWNLOAD_SOURCES.find(source => source.id === 'hf-mirror');
  assert.equal(mirror.baseUrl, 'https://hf-mirror.com');
  assert.equal(
    buildModelDownloadUrl('https://hf-mirror.com', 'Qwen/model/resolve/main/m.gguf'),
    'https://hf-mirror.com/Qwen/model/resolve/main/m.gguf'
  );
  assert.equal(buildModelDownloadUrl('', 'x'), '');
});

test('localModelPath：模型 id 被限制为安全文件名', () => {
  assert.match(localModelPath('Qwen/Model:v1'), /Qwen_Model_v1\.gguf$/);
});

test('isLocalModelReady：需要启用、路径和存在文件', () => {
  const base = { enabled: true, modelId: 'm1', modelPath: 'file:///m1.gguf', modelBytes: 10 };
  assert.equal(isLocalModelReady(base, { exists: true, size: 10 }), true);
  assert.equal(isLocalModelReady({ ...base, enabled: false }, { exists: true, size: 10 }), false);
  assert.equal(isLocalModelReady(base, { exists: true, size: 9 }), false);
  assert.equal(isLocalModelReady(base, { exists: false }), false);
});

test('resourceMutex：同一时刻只允许一个资源持有者', async () => {
  resetResourceMutexForTests();
  const release = tryAcquireResource('local-model');
  assert.equal(getResourceOwner(), 'local-model');
  assert.equal(tryAcquireResource('tts'), null);
  release();
  assert.equal(getResourceOwner(), '');
  await withResource('recording', async () => assert.equal(getResourceOwner(), 'recording'));
  assert.equal(getResourceOwner(), '');
});

test('modelProvider：本地不可用时走在线，本地异常时只回退一次', async () => {
  let onlineCalls = 0;
  const onlineSend = async () => {
    onlineCalls += 1;
    return 'online';
  };
  assert.equal(canUseLocalModel({ enabled: true, modelId: 'm', modelPath: 'file:///m' }, { exists: true }), false);
  assert.equal(await sendWithModelProvider({
    messages: [],
    localSettings: { enabled: false },
    onlineSend,
  }), 'online');
  assert.equal(onlineCalls, 1);
});

test('normalizeLocalModelSettings：补全多模型字段并保留旧单模型字段', () => {
  const legacy = normalizeLocalModelSettings({ enabled: true, modelId: 'm1', modelPath: 'file:///m1.gguf' });
  assert.equal(legacy.activeModelId, '');
  assert.equal(legacy.apiServer.host, '127.0.0.1');
  assert.equal(legacy.apiServer.enabled, false);
  assert.equal(legacy.modelPath, 'file:///m1.gguf');
  assert.equal(normalizeLocalModelSettings({ activeModelId: ' a ' }).activeModelId, 'a');
  assert.deepEqual(normalizeLocalModelSettings(null).apiServer, { enabled: false, host: '127.0.0.1', port: 8080, apiKey: '' });
});

test('normalizeLocalModelSettings：enableMediaInput 默认关且可开启', () => {
  assert.equal(normalizeLocalModelSettings({}).enableMediaInput, false);
  assert.equal(normalizeLocalModelSettings({ enableMediaInput: true }).enableMediaInput, true);
  assert.equal(normalizeLocalModelSettings(null).enableMediaInput, false);
});

test('normalizeLocalModelApiServer：host 固定回环，端口越界回退 8080', () => {
  assert.equal(normalizeLocalModelApiServer({ host: '0.0.0.0', port: 3000, apiKey: 'k' }).host, '127.0.0.1');
  assert.equal(normalizeLocalModelApiServer({ port: 70000 }).port, 8080);
  assert.equal(normalizeLocalModelApiServer({ port: 'abc' }).port, 8080);
  assert.equal(normalizeLocalModelApiServer({ port: 1234, apiKey: 'k' }).port, 1234);
  assert.equal(normalizeLocalModelApiServer({ apiKey: 5 }).apiKey, '5');
});

test('normalizeLocalModelParams：非法与越界值回退/夹取到合法范围', () => {
  const params = normalizeLocalModelParams({
    contextSize: 1,
    gpuLayers: -2,
    temperature: 5,
    topP: 'x',
    maxTokens: 999999999,
  });
  assert.equal(params.contextSize, 512);
  assert.equal(params.gpuLayers, 0);
  assert.equal(params.temperature, 2);
  assert.equal(params.topP, DEFAULT_LOCAL_MODEL_PARAMS.topP);
  assert.equal(params.maxTokens, LOCAL_MODEL_PARAM_FIELDS.maxTokens.max);
  assert.deepEqual(normalizeLocalModelParams(null), DEFAULT_LOCAL_MODEL_PARAMS);
});

test('validateLocalModelParams：空值放过，非数字与越界报错', () => {
  assert.equal(validateLocalModelParams({}).valid, true);
  assert.equal(validateLocalModelParams({ contextSize: '' }).valid, true);
  const bad = validateLocalModelParams({ contextSize: 10, temperature: 'hot' });
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.errors.map(item => item.field).sort(), ['contextSize', 'temperature']);
});

test('normalizeLocalModelItem：非负字段、布尔与 params 均被规范化', () => {
  const item = normalizeLocalModelItem({
    id: ' m ',
    modelBytes: -1,
    paramSize: -2,
    imported: 'yes',
    hasVision: 1,
    mmprojBytes: 3.9,
    params: { gpuLayers: -5 },
  });
  assert.equal(item.id, 'm');
  assert.equal(item.modelBytes, 0);
  assert.equal(item.paramSize, 0);
  assert.equal(item.imported, false);
  assert.equal(item.hasVision, false);
  assert.equal(item.mmprojBytes, 3);
  assert.equal(item.params.gpuLayers, 0);
  assert.equal(item.version, DEFAULT_LOCAL_MODEL_ITEM.version);
  assert.deepEqual(normalizeLocalModelItem(null).params, DEFAULT_LOCAL_MODEL_PARAMS);
});

test('localModelIndexEntry：只保留列表渲染所需轻量字段', () => {
  const entry = localModelIndexEntry(normalizeLocalModelItem({
    id: 'm1',
    name: 'Qwen',
    quant: 'Q4_K_M',
    paramSize: 1.5,
    modelBytes: 100,
    hasVision: true,
    modelPath: 'file:///m1.gguf',
    params: { contextSize: 4096 },
    createdAt: 10,
    updatedAt: 20,
  }));
  assert.deepEqual(entry, {
    id: 'm1',
    name: 'Qwen',
    quant: 'Q4_K_M',
    paramSize: 1.5,
    modelBytes: 100,
    hasVision: true,
    hasAudio: false,
    imported: false,
    addedAt: 10,
    updatedAt: 20,
  });
  assert.equal('modelPath' in entry, false);
  assert.deepEqual(normalizeLocalModelIndexEntry(entry), entry);
});

test('isLocalModelItemReady：需要 id、路径且文件大小一致', () => {
  const item = { id: 'm1', modelPath: 'file:///m1.gguf', modelBytes: 10 };
  assert.equal(isLocalModelItemReady(item, { exists: true, size: 10 }), true);
  assert.equal(isLocalModelItemReady({ ...item, id: '' }, { exists: true, size: 10 }), false);
  assert.equal(isLocalModelItemReady({ ...item, modelPath: '' }, { exists: true, size: 10 }), false);
  assert.equal(isLocalModelItemReady(item, { exists: false }), false);
  assert.equal(isLocalModelItemReady(item, { exists: true, size: 9 }), false);
});

test('migrateLegacyLocalModelSettings：旧单模型转成条目并回填 activeModelId', () => {
  const { settings, item } = migrateLegacyLocalModelSettings({
    enabled: true,
    modelId: 'qwen-q4',
    modelName: 'Qwen Q4',
    modelUrl: 'https://example.com/q.gguf',
    modelPath: 'file:///documents/local-models/qwen-q4.gguf',
    modelBytes: 123,
    contextSize: 4096,
    gpuLayers: 20,
    updatedAt: 99,
  });
  assert.equal(settings.activeModelId, 'qwen-q4');
  assert.equal(settings.enabled, true);
  assert.equal(settings.modelPath, 'file:///documents/local-models/qwen-q4.gguf');
  assert.equal(item.id, 'qwen-q4');
  assert.equal(item.name, 'Qwen Q4');
  assert.equal(item.params.contextSize, 4096);
  assert.equal(item.params.gpuLayers, 20);
  assert.equal(item.createdAt, 99);
});

test('migrateLegacyLocalModelSettings：无旧模型时只迁移设置结构', () => {
  const { settings, item } = migrateLegacyLocalModelSettings({ enabled: false });
  assert.equal(item, null);
  assert.equal(settings.activeModelId, '');
  assert.equal(migrateLegacyLocalModelSettings(null).item, null);
});

test('存储键常量稳定（迁移与分键约定）', () => {
  assert.equal(LOCAL_MODEL_SETTINGS_KEY, '@easychat2_local_model');
  assert.equal(LOCAL_MODEL_INDEX_KEY, '@easychat2_local_model_index');
  assert.equal(LOCAL_MODEL_ITEM_PREFIX, '@easychat2_local_model_item');
});

test('localModelIdFromFileName：去目录、去扩展并转义非法字符', () => {
  assert.equal(localModelIdFromFileName('Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'), 'Qwen2.5-1.5B-Instruct-Q4_K_M');
  assert.equal(localModelIdFromFileName('a/b/model v1.gguf'), 'model_v1');
  assert.equal(localModelIdFromFileName('   '), '');
});

test('buildLocalModelItem：量化/规模按名称与 id 兜底解析，能力按 mmproj 推断', () => {
  const item = buildLocalModelItem({
    id: 'Qwen2.5-1.5B-Instruct-Q4_K_M',
    name: 'Qwen2.5 1.5B',
    modelPath: 'file:///m.gguf',
    modelBytes: 100,
  });
  assert.equal(item.quant, 'Q4_K_M');
  assert.equal(item.paramSize, 1.5);
  assert.equal(item.hasVision, false);
  assert.equal(item.hasAudio, false);

  const vision = buildLocalModelItem({ id: 'v', name: 'V', mmprojPath: 'file:///v.mmproj.gguf' });
  assert.equal(vision.hasVision, true);
  const audio = buildLocalModelItem({ id: 'a', name: 'A', mmprojUrl: 'https://x/audio-mmproj.gguf' });
  assert.equal(audio.hasAudio, true);
  assert.equal(audio.hasVision, false);
});

test('localModelCapabilities：显式标记优先于 mmproj 推断', () => {
  const caps = localModelCapabilities({ mmprojUrl: 'https://x/mmproj.gguf', hasAudio: true });
  assert.equal(caps.hasVision, true);
  assert.equal(caps.hasAudio, true);
});

test('applyActiveLocalModel：选用模型镜像旧单模型字段并启用', () => {
  const settings = applyActiveLocalModel(
    { enabled: false, modelId: 'old', modelPath: 'file:///old.gguf' },
    {
      id: 'new',
      name: 'New',
      modelUrl: 'https://x/new.gguf',
      modelPath: 'file:///new.gguf',
      modelBytes: 42,
      params: { contextSize: 4096, gpuLayers: 20 },
    },
    123
  );
  assert.equal(settings.activeModelId, 'new');
  assert.equal(settings.enabled, true);
  assert.equal(settings.modelId, 'new');
  assert.equal(settings.modelPath, 'file:///new.gguf');
  assert.equal(settings.contextSize, 4096);
  assert.equal(settings.gpuLayers, 20);
  assert.equal(settings.updatedAt, 123);
});

test('applyActiveLocalModel：空条目不改动设置；clearActiveLocalModel 回到在线', () => {
  const base = normalizeLocalModelSettings({ enabled: true, activeModelId: 'm1', modelPath: 'file:///m1.gguf', modelId: 'm1' });
  assert.deepEqual(applyActiveLocalModel(base, {}), base);
  const cleared = clearActiveLocalModel(base, 9);
  assert.equal(cleared.enabled, false);
  assert.equal(cleared.activeModelId, '');
  assert.equal(cleared.modelId, '');
  assert.equal(cleared.modelPath, '');
  assert.equal(cleared.updatedAt, 9);
});

test('getLocalModelMediaCapabilities：本地开关与条目能力共同决定媒体入口', () => {
  const item = { hasVision: true, hasAudio: false };
  assert.deepEqual(
    getLocalModelMediaCapabilities({ enabled: true, enableMediaInput: true }, item),
    { vision: true, audio: false }
  );
  assert.deepEqual(
    getLocalModelMediaCapabilities({ enabled: true, enableMediaInput: false }, item),
    { vision: false, audio: false }
  );
  assert.deepEqual(
    getLocalModelMediaCapabilities({ enabled: false, enableMediaInput: true }, item),
    { vision: false, audio: false }
  );
});

test('resolveLocalModelReadiness：模块不可用/未启用/未就绪分级', () => {
  const settings = { enabled: true, modelId: 'm', modelPath: 'file:///m.gguf', modelBytes: 10 };
  const readyItem = { id: 'm', modelPath: 'file:///m.gguf', modelBytes: 10 };
  assert.equal(resolveLocalModelReadiness({ settings, moduleAvailable: false }).reason, 'unavailable');
  assert.equal(resolveLocalModelReadiness({ settings: { ...settings, enabled: false }, moduleAvailable: true }).reason, 'disabled');
  assert.equal(resolveLocalModelReadiness({ settings, moduleAvailable: true, fileInfo: { exists: true, size: 10 } }).ready, true);
  assert.equal(resolveLocalModelReadiness({ settings, moduleAvailable: true, fileInfo: { exists: true, size: 9 } }).reason, 'not-ready');
  assert.equal(resolveLocalModelReadiness({ settings, item: readyItem, moduleAvailable: true, fileInfo: { exists: true, size: 10 } }).ready, true);
  assert.equal(resolveLocalModelReadiness({ settings, item: readyItem, moduleAvailable: true, fileInfo: { exists: false } }).reason, 'not-ready');
});
