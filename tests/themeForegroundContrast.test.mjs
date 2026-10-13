// 「文字色 token 落在其配套底色上」的对比度门禁（FIX-1 防回归）。
//
// 背景（真机 bug）：设置页外观段「思考内容展示」「气泡风格」「自定义配色」三个分组的选项按钮
// 共用同一套 formatChip 样式。激活态底色是 primaryAlpha(0.25) 的浅着色底，文字色却是
// primarySoft —— 深色主题下 primarySoft 是亮淡紫（dark 6.18:1），所以问题从没暴露；
// 而自定义主题的出厂底稿是**浅色**的（背景 #f6f6f8），primarySoft = #cbd5e0 落在
// #d2d5d9 上只有 **1.01:1**，pinkWhite 1.02:1、light 1.34:1 —— 浅字浅底，肉眼等于没字。
//
// 本测试钉三件事：
//   1) 语义层：对每个内置主题 + custom 出厂底稿，断言「文字 token × 配套底色」的对比度达标。
//      文字色集：text / textMuted / accentText / primaryContrast；
//      底色集：background / surface / surfaceAlt / primaryAlpha(0.25)。
//   2) 回归层：formatChip 激活态（设置页三个分组）的文字色不得退回 primarySoft。
//   3) 单调性：accentText 在**任何**真实底色上都不比 primarySoft 差——这是当初
//      「前景 primarySoft 统一换成 accentText」那批改动的安全前提，写成断言以免后人反悔。
//
// 为什么阈值分档而不是一律 4.5:1：primaryContrast 的配套底是**实色 primary**（按钮），
// 它由主题作者保证；而 primaryAlpha(0.25) 是 tint 底，其上的文字在 WCAG 里属「大号/加粗」
// 档（设置页 chip 都是 12px + fontWeight 700）。所以对 tint 底按 3:1（AA 大字号）把守，
// 对 surface/background 按 4.5:1（AA 正文）把守。分档写清楚，避免用一个数字掩盖差异。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { THEMES, CUSTOM_THEME_ID, getTheme, contrastRatio } from '../src/theme/themes.js';

const AA_NORMAL = 4.5;
const AA_LARGE = 3;

