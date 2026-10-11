// 插件化运行时（差距 #2）——纯逻辑行为测试。
// 覆盖 manifest 校验/归一、槽位注册表冲突裁决、沙盒能力门控与超时、市场自检、加载/装配/安装。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePluginId,
  normalizeManifest,
  validateManifest,
  SLOT_KINDS,
} from '../src/workspace/plugins/manifest.js';
import { createSlotRegistry, priorityOf } from '../src/workspace/plugins/registry.js';
import { createCapabilityContext, compileHandler, runInSandbox } from '../src/workspace/plugins/sandbox.js';
import { PLUGIN_MARKET, listMarket, findMarketPlugin } from '../src/workspace/plugins/market.js';
import {
  loadPluginsFromText,
  serializePlugins,
  buildPluginRuntime,
  loadPluginRuntime,
  installPlugin,
  uninstallPlugin,
  PLUGINS_FILE,
} from '../src/workspace/plugins/loader.js';

// 内存 store（只实现 read/write，够 loader 用）。
function memoryStore(initial = {}) {
  const files = { ...initial };
  return {
    files,
    async readWorkspaceFile({ path }) {
      if (!(path in files)) throw new Error('not found');
      return { content: files[path] };
    },
    async writeWorkspaceFile({ path, content }) { files[path] = String(content); return { ok: true }; },
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
  assert.equal(reg.render('chat.header').length, 1);
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

test('loader：loadPluginRuntime 在无 store 时降级为空运行时', async () => {
  const runtime = await loadPluginRuntime({});
  assert.deepEqual(runtime.pluginIds, []);
  assert.equal(runtime.tools.length, 0);
});
