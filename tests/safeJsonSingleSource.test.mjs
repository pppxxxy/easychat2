// 「安全 JSON 助手只有一份实现」这条结构性不变量（回归 2026-10-12 审查待办第 2 项）。
//
// 背景：JSON.parse / JSON.stringify 的 try-catch 包装曾在四处各写一份——
// agent/sdk.js 的 safeJson、apiProtocols/messages.js 的 safeParseJson、
// workspace/plugins/sandbox.js 与 workspace/plugins/loader.js 的 safeJson（后两份逐字相同）。
// 语义其实是两个方向（解析回退 vs 序列化回退），所以唯一实现导出两个函数；
// 本文件既钉「只有一份」，也用真模块钉住两个方向的行为。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const IMPLEMENTATION = 'src/utils/safeJson.js';
const CONSUMERS = [
  'src/agent/sdk.js',
  'src/apiProtocols/messages.js',
  'src/workspace/plugins/sandbox.js',
  'src/workspace/plugins/loader.js',
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

// 本地定义的 JSON 包装函数（两种命名 + 两种写法）。
const LOCAL_DEFINITIONS = [
  /function\s+safeJson\s*\(/,
  /function\s+safeParseJson\s*\(/,
  /const\s+safeJson\s*=\s*\(/,
  /const\s+safeJsonStringify\s*=/,
  /const\s+safeJsonParse\s*=/,
];

test('safeJson 助手只有一份实现，消费方一律引用它', () => {
  for (const file of CONSUMERS) {
    const source = fs.readFileSync(path.resolve(file), 'utf8');
    assert.ok(
      source.includes('utils/safeJson.js'),
      `${file} 必须从唯一实现（${IMPLEMENTATION}）引用 safeJson 助手`
    );
    for (const pattern of LOCAL_DEFINITIONS) {
      assert.ok(
        !pattern.test(source),
        `${file} 不得再手写一份 JSON try-catch 包装（副本就是这样长出来的）`
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

test('safeJsonParse：合法 JSON 解出来，非法/空一律给回退值', () => {
  const { safeJsonParse } = loadModule(path.resolve(IMPLEMENTATION));
  assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
  assert.equal(safeJsonParse('not json', 'RAW'), 'RAW', '回退是调用方指定的值（sdk 要原文）');
  assert.equal(safeJsonParse('not json'), null, '默认回退是 null（apiProtocols 要 null）');
  assert.equal(safeJsonParse(''), null, '空串不是合法 JSON');
  assert.equal(safeJsonParse('{"a":1}', 'RAW').a, 1, '合法时不使用回退');
});

test('safeJsonStringify：正常序列化，循环引用退化成 String(value)', () => {
  const { safeJsonStringify } = loadModule(path.resolve(IMPLEMENTATION));
  assert.equal(safeJsonStringify({ a: 1 }), '{"a":1}');
  const circular = { name: 'x' };
  circular.self = circular;
  assert.equal(safeJsonStringify(circular), '[object Object]', '循环引用不抛，退化成 String(value)');
  assert.equal(safeJsonStringify(undefined), undefined, '与 JSON.stringify 原生行为一致（undefined 不抛）');
});
