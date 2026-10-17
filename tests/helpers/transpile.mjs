// 源码转译的**单一口径**（供两处 loader 共用）。
//
// 为什么需要这个文件：仓库里有两条把 src/*.js 转成可执行模块的路径——
//   ① tests/helpers/rn/setup.mjs —— ESM loader hook（渲染测试用，剥 JSX）
//   ② tests/characterStorage.test.mjs —— CJS loader（_compile，存储测试用）
// 同一个源文件若被两条路径各转一次，V8/c8 看到的是**两个不同脚本**（行号映射不同），
// 合并覆盖率时按行取交集，两边未覆盖的行互相拖累——实测 src/storage/io.js
// 单独跑 85%，两个测试一起跑掉到 50%，全局从 75.93% 掉到 75.17%，代码一行没删。
//
// 修法不是加 ignore，而是**只保留一套编译口径**：两处 loader 都从这里取
// babel 选项与转译结果（同一个缓存），于是无论谁先加载，产出的字节与行号都一致。
//
// ⚠️ 三条硬约束（改动前请读）：
//   1. `retainLines: true` —— babel 重排 import 会让行号漂移（io.js 里
//      assertValueBudget 从 29 行漂到 26 行），c8 按行号记账，漂移即重复计数。
//   2. ESM 与 CJS 各自保留自己的模块系统：ESM 路径 `modules: false`，CJS 路径
//      `modules: 'commonjs'`。**不能统一**——ESM 侧转 CJS 会撞
//      ERR_REQUIRE_CYCLE_MODULE（I18nContext ↔ storage/settings 互引）。
//   3. 缓存键必须带上「模块系统」维度，否则两条路径会拿到对方的产物。

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const PRESET_ENV = require.resolve('@babel/preset-env');
const PRESET_REACT = require.resolve('@babel/preset-react');

// 给 ESM 文件补 require：仓库里 io.js / secretStore.js 用 require 惰性加载原生包。
// 必须拼在输出**第 1 行开头**——另起一行会让所有行号 +1（c8 按行号记账）。
const REQUIRE_SHIM = "import { createRequire as __dshCreateRequire } from 'node:module';"
  + 'const require = __dshCreateRequire(import.meta.url);';

/** @type {Map<string, string>} */
const cache = new Map();

function optionsFor(filePath, moduleSystem) {
  return {
    babelrc: false,
    configFile: false,
    sourceType: 'module',
    filename: filePath,
    retainLines: true,
    presets: [
      [PRESET_ENV, { targets: { node: 'current' }, modules: moduleSystem === 'cjs' ? 'commonjs' : false }],
      [PRESET_REACT, { runtime: 'classic' }],
    ],
  };
}

// 是否含 JSX：用**不带 jsx 插件的解析器**试解析。
// 不能用正则猜——webFetch.js 里的 HTML 字符串（`<div>`）会被误判成 JSX，
// 于是这个不含 JSX 的大文件也被转译、行号错位（实测单项掉 238 行）。
const jsxCache = new Map();
export function needsJsxTransform(filePath) {
  if (jsxCache.has(filePath)) return jsxCache.get(filePath);
  let needs;
  try {
    babel.parseSync(fs.readFileSync(filePath, 'utf8'), {
      babelrc: false, configFile: false, sourceType: 'module', filename: filePath, plugins: [],
    });
    needs = false;
  } catch {
    needs = true;
  }
  jsxCache.set(filePath, needs);
  return needs;
}

// 转译为 **ESM**（保留 import/export，只剥 JSX）。给 Node 的 ESM loader 用。
export function transformToEsm(filePath) {
  const key = `esm:${filePath}`;
  if (cache.has(key)) return cache.get(key);
  const code = babel.transformSync(fs.readFileSync(filePath, 'utf8'), optionsFor(filePath, 'esm')).code;
  const out = `${REQUIRE_SHIM}${code}`;
  cache.set(key, out);
  return out;
}

// 转译为 **CJS**（供 Module._compile）。给存储测试的 require 打桩路径用。
export function transformToCjs(filePath) {
  const key = `cjs:${filePath}`;
  if (cache.has(key)) return cache.get(key);
  const code = babel.transformSync(fs.readFileSync(filePath, 'utf8'), optionsFor(filePath, 'cjs')).code;
  cache.set(key, code);
  return code;
}
