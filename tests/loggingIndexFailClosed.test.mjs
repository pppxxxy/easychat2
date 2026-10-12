// 日志装配点（src/logging/index.js）的脱敏 fail-closed 测试。
//
// 缺陷形态（回归 2026-10-12 逐条审查）：
//   ① `depsLoaded = true` 写在 `require` **之前** —— 一次 require 失败就把 maskSecrets
//      永久钉成 null，且**不再重试**（粘性失败）：从那一刻起全部诊断都不脱敏；
//   ② 拿不到脱敏器时 `redact: null` 传下去，logger.js 的 `String(text)` 回落原文，
//      直接违反 storage/diagnostics.js:5「全部文本经 maskSecrets 脱敏，绝不落明文密钥」。
//
// 这里验证两件事：不可用时**不出现原文**，且**失败不被缓存**（第二次调用会重试）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const SRC_DIR = path.resolve('src');

// 哨兵串：它只要出现在诊断里，就是「写了明文密钥」。
const SENTINEL = 'sk-SENTINEL-12345';

let secretsLoadFails = false;
const recorded = [];

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

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  // 脱敏器：可控地「加载失败」，用来验 fail-closed 与「不缓存失败」。
  if (request === '../storage/secrets.js' || request.endsWith('/secrets.js')) {
    if (secretsLoadFails) throw new Error('secrets module unavailable');
    return {
      __esModule: true,
      maskSecrets: text => String(text == null ? '' : text).replace(/sk-SENTINEL-\d+/g, '[API_KEY已隐藏]'),
    };
  }
  // 诊断落地：用替身收集，避免拉起 AsyncStorage。
  if (request === '../storage/diagnostics.js' || request.endsWith('/diagnostics.js')) {
    return {
      __esModule: true,
      recordDiagnostic: (kind, error, context) => {
        recorded.push({ kind, message: String((error && error.message) || error), context });
      },
    };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolvedBase = path.resolve(path.dirname(parent.filename), request);
    if (resolvedBase.startsWith(`${SRC_DIR}${path.sep}`)) {
      for (const candidate of [resolvedBase, `${resolvedBase}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return loadModule(candidate);
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { createAppLogger } = loadModule(path.resolve('src/logging/index.js'));

test('脱敏器加载失败：省略文本，绝不回落原文', () => {
  recorded.length = 0;
  secretsLoadFails = true;
  try {
    const log = createAppLogger('probe');
    log.error(`请求失败 ${SENTINEL}`);
  } finally {
    secretsLoadFails = false;
  }
  assert.equal(recorded.length, 1, '诊断仍要落地（脱敏降级不该连日志一起丢）');
  assert.equal(recorded[0].message.includes(SENTINEL), false, '诊断里不得出现明文密钥');
  assert.notEqual(recorded[0].message, `请求失败 ${SENTINEL}`, '绝不能回落原文');
  assert.ok(recorded[0].message.length > 0, '应留占位符（省略 ≠ 静默留空）');
});

test('脱敏器加载失败不被缓存：下一次装配会重试并真正脱敏', () => {
  recorded.length = 0;
  secretsLoadFails = true;
  try {
    const first = createAppLogger('probe');
    first.error(`第一次 ${SENTINEL}`);
  } finally {
    secretsLoadFails = false;
  }
  assert.equal(recorded[0].message.includes(SENTINEL), false);
  // 第二次：模块已可加载。旧实现 depsLoaded 早已置位 → 永远拿不到脱敏器 → 仍见原文。
  const second = createAppLogger('probe');
  second.error(`第二次 ${SENTINEL}`);
  assert.equal(recorded.length, 2);
  assert.equal(recorded[1].message.includes(SENTINEL), false, '第二次不得出现原文');
  assert.ok(recorded[1].message.includes('[API_KEY已隐藏]'), '第二次应已重试并拿到脱敏器');
});

test('脱敏器可用时正常脱敏（阳性对照，证明断言能发现泄漏）', () => {
  recorded.length = 0;
  const log = createAppLogger('probe');
  log.warn(`第三次 ${SENTINEL}`);
  assert.equal(recorded[0].message.includes(SENTINEL), false);
  assert.ok(recorded[0].message.includes('[API_KEY已隐藏]'));
});
