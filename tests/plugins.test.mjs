// 插件化运行时（差距 #2）——纯逻辑行为测试。
// 覆盖 manifest 校验/归一、槽位注册表冲突裁决、沙盒能力门控与超时、市场自检、加载/装配/安装。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizePluginId,
  normalizeManifest,
  validateManifest,
  SLOT_KINDS,
  SLOT_KIND_UNWIRED_REASON,
  slotKindSupport,
} from '../src/workspace/plugins/manifest.js';
import {
  createSlotRegistry,
  priorityOf,
  SLOT_UNWIRED_MARKER_ID,
} from '../src/workspace/plugins/registry.js';
import { createCapabilityContext, compileHandler, runInSandbox } from '../src/workspace/plugins/sandbox.js';
import { SLOT_RENDER_POINTS, UNWIRED_SLOT_KINDS } from '../src/workspace/plugins/slotKinds.js';
import { PLUGIN_MARKET, listMarket, findMarketPlugin } from '../src/workspace/plugins/market.js';
import {
  loadPluginsFromText,
  parsePluginsText,
  serializePlugins,
  buildPluginRuntime,
  loadPluginRuntime,
  installPlugin,
  uninstallPlugin,
  resetPluginsFile,
  PLUGINS_FILE,
} from '../src/workspace/plugins/loader.js';
import { tActive } from '../src/i18n/index.js';
import { localeSource } from './helpers/localeSource.mjs';

// 内存 store（只实现 read/write，够 loader 用）。
// 「文件不存在」按真 store 的口径抛 error.workspace.fileNotFound（store.js:120 /
// safStore.js:178/180）——loader 正是靠这条文案把「首次安装」与「读失败」分开。
function memoryStore(initial = {}) {
  const files = { ...initial };
  return {
    files,
    async readWorkspaceFile({ path }) {
      if (!(path in files)) throw new Error(tActive('error.workspace.fileNotFound', { path }));
      return { content: files[path] };
    },
    async writeWorkspaceFile({ path, content }) { files[path] = String(content); return { ok: true }; },
  };
}

// 读会失败的 store：内容还在，但每一次读都抛（权限 / SAF / 底层 IO）。
function unreadableStore(initial = {}, message = 'permission denied') {
  return {
    ...memoryStore(initial),
    async readWorkspaceFile() { throw new Error(message); },
  };
}

test('manifest：id 归一（小写、非法字符折叠、截断）', () => {
  assert.equal(normalizePluginId('My Plugin!!'), 'my-plugin');
  assert.equal(normalizePluginId('  A__B  '), 'a__b');
  assert.equal(normalizePluginId(''), '');
});

test('manifest：normalize 丢弃非法槽位/工具/权限，保留合法项', () => {
  const m = normalizeManifest({
    id: 'P',
    name: 'P',
    permissions: ['fs.read', 'bogus', 'fs.read'],
    slots: [{ kind: 'settings.row', id: 's', label: 'S' }, { kind: 'nope', id: 'x' }],
    tools: [{ name: 'do', handler: 'return 1' }, { name: '' }],
  });
  assert.equal(m.id, 'p');
  assert.deepEqual(m.permissions, ['fs.read']);
  assert.equal(m.slots.length, 1);
  assert.equal(m.slots[0].kind, 'settings.row');
  assert.equal(m.tools.length, 1);
  assert.equal(m.tools[0].name, 'do');
});

