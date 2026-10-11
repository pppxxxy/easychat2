// P0-7 降级链判定层测试（纯函数：不需要网络与 RN）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FALLBACK_MODELS_MAX,
  isRetryableFailure,
  normalizeFallbackModels,
  planFallbackChain,
  shouldFallback,
} from '../src/network/fallbackModels.js';

test('normalizeFallbackModels：字符串/数组都收，去空去重保序限量', () => {
  assert.deepEqual(normalizeFallbackModels('a, b；c d'), ['a', 'b', 'c', 'd'].slice(0, FALLBACK_MODELS_MAX));
  assert.deepEqual(normalizeFallbackModels(['m1', ' m2 ', '', 'm1']), ['m1', 'm2'], '去重去空');
  assert.deepEqual(normalizeFallbackModels(''), []);
  assert.deepEqual(normalizeFallbackModels(null), []);
  assert.deepEqual(normalizeFallbackModels('a\nb'), ['a', 'b'], '换行也算分隔');
  assert.equal(normalizeFallbackModels('a,b,c,d,e').length, FALLBACK_MODELS_MAX, '限量，防止无界重试');
  assert.equal(normalizeFallbackModels(['x'.repeat(500)])[0].length, 120, '单名超长截断');
});

test('isRetryableFailure：429 / 5xx / 超时 / 网络可降级；确定性失败与中断不降级', () => {
  const http = status => Object.assign(new Error(`请求失败（HTTP ${status}）`), { httpStatus: status });
  assert.equal(isRetryableFailure(http(429)), true, '限流可换模型重试');
  assert.equal(isRetryableFailure(http(500)), true);
  assert.equal(isRetryableFailure(http(503)), true);
  assert.equal(isRetryableFailure(http(401)), false, '密钥错：换模型也一样');
  assert.equal(isRetryableFailure(http(403)), false);
  assert.equal(isRetryableFailure(http(404)), false, '模型名/路径错：确定性失败');
  assert.equal(isRetryableFailure(http(400)), false);
  assert.equal(isRetryableFailure(Object.assign(new Error('请求超时'), { timeout: true })), true);
  assert.equal(isRetryableFailure(Object.assign(new Error('网络请求失败'), { network: true })), true);

  // 用户中断绝不降级（那是用户的意图，不是失败）
  const aborted = Object.assign(new Error('已中断'), { name: 'AbortError' });
  assert.equal(isRetryableFailure(aborted), false);
  assert.equal(isRetryableFailure(Object.assign(new Error('x'), { canceled: true })), false);
  assert.equal(isRetryableFailure(null), false);
  assert.equal(isRetryableFailure(new Error('随便什么错')), false, '认不出来就不降级（宁可不试）');
});

test('isRetryableFailure：结构化字段缺失时才退回文案匹配', () => {
  assert.equal(isRetryableFailure(new Error('请求失败（HTTP 429）')), true);
  assert.equal(isRetryableFailure(new Error('请求失败（HTTP 502）')), true);
  assert.equal(isRetryableFailure(new Error('等待首个响应超时，请检查网络')), true);
  assert.equal(isRetryableFailure(new Error('HTTP 404 模型不存在')), false, '文案里是 4xx 就不降级');
});

test('planFallbackChain：主模型在前，与主模型同名的降级项不重复试', () => {
  assert.deepEqual(planFallbackChain({ model: 'gpt-x', fallbackModels: 'gpt-y, gpt-z' }), ['gpt-x', 'gpt-y', 'gpt-z']);
  assert.deepEqual(planFallbackChain({ model: 'gpt-x', fallbackModels: ['gpt-x', 'gpt-y'] }), ['gpt-x', 'gpt-y']);
  assert.deepEqual(planFallbackChain({ model: '', fallbackModels: 'a,b' }), ['a', 'b'], '没主模型时直接用降级链');
  assert.deepEqual(planFallbackChain({}), []);
});

test('shouldFallback：已产出内容绝不降级；链尾不再降级', () => {
  const retryable = Object.assign(new Error('HTTP 503'), { httpStatus: 503 });
  assert.equal(
    shouldFallback({ error: retryable, emitted: false, attempted: 0, chainLength: 2 }),
    true
  );
  assert.equal(
    shouldFallback({ error: retryable, emitted: true, attempted: 0, chainLength: 2 }),
    false,
    '流式已吐出内容再换模型 = 用户看到两段拼接的回复，比报错更糟'
  );
  assert.equal(
    shouldFallback({ error: retryable, emitted: false, attempted: 1, chainLength: 2 }),
    false,
    '链已走完（attempted+1 = chainLength）就停'
  );
  assert.equal(
    shouldFallback({ error: new Error('HTTP 401'), emitted: false, attempted: 0, chainLength: 2 }),
    false,
    '不可降级失败与链长无关'
  );
  assert.equal(shouldFallback({}), false);
});
