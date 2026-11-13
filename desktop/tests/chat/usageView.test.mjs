// 桌面上下文占用视图（usageView）的行为测试。
//
// 这里测的是「把数字变成界面档位」的判定：阈值必须来自共享 compactionPolicy
// （而不是本模块自造比例），否则占用条与压缩提示会互相打架。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_USAGE,
  formatTokenCount,
  shouldShowCompactHint,
  usageFromMessages,
  usageLevel,
  usagePercent,
  usageThresholds,
} from '../../src/chat/usageView.js';

test('usageFromMessages：空消息与未声明窗口也给出合法形状', () => {
  const usage = usageFromMessages([], { declared: 0, model: '' });
  assert.ok(usage.window > 0, '窗口未知时回落到默认窗口，不能是 0');
  assert.equal(usage.tokens, 0);
  assert.equal(usage.ratio, 0);
  assert.equal(usage.maxOutput, 0);
  // 形状与 EMPTY_USAGE 的字段集合一致（渲染层只认这一套字段）。
  assert.deepEqual(Object.keys(usage).sort(), Object.keys(EMPTY_USAGE).sort());
});

test('usageFromMessages：声明窗口优先于模型家族建议', () => {
  const messages = [{ role: 'user', text: '这是一段用于估算的中文内容，长度足以产生 token。' }];
  const small = usageFromMessages(messages, { declared: 8000, model: 'deepseek-chat' });
  const large = usageFromMessages(messages, { declared: 200000, model: 'deepseek-chat' });
  assert.equal(small.window, 8000);
  assert.equal(large.window, 200000);
  assert.ok(large.ratio < small.ratio, '同一批消息在大窗口下占用更低');
});

test('usageFromMessages：非法 maxOutput 归一为 0，负数 token 不为负', () => {
  const usage = usageFromMessages([], { declared: 32000, maxOutput: -5 });
  assert.equal(usage.maxOutput, 0);
  assert.ok(usage.tokens >= 0);
});

test('usageThresholds：自动线与提示线同源，提示线严格先于自动线', () => {
  const usage = usageFromMessages([], { declared: 200000, maxOutput: 0 });
  const { autoTokens, hintTokens } = usageThresholds(usage);
  assert.ok(autoTokens > 0, '窗口有效时必须给出正阈值');
  assert.ok(hintTokens > 0);
  assert.ok(hintTokens < autoTokens, '提示线必须先出现，否则提示条永远晚于压缩');
});

test('usageLevel：三档只在跨线时切换，临界值算「到线」', () => {
  const thresholds = { autoTokens: 1000, hintTokens: 850 };
  assert.equal(usageLevel({ tokens: 849, window: 2000 }, thresholds), 'normal');
  assert.equal(usageLevel({ tokens: 850, window: 2000 }, thresholds), 'high');
  assert.equal(usageLevel({ tokens: 999, window: 2000 }, thresholds), 'high');
  assert.equal(usageLevel({ tokens: 1000, window: 2000 }, thresholds), 'critical');
  // 阈值缺失（窗口未知）时一律 normal：没有线就不能自称「该压了」。
  assert.equal(usageLevel({ tokens: 999999, window: 0 }, { autoTokens: 0, hintTokens: 0 }), 'normal');
});

test('usagePercent：窗口未知返回 0，不编假占比', () => {
  assert.equal(usagePercent({ tokens: 100, window: 0 }), 0);
  assert.equal(usagePercent({ tokens: 0, window: 1000 }), 0);
  assert.equal(usagePercent({ tokens: 250, window: 1000 }), 25);
  assert.equal(usagePercent({ tokens: 5, window: 1000 }), 1);
  // 超窗口也封顶显示（条本身另行 clamp），这里只保证是有限整数。
  assert.equal(usagePercent({ tokens: 1500, window: 1000 }), 150);
});

test('formatTokenCount：千位以上用 k 缩写且不丢有效数字', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1k');
  assert.equal(formatTokenCount(1250), '1.3k');
  assert.equal(formatTokenCount(12345), '12.3k');
  assert.equal(formatTokenCount(99999), '100k');
  assert.equal(formatTokenCount(128000), '128k');
  // 负数与非法值按 0 处理（占用条不该显示 -1k）。
  assert.equal(formatTokenCount(-5), '0');
  assert.equal(formatTokenCount('abc'), '0');
});

test('shouldShowCompactHint：过度提示只在「过线 + 未忽略 + 有内容」时出现', () => {
  const usage = { tokens: 900, window: 2000 };
  const thresholds = { autoTokens: 1000, hintTokens: 850 };
  assert.equal(shouldShowCompactHint(usage, thresholds, { meaningfulMessages: 12 }), true);
  assert.equal(shouldShowCompactHint(usage, thresholds, { meaningfulMessages: 12, dismissed: true }), false);
  assert.equal(shouldShowCompactHint(usage, thresholds, { meaningfulMessages: 0 }), false, '只有开场白时压缩必然 noop，不该提示');
  assert.equal(
    shouldShowCompactHint({ tokens: 100, window: 2000 }, thresholds, { meaningfulMessages: 12 }),
    false,
    '未过线不该提示'
  );
});