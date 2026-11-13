// 模型探测纯逻辑：候选 URL 与响应解析（口径与 SettingsScreen 的 fetchProviderModels 一致）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  modelListUrls,
  parseModelList,
  probeHeaders,
} from '../../src/settings/modelProbe.js';

test('modelListUrls：裸域名补 /v1，已带 /v1 不重复补', () => {
  assert.deepEqual(modelListUrls('https://api.deepseek.com'), [
    'https://api.deepseek.com/v1/models',
    'https://api.deepseek.com/models',
  ]);
  assert.deepEqual(modelListUrls('https://openrouter.ai/api/v1'), [
    'https://openrouter.ai/api/v1/models',
    'https://openrouter.ai/api/models',
  ]);
});

test('modelListUrls：完整 chat/completions 地址先剥后缀', () => {
  assert.deepEqual(modelListUrls('https://x.com/v1/chat/completions'), [
    'https://x.com/v1/models',
    'https://x.com/models',
  ]);
});

test('parseModelList：按 id 去重并剔除空值', () => {
  const models = parseModelList({
    data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: '' }, {}, null],
  });
  assert.deepEqual(models, ['a', 'b']);
  assert.deepEqual(parseModelList(null), []);
  assert.deepEqual(parseModelList({ data: 'nope' }), []);
});

test('probeHeaders：OpenAI 系用 Bearer，Anthropic 用 x-api-key + version', () => {
  const openai = probeHeaders({ protocol: 'openai', apiKey: ' k ', authHeader: '', authScheme: 'Bearer ' });
  assert.equal(openai.Authorization, 'Bearer k');
  const anthropic = probeHeaders({ protocol: 'anthropic', apiKey: 'k' });
  assert.equal(anthropic['x-api-key'], 'k');
  assert.equal(anthropic['anthropic-version'], '2023-06-01');
  assert.equal(anthropic.Authorization, undefined);
});