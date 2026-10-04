// 气泡风格偏好的纯决策回归：三种风格的圆角/尾角/底色/文字色关键值。
// 这些值直接决定视觉与可读性，锁死它们可防「改一处圆角/底色」类回归。
// chatStyles 工厂依赖 react-native，无法在 Node 执行；决策收敛在 bubbleStyle.js。

import test from 'node:test';
import assert from 'node:assert/strict';

import { BUBBLE_STYLES, getTheme } from '../src/theme/themes.js';
import { normalizeBubbleStyle, resolveBubbleStyle } from '../src/chat/bubbleStyle.js';

const tokens = { radius: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, pill: 999, bubble: 18, tail: 6 } };
const dark = getTheme('dark');

test('normalizeBubbleStyle：白名单外一律回落 rounded', () => {
  assert.deepEqual(BUBBLE_STYLES, ['rounded', 'card', 'plain']);
  for (const value of ['rounded', 'card', 'plain']) {
    assert.equal(normalizeBubbleStyle(value), value);
  }
  for (const value of ['neon', '', null, undefined, 42, {}]) {
    assert.equal(normalizeBubbleStyle(value), 'rounded');
  }
});

test('rounded：大圆角 + 尾角、彩色底、带阴影、用户文字用 primaryContrast', () => {
  const r = resolveBubbleStyle('rounded', dark, tokens);
  assert.equal(r.style, 'rounded');
  assert.equal(r.bubbleRadius, 18);
  assert.equal(r.tailRadius, 6, '圆润保留收角方向感');
  assert.equal(r.userBackground, dark.colors.primary);
  assert.equal(r.assistantBackground, dark.colors.bubbleAssistant);
  assert.equal(r.userTextColor, dark.colors.primaryContrast);
  assert.equal(r.hasShadow, true);
  assert.equal(r.bubblePaddingHorizontal, 14);
});

test('card：统一中等圆角、无尾角（四角一致）、彩色底与阴影保留', () => {
  const r = resolveBubbleStyle('card', dark, tokens);
  assert.equal(r.style, 'card');
  assert.equal(r.bubbleRadius, 12);
  assert.equal(r.tailRadius, r.bubbleRadius, '卡片无收角，四角一致');
  assert.equal(r.userBackground, dark.colors.primary);
  assert.equal(r.assistantBackground, dark.colors.bubbleAssistant);
  assert.equal(r.userTextColor, dark.colors.primaryContrast);
  assert.equal(r.hasShadow, true);
});

test('plain：直角透明、无阴影无内边距、文字改用正文色（落在页面背景上）', () => {
  const r = resolveBubbleStyle('plain', dark, tokens);
  assert.equal(r.style, 'plain');
  assert.equal(r.bubbleRadius, 0);
  assert.equal(r.tailRadius, 0);
  assert.equal(r.userBackground, 'transparent');
  assert.equal(r.assistantBackground, 'transparent');
  assert.equal(r.userTextColor, dark.colors.text);
  assert.equal(r.hasShadow, false);
  assert.equal(r.bubblePaddingHorizontal, 0);
  assert.equal(r.bubblePaddingVertical, 2);
});

test('用户文字可读性：非无底纹时 primaryContrast 压在 primary 上达正文级对比', () => {
  const luminance = hex => {
    const clean = String(hex).replace('#', '');
    const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
    const channels = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255)
      .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  for (const id of ['dark', 'light', 'violet', 'blue', 'pink', 'crimson', 'emerald', 'midnight']) {
    const theme = getTheme(id);
    const r = resolveBubbleStyle('rounded', theme, tokens);
    assert.ok(
      contrast(r.userTextColor, r.userBackground) >= 3,
      `${id}: 用户气泡文字对比度不足（历史 bug：浅色主题深字压 primary）`
    );
  }
});