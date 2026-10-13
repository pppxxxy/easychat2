// FIX-3：双入口统一启动链的**幂等性与顺序**回归（纯逻辑，用真实 overlay.js + 打桩原生模块）。
//
// 真机 bug：设置页（工作区面板）直接调 startOverlay，从不申请投屏授权 ⇒ 必然失败。
// 修法是两个入口统一走 ensurePermissionThenStart。
//
// 这里重点钉两件容易写错的事：
//   1) 并发调用只走一次链路（原生幂等 + JS 侧 in-flight 复用），连点不叠系统弹窗；
//   2) in-flight 标记的清理**不能**用 async 函数体内的 `finally` —— 存在同步提前返回的
//      分支时，它会在赋值之前先把标记清成 null，随后赋值又把一个**已结算**的 promise
//      钉上去，导致之后所有调用永远拿到那份旧结果、再也不真正启动。
//      （这条正是我在实现时自己踩到并修掉的，写成测试防止改回去。）

import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/screenWatch/overlay.js');

// 用打桩的 NativeModules / DeviceEventEmitter 加载真实的 overlay.js（babel 转 CJS）。
function loadOverlay({ module, listeners = new Map() } = {}) {
  const calls = [];
  const nativeModules = module === undefined ? {} : { ScreenOverlay: module };
  const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const originalLoad = Module._load;
  const diagnostics = [];
  Module._load = function patched(request, parent, isMain) {
    if (request === 'react-native') {
      return {
        NativeModules: nativeModules,
        DeviceEventEmitter: {
          addListener: (event, handler) => {
            listeners.set(event, handler);
            return { remove: () => listeners.delete(event) };
          },
        },
      };
    }
    if (request.endsWith('/diagnostics.js')) {
      return { recordDiagnostic: (kind, error, context) => diagnostics.push({ kind, error, context }) };
    }
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
  return { exports: runtime.exports, calls, diagnostics, listeners };
}

// 一个可编排的原生模块替身。
function makeModule({ canDraw = true, startResults = [true], captureResult = true } = {}) {
  const state = { canDrawCalls: 0, overlayPermCalls: 0, capturePermCalls: 0, startCalls: 0 };
  let startIndex = 0;
  return {
    state,
    module: {
      canDrawOverlays: async () => { state.canDrawCalls += 1; return canDraw; },
      requestOverlayPermission: async () => { state.overlayPermCalls += 1; return true; },
      requestCapturePermission: async () => { state.capturePermCalls += 1; return captureResult; },
      startOverlay: async () => {
        state.startCalls += 1;
        const value = startResults[Math.min(startIndex, startResults.length - 1)];
        startIndex += 1;
        return value;
      },
      stopOverlay: async () => true,
      isOverlayActive: async () => false,
      capture: async () => true,
      updateOverlayText: async () => true,
    },
  };
}

test('ensurePermissionThenStart：权限齐备时直接启动，返回 ok', async () => {
  const { module: native, state } = makeModule({ canDraw: true, startResults: [true] });
  const { exports } = loadOverlay({ module: native });
  const result = await exports.ensurePermissionThenStart();
  assert.deepEqual(result, { ok: true, reason: exports.OVERLAY_START_RESULT.OK });
  assert.equal(state.startCalls, 1);
  // 不需要申请悬浮窗权限（已有）
  assert.equal(state.overlayPermCalls, 0);
});

test('ensurePermissionThenStart：缺悬浮窗权限时跳设置并如实回报（不假装成功）', async () => {
  const { module: native, state } = makeModule({ canDraw: false });
  const { exports } = loadOverlay({ module: native });
  const result = await exports.ensurePermissionThenStart();
  assert.equal(result.ok, false);
  assert.equal(result.reason, exports.OVERLAY_START_RESULT.OVERLAY_PERMISSION);
  assert.equal(state.overlayPermCalls, 1, '要跳系统设置申请');
  assert.equal(state.startCalls, 0, '权限没拿到就不该启动服务');
});

test('ensurePermissionThenStart：startOverlay 返回 false → 报「投屏授权」档', async () => {
  const { module: native } = makeModule({ canDraw: true, startResults: [false] });
  const { exports } = loadOverlay({ module: native });
  const result = await exports.ensurePermissionThenStart();
  assert.equal(result.ok, false);
  assert.equal(result.reason, exports.OVERLAY_START_RESULT.CAPTURE_PERMISSION);
});

test('ensurePermissionThenStart：无原生模块 → unsupported（老构建安全降级）', async () => {
  const { exports } = loadOverlay({});
  const result = await exports.ensurePermissionThenStart();
  assert.equal(result.ok, false);
  assert.equal(result.reason, exports.OVERLAY_START_RESULT.UNSUPPORTED);
});

test('ensurePermissionThenStart：并发调用复用同一次链路（连点不叠系统弹窗）', async () => {
  const { module: native, state } = makeModule({ canDraw: true, startResults: [true] });
  const { exports } = loadOverlay({ module: native });
  const [a, b, c] = await Promise.all([
    exports.ensurePermissionThenStart(),
    exports.ensurePermissionThenStart(),
    exports.ensurePermissionThenStart(),
  ]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(state.startCalls, 1, '三次并发只该启动一次');
  assert.equal(state.canDrawCalls, 1, '三次并发只该查一次权限');
});

test('ensurePermissionThenStart：链路结束后标记必须释放（第二次点击要真的再跑一遍）', async () => {
  // 这条是**防回归**：in-flight 标记若用 async 函数体内的 finally 清理，同步提前返回的
  // 分支（如 unsupported）会把标记清空**早于**赋值，随后赋值又把已结算的 promise 钉上去
  // ⇒ 之后每次调用都返回那份旧结果，且再也不执行链体（用户点了没反应）。
  const { module: native, state } = makeModule({ canDraw: true, startResults: [true, true] });
  const { exports } = loadOverlay({ module: native });
  const first = await exports.ensurePermissionThenStart();
  assert.equal(first.ok, true);
  const second = await exports.ensurePermissionThenStart();
  assert.equal(second.ok, true);
  assert.equal(state.startCalls, 2, '第二次调用必须真的再启动一次（标记已释放）');
});

test('ensurePermissionThenStart：失败后标记也释放（失败不该把链路钉死）', async () => {
  const { module: native, state } = makeModule({ canDraw: true, startResults: [false, true] });
  const { exports } = loadOverlay({ module: native });
  const first = await exports.ensurePermissionThenStart();
  assert.equal(first.ok, false);
  const second = await exports.ensurePermissionThenStart();
  assert.equal(second.ok, true, '第一次失败后，第二次必须是一次全新尝试');
  assert.equal(state.startCalls, 2);
});

test('ensurePermissionThenStart：unsupported 后标记也释放（无原生模块不该永久卡住）', async () => {
  // 这个分支是同步返回的，正是最容易踩上面那个「清早了」陷阱的地方。
  const { exports } = loadOverlay({});
  await exports.ensurePermissionThenStart();
  // 释放后即使换成有模块的替身也……（同一模块实例拿不到新替身，故只验证不抛且可重复调用）
  const again = await exports.ensurePermissionThenStart();
  assert.equal(again.ok, false);
  assert.equal(again.reason, exports.OVERLAY_START_RESULT.UNSUPPORTED);
});

test('原生抛错时按 start-failed 回报，不把异常抛给界面', async () => {
  const module = {
    canDrawOverlays: async () => true,
    requestOverlayPermission: async () => true,
    startOverlay: async () => { throw new Error('boom'); },
  };
  const { exports } = loadOverlay({ module });
  const result = await exports.ensurePermissionThenStart();
  assert.equal(result.ok, false);
  assert.equal(result.reason, exports.OVERLAY_START_RESULT.START_FAILED);
});
