// 自动压缩 token 预算策略（Z 系采纳 #5）：阈值口径与两条规则取严。纯函数直测。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_HEADROOM_TOKENS,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  resolveAutoCompactPolicy,
  shouldAutoCompactByBudget,
  shouldCompactAnyRule,
  shouldStopAutoCompact,
} from '../src/chat/compactionPolicy.js';

test('大窗口：阈值取 min(窗口×比例, 窗口−预留−余量)', () => {
  const policy = resolveAutoCompactPolicy({ contextWindow: 200000 });
  assert.equal(policy.outputReserveTokens, DEFAULT_OUTPUT_RESERVE_TOKENS);
  assert.equal(policy.headroomTokens, DEFAULT_HEADROOM_TOKENS);
  // min(170000, 200000-32000-65536=102464) = 102464（余量取 M 系 65536）
  assert.equal(policy.thresholdTokens, 102464);
  assert.equal(policy.budgetTokens, 102464);
});

test('小窗口：预算非正时退回比例上限（阈值仍 > 0，不会每轮都压）', () => {
  const policy = resolveAutoCompactPolicy({ contextWindow: 32000 });
  assert.ok(policy.budgetTokens <= 0);
  assert.equal(policy.thresholdTokens, Math.floor(32000 * 0.85));
});

test('模型声明了输出上限时用它做预留', () => {
  const policy = resolveAutoCompactPolicy({ contextWindow: 100000, maxOutputTokens: 8000 });
  assert.equal(policy.outputReserveTokens, 8000);
  assert.equal(policy.thresholdTokens, Math.min(85000, 100000 - 8000 - DEFAULT_HEADROOM_TOKENS));
});

test('窗口未知：阈值 0，不触发', () => {
  const policy = resolveAutoCompactPolicy({ contextWindow: 0 });
  assert.equal(policy.thresholdTokens, 0);
  assert.equal(shouldAutoCompactByBudget(999999, policy), false);
});

test('shouldAutoCompactByBudget：达到阈值才触发', () => {
  const policy = resolveAutoCompactPolicy({ contextWindow: 200000 });
  assert.equal(shouldAutoCompactByBudget(102463, policy), false);
  assert.equal(shouldAutoCompactByBudget(102464, policy), true);
});

test('单一来源：M 系 resolveCompactionThreshold 委托到本模块', () => {
  // 委托后两处口径必然一致（此前 Z 0.85/13k 与 M 0.8/65.5k 各算各的）。
  const viaPolicy = resolveAutoCompactPolicy({ contextWindow: 200000 }).thresholdTokens;
  const src = readFileSync(path.resolve('src/chat/contextUsage.js'), 'utf8');
  assert.ok(src.includes('resolveAutoCompactPolicy({'), 'contextUsage 委托到 compactionPolicy');
  assert.equal(viaPolicy, 102464);
});

test('shouldCompactAnyRule：字节与 token 两条规则取更严者', () => {
  const policy = resolveAutoCompactPolicy({ contextWindow: 200000 });
  const bytesOnly = shouldCompactAnyRule({ bytes: 5 * 1024 * 1024, tokens: 1000, byteThreshold: 4 * 1024 * 1024, policy });
  assert.deepEqual(bytesOnly, { compact: true, byBytes: true, byTokens: false });
  const tokensOnly = shouldCompactAnyRule({ bytes: 1, tokens: 160000, byteThreshold: 4 * 1024 * 1024, policy });
  assert.deepEqual(tokensOnly, { compact: true, byBytes: false, byTokens: true });
  const neither = shouldCompactAnyRule({ bytes: 1, tokens: 1, byteThreshold: 4 * 1024 * 1024, policy });
  assert.equal(neither.compact, false);
});

test('shouldStopAutoCompact：连续失败达上限即停', () => {
  assert.equal(shouldStopAutoCompact(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES - 1), false);
  assert.equal(shouldStopAutoCompact(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES), true);
});

test('接线：聊天页经 useAutoCompact 走唯一阈值来源 + 双规则', () => {
  const hook = readFileSync(path.resolve('src/chat/useAutoCompact.js'), 'utf8');
  assert.ok(hook.includes('shouldCompactAnyRule('), '双规则取严触发');
  assert.ok(hook.includes('maxOutputTokens: modelOutputCap'), '按模型输出上限预留');
  assert.ok(hook.includes('shouldStopAutoCompact(failuresRef.current)'), '失败上限');
  // 微压缩只留 loop 的 K1（Z 系就地截断版已删）。
  assert.equal(hook.includes('microcompactMessages'), false);
  const screen = readFileSync(path.resolve('src/ChatScreen.js'), 'utf8');
  assert.ok(screen.includes("import useAutoCompact from './chat/useAutoCompact.js';"), '聊天页接线');
  assert.ok(screen.includes('modelOutputCap: contextUsage.maxOutput'), '传模型输出上限');
  assert.ok(screen.includes('byteThreshold: compactInfo.threshold'), '传字节阈值（第二条规则）');
});
