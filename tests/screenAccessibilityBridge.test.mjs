// 无障碍权限桥（src/screenWatch/overlay.js 的无障碍部分）行为测试。
//
// 为什么单独一个文件：overlay.js 顶层 import react-native，Node 里 `require('react-native')`
// 会因 Flow 语法直接抛 `Unexpected token 'typeof'`，所以这里按仓库既有范式（见
// tests/screenWatch.test.mjs 的 comments.js 加载）先 babel 转译源码、再打桩
// Module._load 注入一个**假的 NativeModules.ScreenOverlay**，然后编译执行真实模块。
// 断言打的是真实导出函数的行为，不是源码字符串。
//
// 覆盖的关键判定（改回错写法就会变红）：
// - 原生模块缺失 / 方法缺失 → 一律返回 false（不抛错、不假装成功）；
// - 原生 reject/throw → 也返回 false（引导用户去开启，而不是弹一个他无法处置的错误）；
// - 真值/假值如实透传（不把 'true' 字符串之类的假值当真）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const sourcePath = path.resolve('src/screenWatch/overlay.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

// 可替换的原生模块替身：测试通过 setNative 换掉它再调真实导出函数。
let native = null;
const reactNativeStub = {
  NativeModules: {},
  DeviceEventEmitter: { addListener: () => ({ remove() {} }) },
};
Object.defineProperty(reactNativeStub.NativeModules, 'ScreenOverlay', {
  get: () => native,
  configurable: true,
});

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'react-native') return reactNativeStub;
  return originalLoad.call(this, request, parent, isMain);
};
const runtime = new Module(sourcePath);
runtime.filename = sourcePath;
runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
try {
  runtime._compile(transformed, sourcePath);
} finally {
  Module._load = originalLoad;
}
const overlay = runtime.exports;

test('原生模块缺失：无障碍查询与跳转都如实返回 false，不抛错', async () => {
  native = null;
  assert.equal(await overlay.isAccessibilityEnabled(), false);
  assert.equal(await overlay.openAccessibilitySettings(), false);
});

test('原生方法缺失（旧构建）：按未开启/未跳转处理，不假装成功', async () => {
  native = {};
  assert.equal(await overlay.isAccessibilityEnabled(), false);
  assert.equal(await overlay.openAccessibilitySettings(), false);
});

test('无障碍已开启：如实透传 true', async () => {
  let asked = 0;
  native = {
    isAccessibilityEnabled: async () => { asked += 1; return true; },
    openAccessibilitySettings: async () => true,
  };
  assert.equal(await overlay.isAccessibilityEnabled(), true);
  assert.equal(asked, 1, '必须真的问到原生');
  assert.equal(await overlay.openAccessibilitySettings(), true);
});

test('无障碍未开启：如实透传 false（不能把未开启说成已开启）', async () => {
  native = {
    isAccessibilityEnabled: async () => false,
    openAccessibilitySettings: async () => true,
  };
  assert.equal(await overlay.isAccessibilityEnabled(), false);
});

test('原生查询抛错：按未开启降级，不把错误抛给界面', async () => {
  native = {
    isAccessibilityEnabled: async () => { throw new Error('boom'); },
    openAccessibilitySettings: async () => { throw new Error('boom'); },
  };
  assert.equal(await overlay.isAccessibilityEnabled(), false);
  assert.equal(await overlay.openAccessibilitySettings(), false);
});

test('原生返回非布尔真值/假值：一律折成布尔', async () => {
  native = { isAccessibilityEnabled: async () => 1, openAccessibilitySettings: async () => 0 };
  assert.equal(await overlay.isAccessibilityEnabled(), true);
  assert.equal(await overlay.openAccessibilitySettings(), false, '0 是假值，不得当成成功');
});

test('无障碍桥不影响既有悬浮窗桥：同一模块里旧方法仍在且共用同一原生对象', async () => {
  native = {
    canDrawOverlays: async () => true,
    isOverlayActive: async () => true,
    isAccessibilityEnabled: async () => true,
  };
  assert.equal(await overlay.canDrawOverlays(), true);
  assert.equal(await overlay.isOverlayActive(), true);
  assert.equal(await overlay.isAccessibilityEnabled(), true);
  assert.equal(overlay.isOverlaySupported(), true);
});
