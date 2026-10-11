// 浅色主题对比度回归。
//
// 背景：`primarySoft` 是「主色浅色调」——深色主题下当文字色很合适（dark 对 surface
// 8.15:1），但浅色主题下它是 #b9b3ff，对 surface(#ffffff) 只有 1.92:1、对
// background(#f5f5fa) 1.76:1，当文字/图标色用等于隐形（WCAG AA 正文要求 4.5:1）。
// 正确分工是：**前景强调色走 theme.colors.accentText，primarySoft 只做装饰**（背景/边框）。
//
// 本测试钉两类事实：
//   1) 语义层：浅色主题下当前景用的 token 全部 ≥4.5:1；低于阈值的 token 收进
//      BELOW_AA 清单（只减不增），其中 primarySoft 明确标注为「装饰专用」。
//   2) 调用点层：src/chat/** 与 src/workspace/screen/** 里 primarySoft 只能出现在
//      装饰位置（border*/backgroundColor/shadowColor），不得当 color/tintColor 用。
//
// 说明：第 2 条是**源码字符串断言**，按仓库约定只用于「钉已修复的回归」（primarySoft
// 曾被当文字色用），不用于新功能。范围只覆盖本次整改的两个模块树；src/books、
// src/settings、src/ui、src/localModel 等仍有同类存量（见 .monkeycode/docs/审查待办.md），
// 属独立的下一批，不在此处放行——把范围写死是为了让这条断言今天就能为真。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { THEMES, getTheme, contrastRatio } from '../src/theme/themes.js';

const AA_NORMAL = 4.5;

// 当文字/图标用的语义 token：浅色主题下必须达标。
const FOREGROUND_TOKENS = ['text', 'textMuted', 'primary', 'success', 'accentText'];

// 低于 AA 的 token 全集（只减不增）。修好一个就删一行——下面的断言会在它达标后报错，
// 逼着清单变短；新增低对比前景 token 同样会报错，逼着改颜色或改用途。
const BELOW_AA = {
  primarySoft: '装饰专用（背景/边框/描边）：深色主题可读，浅色主题仅 1.92:1，不得当文字色',
  textFaint: '次要元信息（时间戳/计数/占位符）',
  primaryMuted: '主色中间档，多用于装饰性图标底与描边',
  danger: '错误红',
  dangerSoft: '错误红浅档（错误气泡文字/代码高亮）',
  star: '收藏星标图形',
};

const hex6 = value => /^#[0-9a-fA-F]{6}$/.test(String(value || ''));

test('contrastRatio：WCAG 公式本身正确（纯函数行为）', () => {
  assert.equal(Number(contrastRatio('#000000', '#ffffff').toFixed(2)), 21);
  assert.equal(Number(contrastRatio('#ffffff', '#ffffff').toFixed(2)), 1);
  // 对称性：交换前景/背景不改变结果
  assert.equal(contrastRatio('#5b54e8', '#ffffff'), contrastRatio('#ffffff', '#5b54e8'));
  // 三位缩写与六位等价
  assert.equal(contrastRatio('#fff', '#000'), contrastRatio('#ffffff', '#000000'));
  // 非法输入不抛错：亮度按 0（等价黑）处理
  assert.equal(contrastRatio('nope', '#000000'), 1);
});

test('accentText：8 个主题下对 surface/background 都达 WCAG AA 4.5:1', () => {
  for (const theme of THEMES) {
    const colors = getTheme(theme.id).colors;
    assert.ok(hex6(colors.accentText), `${theme.id}.accentText 必须是六位十六进制`);
    for (const base of ['surface', 'background']) {
      const ratio = contrastRatio(colors.accentText, colors[base]);
      assert.ok(ratio >= AA_NORMAL, `${theme.id}.accentText vs ${base} = ${ratio.toFixed(2)}:1 < 4.5:1`);
    }
  }
});

test('accentText 派生口径：浅底主题取 primary，深底主题取 primarySoft', () => {
  assert.equal(getTheme('light').colors.accentText, getTheme('light').colors.primary);
  assert.equal(getTheme('dark').colors.accentText, getTheme('dark').colors.primarySoft);
  // 派生不新增颜色取值：必须等于该主题既有的 primary 或 primarySoft 之一
  for (const theme of THEMES) {
    const colors = getTheme(theme.id).colors;
    assert.ok(
      [colors.primary, colors.primarySoft].includes(colors.accentText),
      `${theme.id}.accentText 不得是新增色值`,
    );
  }
});

