// 参数被拒判定（400/422）测试：纯函数，不需要网络与 RN。
//
// 这层的存在理由：`max_tokens` / `reasoning` / `thinking` 是按**每个模型的能力位**注入的，
// 「主模型不认这个参数」完全不代表降级模型也不认。判定必须保守——只在 400/422 且文本
// 确实指向参数问题时才算，否则会把「请求体真写坏了」也当可重试，白花额度。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isParamRejectedError,
  isParamRejectionStatus,
  messageLooksLikeParamRejection,
} from '../src/network/requestErrors.js';

test('isParamRejectionStatus：只有 400 / 422 算候选', () => {
  assert.equal(isParamRejectionStatus(400), true);
  assert.equal(isParamRejectionStatus(422), true);
  assert.equal(isParamRejectionStatus(401), false);
  assert.equal(isParamRejectionStatus(403), false);
  assert.equal(isParamRejectionStatus(404), false);
  assert.equal(isParamRejectionStatus(429), false, '限流走自己的分支');
  assert.equal(isParamRejectionStatus(500), false);
  assert.equal(isParamRejectionStatus(undefined), false);
  assert.equal(isParamRejectionStatus('422'), true, '字符串形态也认');
});

test('messageLooksLikeParamRejection：命中参数名或参数类关键词', () => {
  // 参数名（能力位注入的那几个 + 常见采样字段）
  assert.equal(messageLooksLikeParamRejection('unknown_parameter: max_tokens'), true);
  assert.equal(messageLooksLikeParamRejection('Unsupported value: reasoning_effort'), true);
  assert.equal(messageLooksLikeParamRejection('max_completion_tokens is not supported'), true);
  assert.equal(messageLooksLikeParamRejection('thinking: unexpected field'), true);
  assert.equal(messageLooksLikeParamRejection('invalid temperature'), true);
  // 参数类关键词（各家措辞）
  assert.equal(messageLooksLikeParamRejection('Unrecognized request argument supplied'), true);
  assert.equal(messageLooksLikeParamRejection('unsupported parameter'), true);
  assert.equal(messageLooksLikeParamRejection('extra_forbidden'), true);
  assert.equal(messageLooksLikeParamRejection('不支持该参数'), true);
  assert.equal(messageLooksLikeParamRejection('未知参数'), true);
  // 与参数无关的失败：不命中（保守）
  assert.equal(messageLooksLikeParamRejection('Invalid API key'), false);
  assert.equal(messageLooksLikeParamRejection('model not found'), false);
  assert.equal(messageLooksLikeParamRejection(''), false);
  assert.equal(messageLooksLikeParamRejection(null), false);
  assert.equal(messageLooksLikeParamRejection('rate limit exceeded'), false);
});

test('isParamRejectedError：状态码与文本都满足才算（保守判定）', () => {
  assert.equal(isParamRejectedError({ status: 400, message: 'unknown_parameter: max_tokens' }), true);
  assert.equal(isParamRejectedError({ status: 422, message: 'thinking 不支持' }), true);
  // 状态码对但文本看不出参数问题 → 不算（可能是请求体真写坏了，换模型也一样）
  assert.equal(isParamRejectedError({ status: 400, message: 'Invalid request body' }), false);
  assert.equal(isParamRejectedError({ status: 400, message: '' }), false);
  // 文本像参数问题但状态码不是 400/422 → 不算
  assert.equal(isParamRejectedError({ status: 401, message: 'unknown_parameter: max_tokens' }), false);
  assert.equal(isParamRejectedError({ status: 500, message: 'max_tokens unsupported' }), false);
  assert.equal(isParamRejectedError({}), false);
  assert.equal(isParamRejectedError(), false);
});
