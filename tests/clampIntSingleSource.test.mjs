// 「整数夹取只有一份实现」这条结构性不变量（回归 2026-10-12 审查待办第 2 项）。
//
// 背景：同名私有 helper `clampInt` 曾在四处各写一份，而且**参数顺序各不相同**——
//   storage/settings/imageRecognition.js  (value, min, max, fallback)
//   workspace/references.js               (value, fallback, min, max)
//   workspace/retention.js                (value, bounds, fallback)
//   workspace/toolDefs/searchTool.js      (value, fallback, min, max)
// 四处语义一致，但顺序不同正是「照抄一份、改的时候传错位」的温床：传反 min/max 不会报错，
// 只会让某个上限静默失效。现在只留 utils/clampInt.js 一种形状（边界走对象）。
//
// 范围说明：只钉**这个具名 helper**。仓库里还有大量内联的 `Math.min(max, Math.max(min, x))`
// 单行夹取（books/ChapterScrubber、agent/task/taskModel 等），它们各自带 round/floor/比例
// 语义、并非同一件事，不在本不变量范围内，也不该为「统一」而硬套。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const IMPLEMENTATION = 'src/utils/clampInt.js';
const CONSUMERS = [
  'src/storage/settings/imageRecognition.js',
  'src/workspace/references.js',
  'src/workspace/retention.js',
  'src/workspace/toolDefs/searchTool.js',
];

// 私有副本的特征：本地 function/const 定义（无论参数怎么排）。
const LOCAL_DEFINITIONS = [
  /function\s+clampInt\s*\(/,
  /const\s+clampInt\s*=/,
];

function loadModule(absPath) {
  const cached = Module._cache[absPath];
  if (cached) return cached.exports;
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: absPath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const mod = new Module(absPath);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  Module._cache[absPath] = mod;
  try {
    mod._compile(code, absPath);
  } catch (error) {
    delete Module._cache[absPath];
    throw error;
  }
  return mod.exports;
}

test('clampInt 只有一份实现，四处消费方一律引用它', () => {
  for (const file of CONSUMERS) {
    const source = fs.readFileSync(path.resolve(file), 'utf8');
    assert.ok(
      source.includes('utils/clampInt.js'),
      `${file} 必须从唯一实现（${IMPLEMENTATION}）引用 clampInt`
    );
    for (const pattern of LOCAL_DEFINITIONS) {
      assert.ok(
        !pattern.test(source),
        `${file} 不得再手写一份 clampInt（参数顺序漂移就是这样发生的）`
      );
    }
  }
});

test('消费方清单不许空转：每项都要真实存在', () => {
  assert.ok(CONSUMERS.length >= 4, '消费方清单不应缩水');
  for (const file of CONSUMERS) {
    assert.ok(fs.existsSync(path.resolve(file)), `${file} 不存在——清单需要更新`);
  }
});

test('clampInt 行为：取整、夹进区间、非有限值回落 fallback', () => {
  const { clampInt } = loadModule(path.resolve(IMPLEMENTATION));
  const bounds = { min: 10, max: 100, fallback: 50 };

  assert.equal(clampInt(42, bounds), 42, '区间内原样返回');
  assert.equal(clampInt(42.9, bounds), 42, '取整（floor）');
  assert.equal(clampInt('77', bounds), 77, '数字字符串可用');
  assert.equal(clampInt(5, bounds), 10, '低于下限 → 夹到 min');
  assert.equal(clampInt(5000, bounds), 100, '高于上限 → 夹到 max');
  assert.equal(clampInt(-3, bounds), 10, '负数 → 夹到 min（min >= 0 时 floor 与 trunc 等价）');
  assert.equal(clampInt(undefined, bounds), 50, 'undefined → fallback');
  // null 是**如实钉住**当前语义（与原四处副本逐字一致）：Number(null) === 0 是有限值，
  // 所以不回落 fallback，而是被夹到 min。调用方传的是读出来的字段，缺失即 undefined，
  // 故实际不受影响；哪天要改这个口径，先看这条断言。
  assert.equal(clampInt(null, bounds), 10, 'null → Number(null)=0 → 夹到 min（不是 fallback）');
  assert.equal(clampInt(NaN, bounds), 50, 'NaN → fallback');
  assert.equal(clampInt('abc', bounds), 50, '非数字 → fallback');
  assert.equal(clampInt(Infinity, bounds), 50, 'Infinity 非有限 → fallback');
});