// 把 rgba(x,y,z,a) 在给定不透明底色上做 alpha 合成，得到实际观感色。
function composite(rgba, baseHex) {
  const match = /rgba?\(([^)]+)\)/.exec(String(rgba));
  if (!match) return String(rgba);
  const parts = match[1].split(',').map(v => parseFloat(v.trim()));
  const alpha = parts.length >= 4 ? parts[3] : 1;
  const base = String(baseHex).replace('#', '');
  const full = base.length === 3 ? base.split('').map(c => c + c).join('') : base;
  const channels = [0, 2, 4].map((i, index) => {
    const bg = parseInt(full.slice(i, i + 2), 16);
    return Math.round(parts[index] * alpha + bg * (1 - alpha));
  });
  return `#${channels.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// 「内置主题 + custom 出厂底稿」全部主题实例。custom 必须单独算：它默认就是用户会看到的那套。
function allThemeInstances() {
  return THEMES.map(theme => ({ id: theme.id, colors: getTheme(theme.id).colors }));
}

test('composite 自检：rgba 叠加与直接给不透明色等价', () => {
  assert.equal(composite('rgba(0,0,0,1)', '#ffffff'), '#000000');
  assert.equal(composite('rgba(255,255,255,0.5)', '#000000'), '#808080');
  // 全透明 = 完全露出底色
  assert.equal(composite('rgba(0,0,0,0)', '#123456'), '#123456');
});

test('文字 token 落在 surface/background 上：每个主题都达 WCAG AA 4.5:1', () => {
  for (const { id, colors } of allThemeInstances()) {
    for (const token of ['text', 'textMuted', 'accentText']) {
      for (const base of ['surface', 'background']) {
        const ratio = contrastRatio(colors[token], colors[base]);
        assert.ok(
          ratio >= AA_NORMAL,
          `${id}.${token} 落在 ${base} 上只有 ${ratio.toFixed(2)}:1 < 4.5:1（文字会看不清）`,
        );
      }
    }
  }
});

test('primaryContrast 落在实色 primary 上：除 dark 外都达 AA 4.5:1，dark 记录既有值', () => {
  // 这是「实色主色底 + primaryContrast 字」这套按钮配色的底线。
  // dark 主题的 primaryContrast(#ffffff) 对 primary(#6c63ff) 实测只有 4.32:1，**低于 AA 4.5:1**
  // ——这是内置主题的既有取值（不是本次改动引入的），本批不动它，但必须**如实记录**而不是
  // 把阈值偷偷降到 4.3 掩盖过去：所以用「例外清单 + 记录值」的方式，让这条债在测试里可见。
  // 清单只许收窄：修好 dark 的 primary（或换 primaryContrast）后，这条会因值变大而变红，
  // 提示把它从清单里删掉。
  const KNOWN_BELOW_AA = {
    dark: 4.32,
  };
  for (const { id, colors } of allThemeInstances()) {
    const ratio = contrastRatio(colors.primaryContrast, colors.primary);
    const recorded = KNOWN_BELOW_AA[id];
    if (recorded !== undefined) {
      // 例外主题：不得比记录值更差（4.32 取两位小数，留 0.005 容差吸收浮点）
      assert.ok(
        ratio >= recorded - 0.005,
        `${id}: primaryContrast/primary 从记录的 ${recorded}:1 退化到 ${ratio.toFixed(2)}:1`,
      );
      continue;
    }
    assert.ok(
      ratio >= AA_NORMAL,
      `${id}: primaryContrast 落在实色 primary 上只有 ${ratio.toFixed(2)}:1 < 4.5:1`,
    );
  }
  // 例外清单必须仍然真的低于 AA：修好后要把它删掉，而不是留着放水。
  for (const [id, recorded] of Object.entries(KNOWN_BELOW_AA)) {
    const colors = getTheme(id).colors;
    const ratio = contrastRatio(colors.primaryContrast, colors.primary);
    assert.ok(
      ratio < AA_NORMAL,
      `${id}: 对比度已升到 ${ratio.toFixed(2)}:1（>= 4.5），请把它从 KNOWN_BELOW_AA 里删掉`,
    );
    assert.equal(
      Number(ratio.toFixed(2)),
      recorded,
      `${id}: 记录值 ${recorded} 与实际 ${ratio.toFixed(2)} 不一致，请更新记录`,
    );
  }
});

test('设置页 chip 激活态：primaryAlpha(0.25) 浅底上的文字达 AA 大字 3:1（本次真机 bug 的守门人）', () => {
  for (const { id, colors } of allThemeInstances()) {
    const tint = composite(colors.primaryAlpha(0.25), colors.surface);
    for (const token of ['text', 'accentText']) {
      const ratio = contrastRatio(colors[token], tint);
      assert.ok(
        ratio >= AA_LARGE,
        `${id}.${token} 落在 primaryAlpha(0.25) 浅底（${tint}）上只有 ${ratio.toFixed(2)}:1 < 3:1`,
      );
    }
  }
});

test('回归：浅底主题下 primarySoft 落在 primaryAlpha(0.25) 上确实不可读（bug 的成因仍成立）', () => {
  // 这条**故意断言 bug 存在**：primarySoft 在浅底主题下当文字色就是不可读的。
  // 它保证上面那条「文字用 text/accentText」的门禁不是空转——如果有人把某个浅底主题的
  // primarySoft 改成深色，这条会变红，提示「可以重新评估 primarySoft 的用途了」。
  for (const id of ['light', 'pinkWhite', CUSTOM_THEME_ID]) {
    const colors = getTheme(id).colors;
    const tint = composite(colors.primaryAlpha(0.25), colors.surface);
    const ratio = contrastRatio(colors.primarySoft, tint);
    assert.ok(
      ratio < AA_LARGE,
      `${id}: primarySoft 落在 tint 底上竟然有 ${ratio.toFixed(2)}:1 —— 若主题色板已改，请重新核对本文件的用途划分`,
    );
  }
});

test('单调性：accentText 在任何真实底色上都不比 primarySoft 差（批量替换的安全前提）', () => {
  // 当初把 66 个文件里「前景 primarySoft」统一换成 accentText，前提就是这条：
  // accentText 在深色主题下**逐字节等于** primarySoft（零视觉变化），在浅底主题下取 primary
  // （严格更可读）。若将来有人改了 accentText 的派生口径，这条会立刻变红。
  //
  // 「真实底色」= 容器底色（surface/surfaceAlt/background/surfaceBorder/divider）
  //             + 各种 primary/danger tint 合成色。
  // 刻意**不含**实色 primary/danger/success：那些是按钮底，其文字约定用 primaryContrast，
  // 不是本 token 的落点（实测也确认全仓 0 处「前景 primarySoft 落在实色 primary 底上」）。
  for (const { id, colors } of allThemeInstances()) {
    const palette = [
      { name: 'background', hex: colors.background },
      { name: 'surface', hex: colors.surface },
      { name: 'surfaceAlt', hex: colors.surfaceAlt },
      { name: 'surfaceBorder', hex: colors.surfaceBorder },
      { name: 'divider', hex: colors.divider },
    ];
    for (const alpha of [0.08, 0.1, 0.12, 0.14, 0.18, 0.2, 0.25, 0.3, 0.35, 0.45]) {
      palette.push({ name: `primaryAlpha(${alpha})`, hex: composite(colors.primaryAlpha(alpha), colors.surface) });
      palette.push({ name: `dangerAlpha(${alpha})`, hex: composite(colors.dangerAlpha(alpha), colors.surface) });
    }
    for (const bg of palette) {
      const before = contrastRatio(colors.primarySoft, bg.hex);
      const after = contrastRatio(colors.accentText, bg.hex);
      assert.ok(
        after >= before - 0.001,
        `${id}: accentText 落在 ${bg.name}(${bg.hex}) 上比 primarySoft 更差（${before.toFixed(2)} -> ${after.toFixed(2)}）`,
      );
    }
  }
});

// ---- 调用点层：设置页外观段的 chip 不得退回 primarySoft ----

test('formatChip 激活态文字色不是 primarySoft（真机隐身 bug 的直接回归）', () => {
  const source = fs.readFileSync(path.resolve('src/settings/settingsStyles.js'), 'utf8');
  const match = /formatChipTextActive\s*:\s*\{([^}]*)\}/.exec(source);
  assert.ok(match, 'settingsStyles.js 里必须还有 formatChipTextActive');
  const body = match[1];
  assert.equal(
    /primarySoft/.test(body),
    false,
    'formatChipTextActive 又用回了 primarySoft：浅底主题（custom 出厂底稿/light/pinkWhite）下文字会与底色同色',
  );
  assert.match(body, /color\s*:\s*theme\.colors\.text\b/, 'formatChipTextActive 应当用 text（与同表的 modelChipTextActive 同口径）');
});

test('三个分组（自定义配色/思考内容展示/气泡风格）确实共用 formatChip 这套样式', () => {
  // 这条把「修一个样式 = 修三个分组」这个前提钉住：若将来某个分组改用独立样式，
  // 上面的回归测试就覆盖不到它了，必须同步更新。
  const source = fs.readFileSync(path.resolve('src/settings/sections/AppearanceSection.js'), 'utf8');
  const uses = (source.match(/styles\.formatChip\b/g) || []).length;
  assert.ok(uses >= 3, `AppearanceSection 里 formatChip 的使用点只有 ${uses} 处，三个分组应当都用它`);
  assert.match(source, /styles\.formatChipTextActive/, '激活态文字样式必须被用上');
});
