import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOCAL_MODEL_SETTINGS,
  LOCAL_MODEL_DOWNLOAD_SOURCES,
  buildModelDownloadUrl,
  isLocalModelReady,
  localModelPath,
  normalizeLocalModelSettings,
} from '../src/localModel/modelState.js';
import {
  getResourceOwner,
  resetResourceMutexForTests,
  tryAcquireResource,
  withResource,
} from '../src/resourceMutex.js';
import { canUseLocalModel, sendWithModelProvider } from '../src/modelProvider.js';

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
