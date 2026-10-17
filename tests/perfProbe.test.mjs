// 卡顿取证（perfProbe）的行为测试。
//
// 为什么要它：这一轮排查里，「整体卡 / 越用越卡」在代码层没有单一元凶——渲染层
//（虚拟化 / memo / 样式）与纯 JSON 开销（实测 2000 条仅约 1ms）都已被验证过。
// 继续靠读代码猜只会瞎改，所以必须能在真机上**量化**：哪一段慢、慢多少。
//
// 三条不变量：① 默认关闭时零副作用（不记日志、不改行为）；② 只在超过阈值时记录；
// ③ 记录走既有 recordDiagnostic（自动脱敏/去重/只留 50 条），不新建存储键。

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

const recorded = [];
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('/storage/diagnostics.js') || request === '../storage/diagnostics.js') {
    return { __esModule: true, recordDiagnostic: (kind, error, ctx) => recorded.push({ kind, msg: String((error && error.message) || error), ctx }) };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const base = path.resolve(path.dirname(parent.filename), request);
    if (base.startsWith(`${SRC_DIR}${path.sep}`)) {
      const file = fs.existsSync(base) ? base : `${base}.js`;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const code = babel.transformSync(fs.readFileSync(file, 'utf8'), {
          babelrc: false, configFile: false, filename: file,
          presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
        }).code;
        const mod = new Module(file);
        mod.filename = file;
        mod.paths = Module._nodeModulePaths(path.dirname(file));
        mod._compile(code, file);
        return mod.exports;
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;
const probePath = path.join(SRC_DIR, 'logging', 'perfProbe.js');
const code = babel.transformSync(fs.readFileSync(probePath, 'utf8'), {
  babelrc: false, configFile: false, filename: probePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const mod = new Module(probePath);
mod.filename = probePath;
mod.paths = Module._nodeModulePaths(path.dirname(probePath));
mod._compile(code, probePath);
const probe = mod.exports;

test.beforeEach(() => {
  recorded.length = 0;
  probe.__resetPerfProbeForTests();
});

test('perfProbe：默认关闭——不记录、行为原样返回', async () => {
  assert.equal(probe.isPerfProbeEnabled(), false, '默认必须关闭');
  const value = probe.measureSync('render', () => 42, 0);
  assert.equal(value, 42, '关闭时也要原样返回结果');
  const asyncValue = await probe.measureAsync('read', async () => 'x', 0);
  assert.equal(asyncValue, 'x');
  assert.equal(recorded.length, 0, '关闭时不得产生任何诊断');
  assert.equal(probe.getPerfSamples().length, 0, '关闭时不得留样本');
});

test('perfProbe：启用后超过阈值才记录（未超阈值不记）', () => {
  probe.setPerfProbeEnabled(true);
  // 阈值设成极大 → 不应记录
  probe.measureSync('render', () => 1, 1e9);
  assert.equal(recorded.length, 0, '未超过阈值不得记录');
  // 阈值 0 → 一定超过（任何耗时 > 0，或至少 >= 0 时用负阈值保证触发）
  probe.measureSync('render', () => 1, -1);
  assert.equal(recorded.length, 1, '超过阈值必须记录一条');
  assert.ok(recorded[0].msg.includes('[perf] render'), '记录内容要能定位是哪一段');
  assert.equal(recorded[0].ctx, 'perf');
});

test('perfProbe：同步段抛错也要计时后原样抛出（慢的失败同样卡）', () => {
  probe.setPerfProbeEnabled(true);
  assert.throws(() => probe.measureSync('render', () => { throw new Error('boom'); }, -1), /boom/);
  assert.equal(recorded.length, 1, '抛错路径也要留一条（finally 里记）');
});

test('perfProbe：异步段抛错同样计时并原样抛出', async () => {
  probe.setPerfProbeEnabled(true);
  await assert.rejects(() => probe.measureAsync('read', async () => { throw new Error('bad'); }, -1), /bad/);
  assert.equal(recorded.length, 1);
});

test('perfProbe：样本只在内存里、且有上限（探针不能自己变成泄漏）', () => {
  probe.setPerfProbeEnabled(true);
  for (let i = 0; i < 250; i += 1) probe.measureSync('render', () => 1, -1);
  const samples = probe.getPerfSamples();
  assert.ok(samples.length <= 200, `样本上限 200，实际 ${samples.length}`);
  assert.ok(samples.every(s => typeof s.ms === 'number' && s.label === 'render'));
});

test('接线：会话读数与消息读数都进了探针（否则真机上拿不到这两段）', () => {
  const appContext = fs.readFileSync(path.join(SRC_DIR, 'context', 'AppContext.js'), 'utf8');
  assert.ok(appContext.includes("measureAsync(\n      'app.refreshSessions'") || appContext.includes("'app.refreshSessions'"),
    '会话列表刷新必须进探针');
  const sessionMessages = fs.readFileSync(path.join(SRC_DIR, 'chat', 'useSessionMessages.js'), 'utf8');
  assert.ok(sessionMessages.includes("'session.loadMessages'"), '消息读取必须进探针');
});

test('回归：向量记忆关闭时不得去读/写整条索引（每次落盘都会付几 MB 的读写代价）', () => {
  // 失效模式：此前落盘后无条件调 updateVectorIndex。而 indexMessages 在开关关闭时
  // 原样返回 current（vectorMemory/index.js:329-331），于是这次调用既付出「读整条索引」
  // 的代价（getItem + JSON.parse + normalizeVectorIndex，都是 O(条数×维度)），又把同一份
  // 内容整键写回。实测 1024 维：1000 条 ≈ 19.8 MB 单键（parse 71ms、stringify 145ms），
  // 且超过 CursorWindow 约 2MB 上限后走 SQLite 分块兜底读。
  // 这是「关掉向量记忆也一样卡」的由来之一：必须真的提前返回。
  const sessionMessages = fs.readFileSync(path.join(SRC_DIR, 'chat', 'useSessionMessages.js'), 'utf8');
  assert.ok(
    sessionMessages.includes('if (config.enabled !== true) return null;'),
    '向量记忆关闭时必须在读索引之前就返回'
  );
  const skipIndex = sessionMessages.indexOf('if (config.enabled !== true) return null;');
  const readIndex = sessionMessages.indexOf('updateVectorIndex(');
  assert.ok(readIndex > skipIndex, '提前返回必须发生在 updateVectorIndex 之前');
});
