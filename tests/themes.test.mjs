import test from 'node:test';
import assert from 'node:assert/strict';

import {
  THEMES,
  DEFAULT_THEME_ID,
  hexToRgba,
  getTheme,
  FONT_SCALES,
  DEFAULT_FONT_SCALE_ID,
  getFontOption,
  resolveFontScale,
} from '../src/theme/themes.js';

test('主题表完整：id 唯一、默认主题存在、必备色齐全', () => {
  const ids = THEMES.map(theme => theme.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes(DEFAULT_THEME_ID));
  for (const theme of THEMES) {
    for (const key of ['background', 'surface', 'text', 'primary']) {
      assert.ok(typeof theme.colors[key] === 'string' && theme.colors[key].length > 0, `${theme.id}.${key}`);
    }
  }
});

test('getTheme：未知 id 回落首个主题，并派生带透明度的颜色助手', () => {
  const fallback = getTheme('不存在的主题');
  assert.equal(fallback.id, THEMES[0].id);
  const theme = getTheme(DEFAULT_THEME_ID);
  assert.equal(typeof theme.colors.primaryAlpha, 'function');
  assert.equal(theme.colors.primaryAlpha(), hexToRgba(theme.colors.primary, 0.1));
  assert.equal(theme.colors.primaryMutedAlpha(0.5), hexToRgba(theme.colors.primaryMuted, 0.5));
});

test('hexToRgba：三位/六位/异常输入', () => {
  assert.equal(hexToRgba('#fff', 0.5), 'rgba(255,255,255,0.5)');
  assert.equal(hexToRgba('#6c63ff', 1), 'rgba(108,99,255,1)');
  // 非法长度会产出 NaN 通道，仅验证不抛错
  assert.equal(hexToRgba('zzz'), 'rgba(NaN,NaN,NaN,1)');
  assert.equal(hexToRgba(null), 'rgba(108,99,255,1)');
});

test('字号档位：查表回落、跟随系统取系统值', () => {
  assert.equal(getFontOption('large').scale, 1.25);
  assert.equal(getFontOption('不存在').id, FONT_SCALES[0].id);
  assert.equal(DEFAULT_FONT_SCALE_ID, FONT_SCALES[0].id);
  assert.equal(resolveFontScale('system', 1.3), 1.3);
  // 系统值非法时回落 1
  assert.equal(resolveFontScale('system', 0), 1);
  assert.equal(resolveFontScale('system', 'abc'), 1);
  assert.equal(resolveFontScale('small'), 0.9);
});

test('语义派生 token：各主题都具备且可读（对比度下限）', () => {
  // WCAG 相对亮度 / 对比度
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
  // 把 rgba(x,y,z,a) 在给定不透明底色上做 alpha 合成，得到实际观感颜色。
  const composite = (rgba, baseHex) => {
    const match = /rgba?\(([^)]+)\)/.exec(String(rgba));
    if (!match) return rgbToHex(rgba);
    const parts = match[1].split(',').map(v => parseFloat(v.trim()));
    const alpha = parts.length >= 4 ? parts[3] : 1;
    const base = String(baseHex).replace('#', '');
    const full = base.length === 3 ? base.split('').map(c => c + c).join('') : base;
    const channels = [0, 2, 4].map((i, index) => {
      const bg = parseInt(full.slice(i, i + 2), 16);
      const fg = parts[index];
      return Math.round(fg * alpha + bg * (1 - alpha));
    });
    return `#${channels.map(v => v.toString(16).padStart(2, '0')).join('')}`;
  };
  const rgbToHex = value => String(value);

  for (const theme of THEMES) {
    const t = getTheme(theme.id);
    for (const key of [
      'dangerSurface', 'dangerTextStrong', 'dangerTextSoft',
      'quoteOnPrimary', 'quoteOnPrimaryMuted', 'highlightBg', 'highlightText',
      'panelButtonBg', 'panelButtonText', 'codeText',
    ]) {
      assert.ok(t.colors[key], `${theme.id}.${key} 必须存在`);
    }
    assert.equal(typeof t.colors.surfaceAlpha, 'function', `${theme.id}.surfaceAlpha 派生函数`);
    // 浅色主题下 panelButton 不能再用深色文字配深底（历史 bug）
    assert.ok(
      contrast(composite(t.colors.panelButtonText, t.colors.background), composite(t.colors.panelButtonBg, t.colors.background)) >= 4.5,
      `${theme.id}: panelButton 文字对比度不足`
    );
    // 引用名（叠在 primary 用户气泡上）需达到正文级对比
    assert.ok(
      contrast(composite(t.colors.quoteOnPrimary, t.colors.primary), t.colors.primary) >= 3,
      `${theme.id}: 引用名在用户气泡上对比度不足`
    );
    // 错误正文在错误底（错误色叠加在背景上）需可读
    assert.ok(
      contrast(t.colors.dangerTextStrong, composite(t.colors.dangerSurface, t.colors.background)) >= 3,
      `${theme.id}: 错误正文对比度不足`
    );
  }
});

test('chatStyles 不再有硬编码颜色（回归护栏）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const source = fs.readFileSync(path.resolve('src/chat/chatStyles.js'), 'utf8');
  const hexes = source.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hexes, [], `chatStyles 出现硬编码颜色：${hexes.join(',')}`);
});

test('BUBBLE_STYLES 单一来源且被聊天样式工厂与设置层共用', async () => {
  const { BUBBLE_STYLES } = await import('../src/theme/themes.js');
  assert.deepEqual(BUBBLE_STYLES, ['rounded', 'card', 'plain']);
  const fs = await import('node:fs');
  const path = await import('node:path');
  const chatStyles = fs.readFileSync(path.resolve('src/chat/chatStyles.js'), 'utf8');
  assert.ok(chatStyles.includes('BUBBLE_STYLES'), 'chatStyles 从主题层导入，不再自行定义');
  assert.ok(!/export const BUBBLE_STYLES/.test(chatStyles), '不得重复定义');
  const settings = fs.readFileSync(path.resolve('src/storage/settings.js'), 'utf8');
  assert.ok(settings.includes('BUBBLE_STYLES'), '设置层用同一白名单归一');
  const msg = fs.readFileSync(path.resolve('src/chat/MessageBubble.js'), 'utf8');
  assert.ok(msg.includes('plainBubbles') && msg.includes('assistantTextColor'), '无底纹时助手正文改用正文色');
});
