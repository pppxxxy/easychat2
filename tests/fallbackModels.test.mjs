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
  assert.equal(isRetryableFailure(http(400)), false, '只给状态码的 400 不降级（看不出是参数问题）');
  assert.equal(isRetryableFailure(Object.assign(new Error('请求超时'), { timeout: true })), true);
  assert.equal(isRetryableFailure(Object.assign(new Error('网络请求失败'), { network: true })), true);

  // 用户中断绝不降级（那是用户的意图，不是失败）
  const aborted = Object.assign(new Error('已中断'), { name: 'AbortError' });
  assert.equal(isRetryableFailure(aborted), false);
  assert.equal(isRetryableFailure(Object.assign(new Error('x'), { canceled: true })), false);
  assert.equal(isRetryableFailure(null), false);
  assert.equal(isRetryableFailure(new Error('随便什么错')), false, '认不出来就不降级（宁可不试）');
});

// P1（2026-10-11，**有意变更既有承诺**）：参数被拒的 400/422 现在可降级。
//
// 依据：max_tokens / reasoning / thinking 是按**每个模型的能力位**注入的，主模型不认
// 的参数降级模型很可能认。此前把 400/422 与 401 一起归成「确定性失败，不换」，
// 等于主动放弃这条最有价值的降级路径。判定靠 api.js 挂的结构化字段 paramRejected。
test('isRetryableFailure：paramRejected 的 400/422 可降级；401/403/404 仍不降级', () => {
  const rejected = message => Object.assign(new Error(message), { httpStatus: 400, paramRejected: true });
  assert.equal(isRetryableFailure(rejected('unknown_parameter: max_tokens')), true);
  assert.equal(isRetryableFailure(Object.assign(new Error('thinking 不支持'), { httpStatus: 422, paramRejected: true })), true);
  // paramRejected 只在 api.js 判定为真时才有该字段；401 之类不会被标上
  assert.equal(isRetryableFailure(Object.assign(new Error('无效的密钥'), { httpStatus: 401 })), false);
  assert.equal(isRetryableFailure(Object.assign(new Error('模型不存在'), { httpStatus: 404 })), false);
  // 用户中断即便带了 paramRejected 也不降级（中断优先）
  assert.equal(
    isRetryableFailure(Object.assign(new Error('已中断'), { name: 'AbortError', paramRejected: true })),
    false
  );
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
