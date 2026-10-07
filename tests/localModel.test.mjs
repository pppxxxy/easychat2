import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOCAL_MODEL_ITEM,
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
  applyLocalModelParamPreset,
  contextSizeMemoryDelta,
  LOCAL_MODEL_PARAM_PRESETS,
} from '../src/localModel/modelParams.js';
import {
  getResourceOwner,
  resetResourceMutexForTests,
  tryAcquireResource,
  withResource,
} from '../src/resourceMutex.js';
import { canUseLocalModel, resolveLocalModelReadiness, sendWithModelProvider } from '../src/network/modelProvider.js';
import { zhCN } from '../src/i18n/locales/zh-CN.js';

test('normalizeLocalModelSettings：非法值回退安全默认值', () => {
  const settings = normalizeLocalModelSettings({ enabled: true, modelId: 'q4', contextSize: 1, gpuLayers: -2 });
  assert.equal(settings.enabled, true);
  // v5 Stage A：设置键不再持有 legacy 单模型字段（单一事实源）。
  assert.equal('modelId' in settings, false);
  assert.equal('contextSize' in settings, false);
  assert.equal('gpuLayers' in settings, false);
  assert.deepEqual(settings, {
    enabled: true,
    enableMediaInput: false,
    activeModelId: '',
    apiServer: { enabled: false, host: '127.0.0.1', port: 8080, apiKey: '' },
    schema: 0,
    updatedAt: 0,
  });
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

test('normalizeLocalModelSettings：v2 只保留单一事实源字段', () => {
  const legacy = normalizeLocalModelSettings({ enabled: true, modelId: 'm1', modelPath: 'file:///m1.gguf' });
  assert.equal(legacy.activeModelId, '');
  assert.equal(legacy.apiServer.host, '127.0.0.1');
  assert.equal(legacy.apiServer.enabled, false);
  // legacy 字段不再进入设置对象
  assert.equal('modelPath' in legacy, false);
  assert.equal('modelId' in legacy, false);
  assert.equal(normalizeLocalModelSettings({ activeModelId: ' a ' }).activeModelId, 'a');
  assert.equal(normalizeLocalModelSettings({ schema: 2 }).schema, 2);
  assert.equal(normalizeLocalModelSettings({ schema: 'x' }).schema, 0);
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

test('applyLocalModelParamPreset：覆盖采样字段并保留设备相关字段', () => {
  const base = { contextSize: 8192, gpuLayers: 20, threads: 4, temperature: 1, topP: 1, topK: 0, maxTokens: 512 };
  const chat = applyLocalModelParamPreset(base, 'chat');
  assert.equal(chat.temperature, 0.9);
  assert.equal(chat.topP, 0.95);
  assert.equal(chat.topK, 40);
  // 设备相关字段不动
  assert.equal(chat.contextSize, 8192);
  assert.equal(chat.gpuLayers, 20);
  assert.equal(chat.threads, 4);
  const code = applyLocalModelParamPreset(base, 'code');
  assert.equal(code.temperature, 0.3);
  // 未知预设原样返回（归一化）
  assert.deepEqual(applyLocalModelParamPreset(base, 'nope'), normalizeLocalModelParams(base));
  assert.equal(LOCAL_MODEL_PARAM_PRESETS.length, 3);
});

test('contextSizeMemoryDelta：上下文越大 KV 占用越大', () => {
  const delta = contextSizeMemoryDelta({ paramBillion: 1.5, bitsPerWeight: 4.85, from: 2048, to: 8192 });
  assert.ok(delta.afterBytes > delta.beforeBytes, '更大上下文 KV 占用应更高');
  assert.ok(delta.deltaBytes > 0);
  // 参数规模未知时 KV 估算为 0，不虚报
  const unknown = contextSizeMemoryDelta({ paramBillion: 0, bitsPerWeight: 0, from: 2048, to: 8192 });
  assert.equal(unknown.deltaBytes, 0);
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
  // v5 Stage A：迁移后的设置是 v2 单一事实源，不再镜像 legacy 字段。
  assert.equal('modelPath' in settings, false);
  assert.equal(settings.schema, 2);
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

test('applyActiveLocalModel：选用模型只写 activeModelId（单一事实源）并启用', () => {
  const settings = applyActiveLocalModel(
    { enabled: false },
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
  assert.equal(settings.schema, 2);
  assert.equal(settings.updatedAt, 123);
  // 不再镜像 legacy 单模型字段
  assert.equal('modelId' in settings, false);
  assert.equal('modelPath' in settings, false);
  assert.equal('contextSize' in settings, false);
});

test('applyActiveLocalModel：空条目不改动设置；clearActiveLocalModel 回到在线', () => {
  const base = normalizeLocalModelSettings({ enabled: true, activeModelId: 'm1' });
  assert.deepEqual(applyActiveLocalModel(base, {}), base);
  const cleared = clearActiveLocalModel(base, 9);
  assert.equal(cleared.enabled, false);
  assert.equal(cleared.activeModelId, '');
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

test('resolveLocalModelReadiness：模块不可用/未启用/未就绪分级（只认条目）', () => {
  const settings = { enabled: true, activeModelId: 'm' };
  const readyItem = { id: 'm', modelPath: 'file:///m.gguf', modelBytes: 10 };
  assert.equal(resolveLocalModelReadiness({ settings, moduleAvailable: false }).reason, 'unavailable');
  assert.equal(resolveLocalModelReadiness({ settings: { ...settings, enabled: false }, moduleAvailable: true }).reason, 'disabled');
  // v5 Stage A：无条目即未就绪，不再回退设置里的 legacy 单模型字段
  assert.equal(resolveLocalModelReadiness({ settings, moduleAvailable: true, fileInfo: { exists: true, size: 10 } }).reason, 'not-ready');
  assert.equal(resolveLocalModelReadiness({ settings, item: readyItem, moduleAvailable: true, fileInfo: { exists: true, size: 10 } }).ready, true);
  assert.equal(resolveLocalModelReadiness({ settings, item: readyItem, moduleAvailable: true, fileInfo: { exists: false } }).reason, 'not-ready');
});

test('本地模型面板：展示并支持复制以 /v1 结尾的本地地址', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  // Phase 2 拆分后地址/复制实现位于 useApiServer
  const panel = fs.readFileSync(path.join(HERE, '..', 'src', 'localModel', 'panel', 'useApiServer.js'), 'utf8');
  // 使用剪贴板复制（与诊断/生图面板一致的约定）
  assert.ok(panel.includes("import * as Clipboard from 'expo-clipboard'"), '应引入剪贴板');
  assert.ok(panel.includes('Clipboard.setStringAsync(apiAddress)'), '复制内容应为本地地址');
  // 地址始终以 /v1 结尾，且默认端口兜底 8080
  assert.ok(panel.includes('`http://127.0.0.1:${effectivePort}/v1`'), '地址格式应为 http://127.0.0.1:端口/v1');
  assert.ok(panel.includes('effectivePort'), '应有端口兜底');
  // 运行中以实际端口为准（可能与配置端口不同）
  assert.ok(panel.includes('apiStatus.running && apiStatus.port ? apiStatus.port : apiServer.port'), '运行中应以实际端口为准');
  assert.ok(panel.includes('const copyApiAddress'), '应有复制处理函数');
  // 点击地址栏可复制（渲染在 ApiServerSection）
  const section = fs.readFileSync(path.join(HERE, '..', 'src', 'localModel', 'panel', 'ApiServerSection.js'), 'utf8');
  assert.ok(section.includes('onPress={onCopyAddress}'), '地址栏应可点击复制');
});

test('适配器：跨对话清 KV cache、思考流拆分与面板加载按钮（源码守护）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const read = name => fs.readFileSync(path.join(HERE, '..', 'src', name), 'utf8');

  const adapter = read('localModel/adapter.js');
  // 跨对话必须清 KV cache（llama.rn clearCache 文档要求；否则新对话串上一段对话）
  assert.ok(adapter.includes('await loaded.context.clearCache()'), '会话切换应调用 clearCache');
  assert.ok(adapter.includes('loaded.conversationKey !== nextConversationKey'), '同对话不应重复清缓存');
  // fail-closed（2026-10-05 审核报告）：不传 conversationKey 的路径（总结/群聊/动态回复）
  // 也必须清缓存——没钥匙视为独立对话，宁可损失前缀复用也不串上下文。
  assert.ok(
    adapter.includes('const shouldClearCache = !nextConversationKey'),
    '空 conversationKey 必须也触发清缓存（fail-closed）'
  );
  assert.ok(adapter.includes('export async function clearLocalModelCache'), '应导出手动清缓存入口');
  assert.ok(adapter.includes('export function isLocalModelLoaded'), '应导出已加载判定（面板显示用）');
  // 思考流：<think> 拆分后思考走 onReasoning、正文走 onToken
  assert.ok(adapter.includes('createThinkSplitter()'), '推理回调应使用 think 拆分器');
  assert.ok(adapter.includes('onReasoning(splitter.reasoning())'), '思考应走 onReasoning');
  assert.ok(adapter.includes('onToken(splitter.text())'), '正文应走 onToken（已剥离思考）');
  assert.ok(adapter.includes('const split = splitThinkContent(rawText)'), '最终文本也要剥离思考标签');

  const provider = read('network/modelProvider.js');
  assert.ok(provider.includes('onReasoning,'), '路由层应透传 onReasoning');
  assert.ok(provider.includes('conversationKey,'), '路由层应透传 conversationKey');

  // 会话标识与本地 onReasoning 已随 requestReply 外提至 useChatSend
  const chat = read('chat/useChatSend.js');
  assert.ok(chat.includes('conversationKey: String((sessionGuard && sessionGuard.sessionId)'), '本地推理应传会话标识');
  // 本地思考与在线 onReasoning 同构：覆写 reasoning、不动 pending
  // （外提后覆写经 replyFlow 的 mergeStreamedReasoning 纯函数完成）
  const localReasoning = chat.match(/onReasoning: fullReasoning => \{[\s\S]{0,600}?\},\n\s*onlineSend/);
  assert.ok(localReasoning, '本地路径应有 onReasoning 处理器');
  assert.ok(
    localReasoning[0].includes('reasoning: fullReasoning')
      || localReasoning[0].includes('mergeStreamedReasoning(current, pendingAssistantMessage.id, fullReasoning)'),
    '本地思考应写入 reasoning 字段'
  );

  // Phase 2 拆分后加载逻辑在 usePanelModels，行渲染在 ModelsSection
  const panel = read('localModel/panel/usePanelModels.js');
  const section = read('localModel/panel/ModelsSection.js');
  // 面板加载按钮：进度百分比、已加载态、互斥锁
  assert.ok(panel.includes('const handleLoadModel = useCallback'), '应有面板加载处理函数');
  assert.ok(panel.includes("tryAcquireResource('local-model')"), '加载应走 local-model 互斥锁');
  assert.ok(panel.includes('onProgress: p => setLoadProgress'), '应接线加载进度');
  assert.ok(section.includes("t('localModel.loading', { progress: loadProgress })"), '按钮应引用加载百分比的 i18n 键');
  assert.ok(zhCN['localModel.loading'].includes('{progress}%'), '语言包中文值正确');
  assert.ok(section.includes("t('localModel.loaded')"), '按钮应引用已加载态的 i18n 键');
  assert.equal(zhCN['localModel.loaded'], '已加载', '语言包中文值正确');
  assert.ok(section.includes('loadProgressBar'), '应有进度条');
  // 当前选用标识：名称行 badge + 已选用按钮态（原勾图标随 U6 行长按化退役）
  assert.ok(section.includes("t('localModel.currentSuffix')"), '当前模型名称行应有「· 当前」标识');
  assert.ok(section.includes("t('localModel.selected')"), '当前模型按钮应为「已选用」态');
});

test('adapter 参数构造：buildContextParams/buildCompletionParams 纯函数', async () => {
  const { buildContextParams, buildCompletionParams } = await import('../src/localModel/adapter.js');
  const model = {
    modelPath: 'file:///m/q4.gguf',
    contextSize: 4096,
    gpuLayers: 12,
    params: { maxTokens: 256, temperature: 0.7, topP: 0.9, topK: 40, threads: 6 },
  };
  const ctx = buildContextParams(model);
  assert.equal(ctx.model, 'file:///m/q4.gguf');
  assert.equal(ctx.n_ctx, 4096);
  assert.equal(ctx.n_gpu_layers, 12);
  assert.equal(ctx.use_mlock, true);

  const completion = buildCompletionParams(model);
  assert.equal(completion.n_predict, 256);
  assert.equal(completion.temperature, 0.7);
  assert.equal(completion.top_p, 0.9);
  assert.equal(completion.n_threads, 6);

  const overridden = buildCompletionParams(model, { maxTokens: 64, temperature: 0.2 });
  assert.equal(overridden.n_predict, 64);
  assert.equal(overridden.temperature, 0.2);
});
