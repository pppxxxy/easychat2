// 模型档案（modelProfiles）测试：家族识别 + 上下文窗口兜底 + resolveContextWindow 集成。
import test from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_PROFILES, resolveModelProfile, modelContextWindow } from '../src/network/modelProfiles.js';
import { resolveContextWindow, DEFAULT_CONTEXT_WINDOW } from '../src/chat/contextUsage.js';

test('resolveModelProfile：识别主流家族', () => {
  assert.equal(resolveModelProfile('claude-3-5-sonnet-20241022').id, 'claude');
  assert.equal(resolveModelProfile('gpt-4o').id, 'gpt');
  assert.equal(resolveModelProfile('o1-mini').id, 'gpt');
  assert.equal(resolveModelProfile('gemini-2.0-flash').id, 'gemini');
  assert.equal(resolveModelProfile('deepseek-chat').id, 'deepseek');
  assert.equal(resolveModelProfile('glm-4-plus').id, 'glm');
  assert.equal(resolveModelProfile('qwen-max').id, 'qwen');
  assert.equal(resolveModelProfile('moonshot-v1-128k').id, 'kimi');
  assert.equal(resolveModelProfile('grok-2').id, 'grok');
  assert.equal(resolveModelProfile('llama-3.1-70b').id, 'llama');
});

test('resolveModelProfile：认不出返回 null（空值 / 无关名字）', () => {
  assert.equal(resolveModelProfile(''), null);
  assert.equal(resolveModelProfile(null), null);
  assert.equal(resolveModelProfile('my-local-model'), null);
  assert.equal(resolveModelProfile('text-embedding-3'), null);
});

test('modelContextWindow：命中返回家族窗口，未命中返回 fallback', () => {
  assert.equal(modelContextWindow('claude-3-5-sonnet'), 200000);
  assert.equal(modelContextWindow('gemini-1.5-pro'), 1000000);
  assert.equal(modelContextWindow('unknown', 0), 0);
  assert.equal(modelContextWindow('unknown', 64000), 64000);
});

test('档案完备：id 唯一、match 是正则、窗口为正', () => {
  const ids = new Set();
  for (const profile of MODEL_PROFILES) {
    assert.equal(ids.has(profile.id), false, `重复 id：${profile.id}`);
    ids.add(profile.id);
    assert.ok(profile.match instanceof RegExp, `${profile.id} 的 match 必须是正则`);
    assert.ok(profile.contextWindow > 0, `${profile.id} 窗口必须为正`);
  }
});

test('resolveContextWindow：声明 > 本地 > 模型家族 > 默认', () => {
  assert.equal(resolveContextWindow({ declared: 8000 }), 8000);
  assert.equal(resolveContextWindow({ declared: 0, localContextSize: 4096, model: 'claude-3' }), 4096, '本地优先于家族');
  assert.equal(resolveContextWindow({ declared: 0, model: 'gemini-1.5-pro' }), 1000000, '未声明时按家族兜底');
  assert.equal(resolveContextWindow({ model: 'no-such-model' }), DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolveContextWindow({}), DEFAULT_CONTEXT_WINDOW);
});
