// 自定义配色与「粉白」主题的纯逻辑回归。
//
// 两类风险：
//   1) 自定义配色的归一化若放行非法值/未知槽位，脏数据会一路进到 getTheme，
//      表现为整块界面变透明或颜色失效；
//   2) 用户改了 primary，派生 token（primaryAlpha / accentText / quoteOnPrimary…）
//      必须跟着变——它们是从色板算出来的，若某处又读回内置常量，就会出现
//      「用户气泡是粉色但引用文字还是紫色」这类分叉。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  THEMES,
  CUSTOM_THEME_ID,
  CUSTOM_COLOR_GROUPS,
  CUSTOM_COLOR_FIELDS,
  CUSTOM_COLOR_FIELD_KEYS,
  CUSTOM_COLOR_PRESETS,
  getTheme,
  hexToRgba,
  isValidHexColor,
  normalizeCustomColors,
  resolveCustomColors,
} from '../src/theme/themes.js';

const PINK_WHITE = 'pinkWhite';

function toHsl(hex) {
  const clean = String(hex).replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0, lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { hue, saturation, lightness };
}

test('粉白主题：整条色板只有粉色与白色两族（含近白与深玫红）', () => {
  const theme = THEMES.find(item => item.id === PINK_WHITE);
  assert.ok(theme, '粉白主题存在');
  for (const [key, value] of Object.entries(theme.colors)) {
    // overlay 是 rgba 遮罩，单独判：它必须也是粉调深色而不是纯黑
    if (!isValidHexColor(value)) {
      assert.ok(/^rgba\(/.test(value), `${key} 既不是十六进制也不是 rgba：${value}`);
      const [r, g, b] = value.match(/\d+/g).map(Number);
      assert.ok(r > g && r > b, `${key} 遮罩不是粉调（红通道应最高）：${value}`);
      continue;
    }
    const { hue, saturation } = toHsl(value);
    // 近白/纯白视为「白族」；其余必须落在粉/品红区间（315°–360°）
    const isWhite = saturation < 0.12;
    const isPink = hue >= 315 && hue <= 360;
    assert.ok(isWhite || isPink, `${key} 越出粉白色域：${value}（hue ${Math.round(hue)}，sat ${saturation.toFixed(2)}）`);
  }
});

test('粉白主题：主色在浅底上仍达 WCAG AA（浅粉当文字色会隐形）', () => {
  const colors = getTheme(PINK_WHITE).colors;
  assert.equal(colors.accentText, colors.primary, '浅底主题的强调前景应取 primary');
  // 4.5:1 由 themeContrast.test.mjs 统一把守，这里钉住「主色确实是深档」这一前提
  assert.ok(colors.primary.toLowerCase() === '#c2185b', `主色被改动，请重新核对对比度：${colors.primary}`);
});

test('isValidHexColor：只接受三位/六位 # 前缀', () => {
  for (const ok of ['#fff', '#FFF', '#ffffff', '#C2185B']) assert.ok(isValidHexColor(ok), ok);
  for (const bad of ['fff', '#ffff', '#fffffff', 'rgba(1,2,3,1)', 'red', '', null, undefined, 123]) {
    assert.equal(isValidHexColor(bad), false, String(bad));
  }
});

test('normalizeCustomColors：丢弃未知槽位与非法色值，保留合法项', () => {
  const normalized = normalizeCustomColors({
    background: '#fff5f8',
    primary: ' #C2185B ',
    text: 'not-a-color',
    overlay: 'rgba(0,0,0,0.5)',
    未知槽位: '#000000',
    danger: '',
  });
  assert.deepEqual(normalized, { background: '#fff5f8', primary: '#C2185B' });
  assert.deepEqual(normalizeCustomColors(null), {});
  assert.deepEqual(normalizeCustomColors([1, 2]), {});
  assert.deepEqual(normalizeCustomColors('nope'), {});
});

test('resolveCustomColors：底稿 + 覆盖，未改动槽位回落到自定义主题出厂值', () => {
  const base = THEMES.find(theme => theme.id === CUSTOM_THEME_ID).colors;
  const resolved = resolveCustomColors({ primary: '#c2185b' });
  assert.equal(resolved.primary, '#c2185b');
  assert.equal(resolved.background, base.background, '未改动的槽位取出厂底稿');
  assert.equal(resolved.text, base.text);
});

test('getTheme：只有自定义主题吃用户配色，且派生 token 跟着重算', () => {
  const custom = getTheme(CUSTOM_THEME_ID, { primary: '#c2185b', surface: '#fff5f8' }).colors;
  assert.equal(custom.primary, '#c2185b');
  assert.equal(custom.surface, '#fff5f8');
  // 派生 token 必须从覆盖后的 primary 算出，而不是内置常量
  assert.equal(custom.primaryAlpha(0.2), hexToRgba('#c2185b', 0.2));
  assert.equal(custom.surfaceAlpha(0.5), hexToRgba('#fff5f8', 0.5));
  assert.equal(custom.dangerSurface, hexToRgba(custom.danger, 0.12));
  assert.ok([custom.primary, custom.primarySoft].includes(custom.accentText));

  // 内置主题忽略覆盖值，避免误传把内置风格改花
  const dark = getTheme('dark', { primary: '#c2185b', surface: '#fff5f8' }).colors;
  const darkBase = THEMES.find(theme => theme.id === 'dark').colors;
  assert.equal(dark.primary, darkBase.primary);
  assert.equal(dark.surface, darkBase.surface);

  // 非法覆盖值被丢弃，回落到出厂底稿
  const dirty = getTheme(CUSTOM_THEME_ID, { primary: 'oops' }).colors;
  assert.equal(dirty.primary, THEMES.find(theme => theme.id === CUSTOM_THEME_ID).colors.primary);
});

test('自定义配色元数据自洽：分组字段与槽位清单、人话名、预置色一一对应', () => {
  const grouped = CUSTOM_COLOR_GROUPS.flatMap(group => group.fields);
  assert.deepEqual(grouped, CUSTOM_COLOR_FIELDS, '扁平清单必须等于各分组字段拼接');
  assert.equal(new Set(CUSTOM_COLOR_FIELDS).size, CUSTOM_COLOR_FIELDS.length, '槽位不得重复');
  // 每个槽位都要有人话名与出厂值，否则编辑器会出现空标签 / 空色块
  const base = THEMES.find(theme => theme.id === CUSTOM_THEME_ID).colors;
  for (const field of CUSTOM_COLOR_FIELDS) {
    assert.ok(CUSTOM_COLOR_FIELD_KEYS[field], `${field} 缺人话名 key`);
    assert.ok(isValidHexColor(base[field]), `${field} 在自定义主题底稿里缺合法色值`);
  }
  // 派生 token 不是可编辑槽位：它们由 getTheme 算出
  for (const derived of ['primaryAlpha', 'dangerSurface', 'accentText', 'successSurface', 'surfaceAlpha']) {
    assert.equal(CUSTOM_COLOR_FIELDS.includes(derived), false, `${derived} 不应可编辑`);
  }
  for (const preset of CUSTOM_COLOR_PRESETS) {
    assert.ok(isValidHexColor(preset), `预置色非法：${preset}`);
  }
});
