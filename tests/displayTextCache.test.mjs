import test from 'node:test';
import assert from 'node:assert/strict';

import { getCachedDisplayText } from '../src/memory/displayTextCache.js';

test('同一消息与脚本只计算一次展示文本', () => {
  const message = { id: 'm1', text: '原文' };
  const scripts = [];
  let calls = 0;
  const compute = () => {
    calls += 1;
    return '结果';
  };
  assert.equal(getCachedDisplayText(message, scripts, 1, 0, compute), '结果');
  assert.equal(getCachedDisplayText(message, scripts, 1, 0, compute), '结果');
  assert.equal(calls, 1);
});

test('有脚本时：脚本引用、depth 或消息对象变化都要重新计算', () => {
  // 这一条是本文件原有的语义（「depth 变化要重算」），但**只在真的有正则脚本时才成立**：
  // 无脚本时 applyRegexScripts 原样返回（prompt/regexEngine.js:292），结果与 depth 无关。
  // 原用例拿空数组当脚本去验 depth/引用变化，实际钉住的是「按 depth 分裂缓存」这个
  // 实现细节——而它正是「每追加一条消息就重算全历史」二次放大的根源（见下面那条回归）。
  const message = { id: 'm1', text: '原文' };
  const scripts = [{ id: 's1' }];
  let calls = 0;
  const compute = () => {
    calls += 1;
    return `结果${calls}`;
  };
  getCachedDisplayText(message, scripts, 1, 0, compute);
  getCachedDisplayText(message, scripts, 1, 0, compute);
  assert.equal(calls, 1, '同脚本同 depth 必须命中');
  getCachedDisplayText(message, scripts, 1, 2, compute);
  assert.equal(calls, 2, '有脚本时 depth 变化必须重算（脚本可按 depth 生效）');
  getCachedDisplayText(message, [{ id: 's1' }], 1, 2, compute);
  assert.equal(calls, 3, '有脚本时脚本引用变化必须重算');
  getCachedDisplayText({ id: 'm1', text: '原文' }, scripts, 1, 2, compute);
  assert.equal(calls, 4, '消息对象变化必须重算');
});

test('无脚本时：depth 变化不得触发重算（否则每追加一条消息就重算全历史）', () => {
  const message = { id: 'm2', text: '原文' };
  let calls = 0;
  const compute = () => {
    calls += 1;
    return '结果';
  };
  getCachedDisplayText(message, [], 'AI_OUTPUT', 0, compute);
  getCachedDisplayText(message, [], 'AI_OUTPUT', 1, compute);
  getCachedDisplayText(message, [], 'AI_OUTPUT', 999, compute);
  getCachedDisplayText(message, undefined, 'AI_OUTPUT', 999, compute);
  assert.equal(calls, 1, '无正则脚本时结果与 depth 无关，不得按 depth 分裂缓存');
});

test('无脚本不等于不分 placement：两种 placement 必须各自缓存', () => {
  const message = { id: 'm3', text: '原文' };
  let calls = 0;
  const compute = () => {
    calls += 1;
    return `结果${calls}`;
  };
  getCachedDisplayText(message, [], 'AI_OUTPUT', 0, compute);
  getCachedDisplayText(message, [], 'USER_INPUT', 0, compute);
  assert.equal(calls, 2, 'placement 不同 ⇒ compute 不同，不得共用一条缓存');
});

test('回归：追加消息不再让全历史的展示文本重算（修复前会二次放大）', () => {
  // 模拟 ChatScreen 的真实调用方式：每次追加一条消息，就对**整个历史**重跑一遍 map，
  // 其中 depth = messages.length - 1 - index（所以每追加一条，所有旧消息的 depth 都 +1）。
  // 修复前实测：累计重算次数 = N(N+1)/2（N=1000 → 500,500 次）。现在应当恰好 N 次。
  const messages = [];
  const N = 60;
  let calls = 0;
  for (let append = 0; append < N; append += 1) {
    messages.push({ id: `m${append}`, text: `正文 ${append}` });
    for (let index = 0; index < messages.length; index += 1) {
      const depth = messages.length - 1 - index;
      getCachedDisplayText(messages[index], [], 'AI_OUTPUT', depth, () => {
        calls += 1;
        return messages[index].text;
      });
    }
  }
  assert.equal(
    calls,
    N,
    `每条消息只应算一次，实际 ${calls} 次（修复前是 N(N+1)/2 = ${(N * (N + 1)) / 2} 次）`
  );
});