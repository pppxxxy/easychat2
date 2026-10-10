// 自动压缩 token 预算策略（Z 系采纳 #5）：阈值口径与两条规则取严。纯函数直测。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  AUTOCOMPACT_BUFFER_TOKENS,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  resolveAutoCompactPolicy,
  shouldAutoCompactByBudget,
  shouldCompactAnyRule,
  shouldStopAutoCompact,
} from '../src/chat/compactionPolicy.js';

test('大窗口：阈值取 min(窗口×比例, 窗口−预留−缓冲)', () => {
  const policy = resolveAutoCompactPolicy({ contextWindow: 200000 });
  assert.equal(policy.outputReserveTokens, DEFAULT_OUTPUT_RESERVE_TOKENS);
  assert.equal(policy.bufferTokens, AUTOCOMPACT_BUFFER_TOKENS);
  // min(170000, 200000-32000-13000=155000) = 155000
  assert.equal(policy.thresholdTokens, 155000);
  assert.equal(policy.budgetTokens, 155000);
});

test('小窗口：预算非正时退回比例上限（阈值仍 > 0，不会每轮都压）', () => {
  const policy = resolveAutoCompactPolicy({ contextWindow: 32000 });
  assert.ok(policy.budgetTokens <= 0);
  assert.equal(policy.thresholdTokens, Math.floor(32000 * 0.85));
});

test('模型声明了输出上限时用它做预留', () => {
  const policy = resolveAutoCompactPolicy({ contextWindow: 100000, maxOutputTokens: 8000 });
  assert.equal(policy.outputReserveTokens, 8000);
  assert.equal(policy.thresholdTokens, Math.min(85000, 100000 - 8000 - 13000));
});

test('窗口未知：阈值 0，不触发', () => {
  const policy = resolveAutoCompactPolicy({ contextWindow: 0 });
  assert.equal(policy.thresholdTokens, 0);
  assert.equal(shouldAutoCompactByBudget(999999, policy), false);
});

test('shouldAutoCompactByBudget：达到阈值才触发', () => {
  const policy = resolveAutoCompactPolicy({ contextWindow: 200000 });
  assert.equal(shouldAutoCompactByBudget(154999, policy), false);
  assert.equal(shouldAutoCompactByBudget(155000, policy), true);
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

test('接线：聊天页经 useAutoCompact 走预算口径 + 先本地微压缩', () => {
  const hook = readFileSync(path.resolve('src/chat/useAutoCompact.js'), 'utf8');
  assert.ok(hook.includes('shouldAutoCompactByBudget(contextUsage.tokens, policy)'), '预算口径触发');
  assert.ok(hook.includes('resolveAutoCompactPolicy({ contextWindow: contextUsage.window })'), '按窗口解析策略');
  assert.ok(hook.includes('microcompactMessages(messagesRef.current)'), '先试本地微压缩');
  const screen = readFileSync(path.resolve('src/ChatScreen.js'), 'utf8');
  assert.ok(screen.includes("import useAutoCompact from './chat/useAutoCompact.js';"), '聊天页接线');
  assert.ok(screen.includes('useAutoCompact({'), '调用 hook');
});