test('manifest：validate 抓缺 id/name、非法 kind/权限、缺 handler', () => {
  assert.equal(validateManifest({ id: 'a', name: 'A' }).ok, true);
  assert.equal(validateManifest({ name: 'A' }).ok, false);
  assert.equal(validateManifest({ id: 'a' }).ok, false);
  const bad = validateManifest({ id: 'a', name: 'A', slots: [{ kind: 'x' }], tools: [{ name: 't' }], permissions: ['zzz'] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 3);
  assert.ok(SLOT_KINDS.includes('settings.row'));
});

test('registry：按优先级渲染 + 冲突裁决（extension > builtin > fallback）', () => {
  const reg = createSlotRegistry();
  reg.add({ kind: 'settings.row', id: 'a', source: 'fallback', contribution: { label: 'F' } });
  const upgraded = reg.add({ kind: 'settings.row', id: 'a', source: 'extension', contribution: { label: 'E' } });
  assert.equal(upgraded.replaced, true);
  const blocked = reg.add({ kind: 'settings.row', id: 'a', source: 'builtin', contribution: { label: 'B' } });
  assert.equal(blocked.conflict, true);
  const rows = reg.render('settings.row');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'E');
  assert.equal(reg.listConflicts().length, 1);
  assert.equal(priorityOf('extension') > priorityOf('builtin'), true);
});

test('registry：不同 id 并存，render 只取本 kind', () => {
  const reg = createSlotRegistry();
  reg.add({ kind: 'settings.row', id: 'a', source: 'builtin', contribution: {} });
  reg.add({ kind: 'settings.row', id: 'b', source: 'builtin', contribution: {} });
  reg.add({ kind: 'chat.header', id: 'c', source: 'builtin', contribution: {} });
  assert.equal(reg.render('settings.row').length, 2);
  // chat.header 未接线：列表最前面会多一条「未接线」标记（见下方专门的用例），
  // 这里只数真实贡献，确认「不同 id 并存且 render 只取本 kind」这条语义没变。
  const chatRows = reg.render('chat.header').filter(item => item.id !== SLOT_UNWIRED_MARKER_ID);
  assert.equal(chatRows.length, 1);
  assert.equal(chatRows[0].id, 'c', 'render 只取本 kind');
  assert.deepEqual(reg.listSlots(), { 'settings.row': 2, 'chat.header': 1 });
});

test('sandbox：能力门控——未授权的能力不注入', () => {
  const ctx = createCapabilityContext({ permissions: [], capabilities: { read: async () => ({ content: 'x' }) } });
  assert.equal(typeof ctx.read, 'undefined', '没授权就没有 read');
  assert.equal(typeof ctx.log, 'function', 'log 永远可用');
  const granted = createCapabilityContext({ permissions: ['fs.read'], capabilities: { read: async () => ({ content: 'x' }) } });
  assert.equal(typeof granted.read, 'function');
});

test('sandbox：runInSandbox 执行 handler 并返回结果 + 日志', async () => {
  const outcome = await runInSandbox(
    'ctx.log("hi"); return args.n * 2;',
    { args: { n: 21 } }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value, 42);
  assert.deepEqual(outcome.logs, ['hi']);
});

test('sandbox：异步能力（await ctx.read）可用；编译错误被兜住', async () => {
  const outcome = await runInSandbox(
    'const r = await ctx.read("a.txt"); return r.content.toUpperCase();',
    { args: {}, permissions: ['fs.read'], capabilities: { read: async () => ({ content: 'abc' }) } }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value, 'ABC');
  const broken = await runInSandbox('return (', { args: {} });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /Unexpected|Invalid|token|unexpected/i);
});

