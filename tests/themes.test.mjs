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