test('浅色主题：前景语义色对 surface/background 均达 WCAG AA 4.5:1', () => {
  const light = getTheme('light').colors;
  for (const key of FOREGROUND_TOKENS) {
    for (const base of ['surface', 'background']) {
      const ratio = contrastRatio(light[key], light[base]);
      assert.ok(ratio >= AA_NORMAL, `light.${key} vs ${base} = ${ratio.toFixed(2)}:1 < 4.5:1`);
    }
  }
});

test('浅色主题：低对比 token 清单与实际完全一致（只减不增）', () => {
  const light = getTheme('light').colors;
  const candidates = [...FOREGROUND_TOKENS, ...Object.keys(BELOW_AA)];
  const below = candidates.filter(key =>
    ['surface', 'background'].some(base => contrastRatio(light[key], light[base]) < AA_NORMAL));
  assert.deepEqual(
    below.sort(),
    Object.keys(BELOW_AA).sort(),
    '低对比 token 集合变了：已修好的要从 BELOW_AA 删掉；新出现的说明是新债，请改颜色或改用途',
  );
});

// ---- 调用点层：源码里不得再把 primarySoft 当前景色 ----

const SCOPES = ['src/chat', 'src/workspace/screen'];
// 出现在 primarySoft 之前、且离它最近的那个属性名若属此集合，则该处是装饰用途。
const DECORATIVE_PROPERTY = /^(?:border[A-Za-z]*Color|backgroundColor|shadowColor)$/;

function listJsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

// 返回文件里「把 primarySoft 当前景色用」的位置描述。判定：取该 token 之前的最近一个
// `属性名:` / `属性名=`，若它不是装饰性属性，就是前景用途（color={...} 也算）。
function findForegroundPrimarySoft(source) {
  const hits = [];
  source.split('\n').forEach((line, index) => {
    let at = line.indexOf('primarySoft');
    while (at !== -1) {
      const prefix = line.slice(0, at);
      const assignments = [...prefix.matchAll(/([A-Za-z]+)\s*[:=]/g)];
      const property = assignments.length ? assignments[assignments.length - 1][1] : '';
      if (!DECORATIVE_PROPERTY.test(property)) {
        hits.push(`${index + 1}: ${line.trim()}`);
      }
      at = line.indexOf('primarySoft', at + 1);
    }
  });
  return hits;
}

test('检测器自检：前景用法会被抓出，装饰用法不会', () => {
  assert.deepEqual(findForegroundPrimarySoft('  a: { color: theme.colors.primarySoft },'), [
    '1: a: { color: theme.colors.primarySoft },',
  ]);
  assert.deepEqual(findForegroundPrimarySoft('color={cond ? theme.colors.primary : theme.colors.primarySoft}'), [
    '1: color={cond ? theme.colors.primary : theme.colors.primarySoft}',
  ]);
  // 同一行里装饰属性在前、前景属性在后：仍算前景（前缀取最近的那个属性名）
  assert.deepEqual(findForegroundPrimarySoft('{ backgroundColor: x, color: theme.colors.primarySoft }'), [
    '1: { backgroundColor: x, color: theme.colors.primarySoft }',
  ]);
  assert.deepEqual(findForegroundPrimarySoft('  borderLeftColor: theme.colors.primarySoft,'), []);
  assert.deepEqual(findForegroundPrimarySoft('  borderColor: theme.colors.primarySoft,'), []);
  assert.deepEqual(findForegroundPrimarySoft('  shadowColor: theme.colors.primarySoft,'), []);
  assert.deepEqual(findForegroundPrimarySoft('const x = 1;'), []);
});

test('src/chat/** 与 src/workspace/screen/** 不再把 primarySoft 当前景色用', () => {
  const offenders = [];
  for (const scope of SCOPES) {
    for (const file of listJsFiles(path.resolve(scope))) {
      const source = fs.readFileSync(file, 'utf8');
      for (const hit of findForegroundPrimarySoft(source)) {
        offenders.push(`${path.relative(process.cwd(), file)} → ${hit}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `primarySoft 是装饰色（浅色主题仅 1.92:1），前景请用 accentText：\n${offenders.join('\n')}`);
});