test('sandbox：异步挂死触发超时', async () => {
  const outcome = await runInSandbox('await new Promise(() => {}); return 1;', { args: {}, timeoutMs: 20 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.timedOut, true);
});

test('sandbox：compileHandler 空源码抛错', () => {
  assert.throws(() => compileHandler('   '));
});

test('market：每个条目都过 validateManifest', () => {
  for (const item of PLUGIN_MARKET) {
    const check = validateManifest(item.manifest);
    assert.equal(check.ok, true, `${item.id} 清单非法：${check.errors.join('；')}`);
  }
  assert.equal(findMarketPlugin('TODO-LIST').id, 'todo-list');
  assert.equal(findMarketPlugin('nope'), null);
  assert.ok(listMarket().length >= 2);
});

test('loader：buildPluginRuntime 装配槽位 + 工具 + 钩子', async () => {
  const plugin = normalizeManifest({
    id: 'demo',
    name: 'Demo',
    permissions: ['fs.read'],
    slots: [{ kind: 'settings.row', id: 'row', label: 'R' }],
    tools: [{ name: 'echo', description: 'e', handler: 'return args.x;' }],
    hooks: { before_tool: [{ tool: 'x', effect: 'deny' }] },
  });
  const runtime = buildPluginRuntime([plugin], { capabilities: { read: async () => ({ content: 'z' }) } });
  assert.equal(runtime.pluginIds[0], 'demo');
  assert.equal(runtime.registry.render('settings.row').length, 1);
  assert.equal(runtime.tools.length, 1);
  assert.equal(runtime.tools[0].name, 'plugin_demo_echo');
  const out = await runtime.tools[0].execute({ x: 'hello' });
  assert.equal(out, 'hello');
  assert.equal(runtime.hooks.before_tool.length, 1);
});

test('loader：落盘文本往返 + 损坏输入 → 空', () => {
  const plugin = normalizeManifest({ id: 'a', name: 'A' });
  const text = serializePlugins([plugin]);
  assert.equal(loadPluginsFromText(text).length, 1);
  assert.deepEqual(loadPluginsFromText('{ not json'), []);
  assert.deepEqual(loadPluginsFromText(''), []);
});

test('loader：安装/卸载幂等 + 落盘到 PLUGINS_FILE', async () => {
  const store = memoryStore();
  const first = await installPlugin({ store, manifest: { id: 'x', name: 'X' } });
  assert.equal(first.ok, true);
  assert.equal(store.files[PLUGINS_FILE].includes('"x"'), true);
  // 幂等：再装同 id 不重复
  await installPlugin({ store, manifest: { id: 'x', name: 'X2' } });
  assert.equal(loadPluginsFromText(store.files[PLUGINS_FILE]).length, 1);
  const removed = await uninstallPlugin({ store, id: 'x' });
  assert.equal(removed.ok, true);
  assert.equal(loadPluginsFromText(store.files[PLUGINS_FILE]).length, 0);
  const again = await uninstallPlugin({ store, id: 'x' });
  assert.equal(again.ok, false);
});

test('loader：非法清单被拒（validate 兜底）', async () => {
  const store = memoryStore();
  const result = await installPlugin({ store, manifest: { name: '无 id' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /id/);
});

test('loader：读失败必须拒绝写入，已装插件不被覆盖（不得把「读不到」当成「一个都没装」）', async () => {
  const existing = serializePlugins([normalizeManifest({ id: 'keep', name: 'Keep' })]);
  const store = unreadableStore({ [PLUGINS_FILE]: existing });

  const installed = await installPlugin({ store, manifest: { id: 'new', name: 'New' } });
  assert.equal(installed.ok, false, '读失败必须明确失败');
  assert.match(installed.error, /permission denied/);
  assert.equal(store.files[PLUGINS_FILE], existing, '读失败不得覆盖原清单');

  const removed = await uninstallPlugin({ store, id: 'keep' });
  assert.equal(removed.ok, false, '卸载同样不得在读失败时写入');
  assert.equal(store.files[PLUGINS_FILE], existing, '读失败不得覆盖原清单');
});

test('loader：文件不存在（首次安装）仍可写入——「读不到」与「没有文件」必须区分', async () => {
  const store = memoryStore();
  const result = await installPlugin({ store, manifest: { id: 'x', name: 'X' } });
  assert.equal(result.ok, true, '首次安装：文件还不存在是正常态');
  assert.equal(loadPluginsFromText(store.files[PLUGINS_FILE]).length, 1);
});

test('loader：loadPluginRuntime 把「读失败」与「没有插件」分开透出', async () => {
  const broken = await loadPluginRuntime({ store: unreadableStore() });
  assert.deepEqual(broken.plugins, []);
  assert.equal(broken.status, 'error', '读失败不得被当成「一个插件都没装」');
  assert.match(broken.error, /permission denied/);

  const empty = await loadPluginRuntime({ store: memoryStore() });
  assert.deepEqual(empty.plugins, []);
  assert.equal(empty.status, 'missing', '文件不存在是正常态');
  assert.equal(empty.error, undefined);
});

test('loader：loadPluginRuntime 在无 store 时降级为空运行时', async () => {
  const runtime = await loadPluginRuntime({});
  assert.deepEqual(runtime.pluginIds, []);
  assert.equal(runtime.tools.length, 0);
});

// ---- 内容损坏态（corrupt）----
// 背景：以前「文件在但解析不出来」与「空文件」都被当空，面板于是显示「还没有安装任何插件」，
// 用户既不知道清单坏了、也不知道下一次安装会把旧内容顶掉。而损坏是**永久态**——像读失败
// 那样直接拒绝写入，用户就再也装不上任何插件（面板没有别的修复入口）。
// 所以这里的要求是：如实标出 corrupt，并给一条**显式**的出路（重置），而不是拒绝或静默。
test('loader：内容损坏被识别为 corrupt（不再静默当空）', async () => {
  assert.equal(parsePluginsText('{ "plugins": [ { "id": ').status, 'corrupt', 'JSON 非法 → corrupt');
  assert.equal(parsePluginsText('{"version":1}').status, 'corrupt', '顶层没有 plugins 数组 → corrupt');
  assert.equal(parsePluginsText('[]').status, 'corrupt', '顶层是数组而不是对象 → corrupt');
  assert.equal(parsePluginsText('').status, 'ok', '空文件 = 还没装插件（不是损坏）');
  assert.equal(parsePluginsText(serializePlugins([])).status, 'ok', '空清单是合法状态');
  assert.deepEqual(loadPluginsFromText('{ not json'), [], '兼容入口（只要数组）仍返回空数组');

  const store = memoryStore({ [PLUGINS_FILE]: '{ "plugins": [ { "id": ' });
  const runtime = await loadPluginRuntime({ store });
  assert.equal(runtime.status, 'corrupt', '损坏必须如实透出，不能被当成「一个插件都没装」');
  assert.equal(runtime.reason, 'invalidJson');
  assert.deepEqual(runtime.plugins, []);
});

test('loader：损坏态下安装仍可写入（不能把用户锁死），但要如实告知「已重建」', async () => {
  const corruptText = 'not json at all';
  const store = memoryStore({ [PLUGINS_FILE]: corruptText });
  const installed = await installPlugin({ store, manifest: { id: 'x', name: 'X' } });
  assert.equal(installed.ok, true, '损坏是永久态：拒绝写入 = 用户再也装不上任何插件');
  assert.equal(installed.rebuilt, true, '旧清单是被重建的，必须告知（否则又是一次静默顶掉）');
  assert.equal(store.files[PLUGINS_FILE].includes('"x"'), true);
  assert.equal(loadPluginsFromText(store.files[PLUGINS_FILE]).length, 1);

  // 卸载不能凭「读不到的清单」断言「未安装」——那是它证明不了的事，且不得写入。
  const store2 = memoryStore({ [PLUGINS_FILE]: corruptText });
  const removed = await uninstallPlugin({ store: store2, id: 'x' });
  assert.equal(removed.ok, false);
  assert.match(removed.error, /损坏/);
  assert.equal(store2.files[PLUGINS_FILE], corruptText, '损坏态下的卸载不得写入');
});

test('loader：重置插件清单是显式写路径（损坏可重置；读失败仍拒绝写入）', async () => {
  const store = memoryStore({ [PLUGINS_FILE]: 'not json' });
  const done = await resetPluginsFile({ store });
  assert.equal(done.ok, true);
  assert.equal(parsePluginsText(store.files[PLUGINS_FILE]).status, 'ok', '重置后的内容是合法清单');
  assert.deepEqual(loadPluginsFromText(store.files[PLUGINS_FILE]), [], '重置 = 空清单');

  // 读失败时同样拒绝：读不到就写，等于用空清单覆盖一份可能完好的文件。
  const broken = unreadableStore({ [PLUGINS_FILE]: 'not json' });
  const refused = await resetPluginsFile({ store: broken });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /permission denied/);
  assert.equal(broken.files[PLUGINS_FILE], 'not json', '读失败时重置不得写入');

  assert.equal((await resetPluginsFile({})).ok, false, '没有 store 时安全失败');
});

test('插件面板：损坏给「显式重置」出路，读失败只给提示 + 重试', () => {
  const panel = fs.readFileSync(path.resolve('src/extension/WorkspacePluginsPanel.js'), 'utf8');
  assert.ok(panel.includes("runtimeStatus === 'corrupt'"), '面板按 loader 的 status 分支处理');
  assert.ok(panel.includes("t('workspace.plugins.corrupt')"), '损坏要如实提示（不是「还没装插件」）');
  assert.ok(panel.includes('resetPluginsFile'), '损坏必须给一条修复出路');
  assert.ok(panel.includes("t('workspace.plugins.corrupt.reset')"), '重置入口要有按钮文案');
  assert.ok(
    panel.includes("t('workspace.plugins.corrupt.resetConfirmTitle')")
    && panel.includes("t('workspace.plugins.corrupt.resetConfirmBody')"),
    '重置必须带确认框（用户显式操作，不能自动重置）',
  );
  assert.ok(/const handleReset[\s\S]{0,400}Alert\.alert/.test(panel), '重置走 Alert 确认后才写');
  assert.ok(panel.includes("t('workspace.plugins.readFailed')") && panel.includes("t('common.retry')"),
    '读失败与损坏分开：只提示 + 重试');
  assert.ok(panel.includes('installedEmptyText'), '两态下不得显示「还没有安装任何插件」');

  const zh = localeSource('src/i18n/locales/zh-CN');
  const en = localeSource('src/i18n/locales/en');
  for (const key of [
    'workspace.plugins.corrupt',
    'workspace.plugins.corrupt.reset',
    'workspace.plugins.corrupt.resetConfirmTitle',
    'workspace.plugins.corrupt.resetConfirmBody',
    'workspace.plugins.corrupt.resetConfirmAction',
    'workspace.plugins.corrupt.resetFailTitle',
    'workspace.plugins.corrupt.rebuiltTitle',
    'workspace.plugins.corrupt.rebuiltBody',
    'workspace.plugins.readFailed',
  ]) {
    assert.ok(zh.includes(`'${key}'`) && en.includes(`'${key}'`), `${key} 中英文案齐备`);
  }
});

// ---- 槽位接线守卫（2026-10-12）----
// 背景：manifest 允许 6 种 kind，PluginSlot 也配了 6 种图标，市场里的示例插件用的是
// chat.header——但 src 里唯一的渲染点是 WorkspacePluginsPanel 的 settings.row。也就是说
// 其余 5 种「注册成功、校验通过、永不显示」，而上面的注册层断言（reg.render('chat.header')）
// 照样通过：**假接线在测试上是绿的**。这条守卫要求每种声明的 kind 都有归属：
//   · 真接线 → src 里必须能找到 `<PluginSlot kind="X"`，且接线表里写的就是那个文件；
//   · 未接线 → 必须显式标 null，并由插件面板如实列出（用户至少能看到「注册了什么」）。
// 新增 kind 时必须选一边，不会再默默漏掉。
function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(path.resolve(dir), { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('槽位接线：manifest 声明的每种 kind 都有归属（接线或显式未接线）', () => {
  // 接线表现在住在 workspace/plugins/slotKinds.js（纯数据、零 JSX），直接 import 即可——
  // 比读 PluginSlot.js 源码文本更直接、更不脆（渲染端只是 import + re-export 它）。
  const entries = Object.entries(SLOT_RENDER_POINTS)
    .map(([kind, point]) => ({ kind, point: point || null }));
  assert.deepEqual(
    entries.map(entry => entry.kind).sort(),
    [...SLOT_KINDS].sort(),
    '接线表必须覆盖 manifest 的每一种 kind（不多不少）——新增 kind 时要在这里选边',
  );
  // 未接线必须**显式**标 null（不能靠「漏写一个键」来表达未接线：漏写会被上一条抓到，
  // 但显式 null 才是「我知道它没落点」的可读证据）。
  for (const kind of Object.keys(SLOT_RENDER_POINTS)) {
    const point = SLOT_RENDER_POINTS[kind];
    assert.ok(point === null || typeof point === 'string', `${kind} 的落点只能是文件路径或显式 null`);
  }
  assert.deepEqual(
    [...UNWIRED_SLOT_KINDS].sort(),
    entries.filter(entry => !entry.point).map(entry => entry.kind).sort(),
    'UNWIRED_SLOT_KINDS 必须由接线表派生，不得手写',
  );

  // 真接线的 kind：源码里必须真的有人渲染它
  const callSites = new Set();
  for (const file of collectJsFiles('src')) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<PluginSlot\s+kind="([a-z.]+)"/g)) callSites.add(match[1]);
  }
  for (const entry of entries) {
    if (!entry.point) continue;
    assert.ok(fs.existsSync(path.resolve(entry.point)), `${entry.kind} 的渲染点 ${entry.point} 不存在`);
    assert.ok(
      fs.readFileSync(path.resolve(entry.point), 'utf8').includes(`<PluginSlot kind="${entry.kind}"`),
      `${entry.kind} 声称接在 ${entry.point}，但那里没有渲染它（接线表与代码不一致）`,
    );
    assert.ok(callSites.has(entry.kind), `${entry.kind} 必须真的被渲染（源码里找不到 <PluginSlot kind="${entry.kind}"）`);
  }
  for (const entry of entries) {
    if (entry.point) continue;
    assert.equal(callSites.has(entry.kind), false,
      `${entry.kind} 已经有渲染点了，请把接线表里的 null 改成渲染点文件`);
  }

  // 接线表的字面量定义全仓只有一份（在 slotKinds.js）：渲染端必须只是 import + re-export，
  // 否则「数据端看到的接线表」与「渲染端真正画的那张」又会各走各的。
  const slotSource = fs.readFileSync(path.resolve('src/workspace/screen/PluginSlot.js'), 'utf8');
  assert.ok(
    /import\s*\{[^}]*SLOT_RENDER_POINTS[^}]*\}\s*from\s*'\.\.\/plugins\/slotKinds\.js'/.test(slotSource),
    'PluginSlot.js 必须从 plugins/slotKinds.js import 接线表',
  );
  assert.ok(/export\s*\{\s*SLOT_RENDER_POINTS,\s*UNWIRED_SLOT_KINDS\s*\}/.test(slotSource),
    'PluginSlot.js 必须 re-export 接线表（保持既有 import 方兼容）');
  assert.ok(!/const SLOT_RENDER_POINTS\s*=/.test(slotSource),
    'PluginSlot.js 不得再自带一份接线表字面量');
  const slotKindsSource = fs.readFileSync(path.resolve('src/workspace/plugins/slotKinds.js'), 'utf8');
  assert.ok(/const SLOT_RENDER_POINTS = Object\.freeze\(\{/.test(slotKindsSource),
    '接线表的唯一字面量定义必须在 slotKinds.js');
  // 「未接线」标记是状态信号，不是可渲染的贡献：渲染端与面板都必须先滤掉它，
  // 否则面板会多画一行 __unwired__，而且没装插件时也会列出 5 个空分组。
  assert.ok(/item\.wired === false/.test(slotSource),
    'PluginSlot 必须滤掉「未接线」标记（不能把状态信号画成一行 __unwired__）');
  const panelSource = fs.readFileSync(path.resolve('src/extension/WorkspacePluginsPanel.js'), 'utf8');
  assert.ok(/render\(kind\)\.filter\(item => item\.wired !== false\)/.test(panelSource),
    '插件面板必须滤掉「未接线」标记再判分组是否显示（否则没装插件也会列出 5 个空分组）');

  // 插件面板要如实展示未接线的槽位（注册成功却在任何界面都不出现，才是真正的假接线）
  const panel = fs.readFileSync(path.resolve('src/extension/WorkspacePluginsPanel.js'), 'utf8');
  assert.ok(panel.includes('UNWIRED_SLOT_KINDS'),
    '插件面板必须如实列出未接线槽位——注册成功却在任何界面都不出现，才是真正的假接线');
});

// ---- 未接线 kind 的「暂不支持」标注（manifest 派生 + registry 显式提示）----
// 上面那条守卫保证「接线表 ↔ manifest 的 SLOT_KINDS」集合相等；这一条证明运行期也能区分
// 「注册成功」与「会显示」——manifest.js / registry.js 现在**直接 import** 同一张接线表
//（它住在纯数据的 slotKinds.js 里，不再是 JSX 的 PluginSlot.js），所以两边看到的是同一份。
test('未接线 kind 必须被标为暂不支持（派生自接线表，不手写第二份清单）', () => {
  const unwired = [...UNWIRED_SLOT_KINDS];
  assert.ok(unwired.length > 0, '接线表里应当确实存在未接线的 kind（否则这条断言空转）');

  const support = slotKindSupport();
  // ① 覆盖面与顺序都由 SLOT_KINDS 派生：manifest 里不得出现第二份 kind 字面量清单
  assert.deepEqual(support.map(item => item.kind), [...SLOT_KINDS], '支持表必须由 SLOT_KINDS 派生');
  // ② 未接线的那些标 unsupported + 原因；其余可用
  assert.deepEqual(
    support.filter(item => !item.supported).map(item => item.kind).sort(),
    [...unwired].sort(),
    '暂不支持的 kind 必须恰好是接线表里标 null 的那些',
  );
  for (const item of support) {
    if (item.supported) assert.equal(item.reason, '', `${item.kind} 可用时不应带原因`);
    else assert.equal(item.reason, SLOT_KIND_UNWIRED_REASON, `${item.kind} 必须给出「未接线」原因`);
  }
  // ③ 显式传入时以传入值为准（可注入，便于单测某一种 kind）
  assert.deepEqual(slotKindSupport([]).map(item => item.supported), SLOT_KINDS.map(() => true));
  assert.ok(Object.isFrozen(support), '派生结果必须冻结');
});

test('registry.render：未接线的 kind 返回明确的「未接线」提示，而不是静默空列表', () => {
  const kind = UNWIRED_SLOT_KINDS[0];
  // 缺省即接线表派生值：不需要调用方注入，运行期自己就知道哪些 kind 没落点
  const reg = createSlotRegistry();
  reg.add({ kind, id: 'demo', source: 'extension', contribution: { label: '演示' } });

  const rows = reg.render(kind);
  assert.equal(rows.length, 2, '未接线标记 + 真实贡献');
  assert.equal(rows[0].id, SLOT_UNWIRED_MARKER_ID);
  assert.equal(rows[0].wired, false, '标记必须显式写明未接线');
  assert.equal(rows[0].reason, SLOT_KIND_UNWIRED_REASON);
  assert.equal(rows[1].label, '演示', '真实贡献仍然照常返回（标记在最前，不吞掉贡献）');

  // 未接线且**没有任何贡献**时也不许静默返回空——「这里没有落点」本身就是要说的话
  const otherUnwired = UNWIRED_SLOT_KINDS[1];
  assert.equal(reg.render(otherUnwired)[0].reason, SLOT_KIND_UNWIRED_REASON);
  assert.equal(reg.render(otherUnwired).length, 1, '只有标记，没有贡献');

  // 已接线的 kind 不出现未接线标记
  assert.deepEqual(
    reg.render('settings.row').filter(item => item.id === SLOT_UNWIRED_MARKER_ID),
    [],
    '已接线的 kind 不得出现未接线标记',
  );
  // 显式注入空清单 = 全部视为已接线（保留可注入的旧口径，供只想验单一 kind 的场景）
  const wiredOnly = createSlotRegistry({ unwiredKinds: [] });
  wiredOnly.add({ kind, id: 'demo', source: 'extension', contribution: { label: '演示' } });
  assert.equal(wiredOnly.render(kind).length, 1, '注入空清单时保持「全部已接线」口径');
});
