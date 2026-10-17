// 卡顿取证（perfProbe）的行为测试。
//
// 为什么要它：这一轮排查里，「整体卡 / 越用越卡」在代码层没有单一元凶——渲染层
//（虚拟化 / memo / 样式）与纯 JSON 开销（实测 2000 条仅约 1ms）都已被验证过。
// 继续靠读代码猜只会瞎改，所以必须能在真机上**量化**：哪一段慢、慢多少。
//
// 三条不变量：① 默认关闭时零副作用（不记日志、不改行为）；② 只在超过阈值时记录；
// ③ 记录走既有 recordDiagnostic（自动脱敏/去重/只留 50 条），样本只在内存里。

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

// ---- 界面接线：诊断面板里的开关 + 启动同步（RN 组件在 Node 里没法渲染，按仓库约定
// 用源码锚点验「接线存在且约束成立」；行为部分见 tests/perfProbeBootstrap.test.mjs
// 与 tests/settingsReadStateGuard.test.mjs）。----

const MODAL = fs.readFileSync(path.join(SRC_DIR, 'DiagnosticsModal.js'), 'utf8');
const APP = fs.readFileSync(path.resolve('App.js'), 'utf8');
const ZH_DIAG = fs.readFileSync(path.join(SRC_DIR, 'i18n', 'locales', 'zh-CN', 'diagnostics.js'), 'utf8');
const EN_DIAG = fs.readFileSync(path.join(SRC_DIR, 'i18n', 'locales', 'en', 'diagnostics.js'), 'utf8');

test('接线：诊断面板有开关，且「内存态 → 落盘」的顺序不得颠倒', () => {
  assert.ok(MODAL.includes("from './logging/perfProbe.js'"), '面板必须直接用探针的内存态开关');
  assert.ok(MODAL.includes('setPerfProbeEnabled'), '必须同步内存态（否则开关点了探针没在记）');
  assert.ok(MODAL.includes('getPerfProbeEnabled'), '面板打开时要读盘上的开关');
  assert.ok(MODAL.includes('savePerfProbeEnabled'), '必须落盘（否则重启后回到关闭）');
  assert.ok(MODAL.includes('<Switch'), '开关控件必须在');
  assert.ok(MODAL.includes('value={perfEnabled}') && MODAL.includes('onValueChange={togglePerf}'), '开关必须双向绑定');
  const toggle = MODAL.slice(MODAL.indexOf('const togglePerf = useCallback('));
  const memAt = toggle.indexOf('setPerfProbeEnabled(value);');
  const diskAt = toggle.indexOf('savePerfProbeEnabled(value)');
  assert.ok(memAt >= 0 && diskAt > memAt, '必须先同步内存态再落盘（落盘是异步的，反过来会有一段时间界面开了但探针没开）');
  // 落盘失败必须还原：否则界面显示已开启、重启后是关闭，用户会以为「没卡顿」。
  assert.ok(
    /savePerfProbeEnabled\(value\)\.catch\(\(\) => \{\s*setPerfProbeEnabled\(!value\);/.test(toggle),
    '落盘失败必须把内存态与界面一起还原，并提示'
  );
});

test('接线：面板能看样本、清样本（否则取证到了也读不出来）', () => {
  // 断言**调用点**而不是「名字出现过」：光看名字的话，把调用删掉、只留 import（或反过来）
  // 依然能骗过守卫——上一版就是这么写的，注入验证时它没红。
  assert.ok(MODAL.includes('setPerfSamples(getPerfSamples())'), '必须真的读样本（打开时 + 刷新）');
  assert.ok(MODAL.includes('clearPerfSamples();'), '必须真的清空样本');
  assert.ok(MODAL.includes('summarizePerfSamples(perfSamples)'), '条数/最慢一条必须来自实时样本');
  assert.ok(MODAL.includes('refreshPerfSamples'), '面板不关也能刷新样本');
});

test('接线：App 启动时把持久化开关同步回探针', () => {
  assert.ok(APP.includes("from './src/startup/perfProbeBootstrap.js'"), 'App 必须引入启动同步');
  assert.ok(APP.includes('bootstrapPerfProbe()'), '启动必须真的调用它');
  assert.ok(APP.includes('bootstrapPerfProbe().catch(() => {})'), '启动同步失败不得影响启动');
});

test('词条：perf 开关的中英必须一一对齐（漏一条就会在界面上显示原始键名）', () => {
  // 键名允许数字（如 switchA11y）——用 [A-Za-z.] 会漏掉它，于是「中英对齐」这条守卫
  // 自己先漏检一条，属于最糟的一类假绿。
  const keysOf = source => [...source.matchAll(/'(diagnostics\.perf\.[A-Za-z0-9.]+)':/g)].map(m => m[1]);
  const zh = keysOf(ZH_DIAG);
  const en = keysOf(EN_DIAG);
  assert.ok(zh.length >= 10, `zh-CN 的 perf 词条太少，实际 ${zh.length} 条`);
  for (const key of zh) assert.ok(en.includes(key), `en 缺 ${key}`);
  for (const key of en) assert.ok(zh.includes(key), `zh-CN 缺 ${key}`);
});
