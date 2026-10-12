// 插件化运行时（差距 #2）——纯逻辑行为测试。
// 覆盖 manifest 校验/归一、槽位注册表冲突裁决、沙盒能力门控与超时、市场自检、加载/装配/安装。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  normalizePluginId,
  normalizeManifest,
  validateManifest,
  SLOT_KINDS,
  PLUGIN_CATEGORIES,
  DEFAULT_PLUGIN_CATEGORY,
  inferPluginCategory,
  normalizePluginCategory,
  groupPluginsByCategory,
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
import { tActive } from '../src/i18n/index.js';

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

// —— 插件归类（工作区 / 聊天 / 功能 / 其他）——

test('归类：显式声明优先，写了非法值算校验失败（不静默回落）', () => {
  const declared = normalizeManifest({ id: 'a', name: 'A', category: 'chat', slots: [{ kind: 'files.toolbar', id: 'x' }] });
  assert.equal(declared.category, 'chat', '声明优先于推断（哪怕推断会得出 workspace）');
  for (const category of PLUGIN_CATEGORIES) {
    assert.equal(normalizeManifest({ id: 'a', name: 'A', category }).category, category);
  }
  // 写了但非法：校验必须报错——静默回落会让作者以为声明生效了
  const bad = validateManifest({ id: 'a', name: 'A', category: 'nope' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(error => error.includes('category')));
  // 没写：不算错，走推断
  assert.equal(validateManifest({ id: 'a', name: 'A' }).ok, true);
  assert.equal(normalizeManifest({ id: 'a', name: 'A', category: 'nope' }).category, DEFAULT_PLUGIN_CATEGORY);
});

test('归类推断：按「贡献了什么」判定，判定顺序稳定', () => {
  // 读写工作区文件的工具 → 工作区插件
  assert.equal(inferPluginCategory({ tools: [{ name: 't' }], permissions: ['fs.read'] }), 'workspace');
  assert.equal(inferPluginCategory({ tools: [{ name: 't' }], permissions: ['fs.write'] }), 'workspace');
  // 工作区能力优先于聊天界面：同时有两者时算工作区（能改工作区的插件本质是工作区插件）
  assert.equal(
    inferPluginCategory({ tools: [{ name: 't' }], permissions: ['fs.write'], slots: [{ kind: 'chat.header' }] }),
    'workspace',
  );
  // 聊天界面槽位 → 聊天插件
  assert.equal(inferPluginCategory({ slots: [{ kind: 'chat.header' }] }), 'chat');
  assert.equal(inferPluginCategory({ slots: [{ kind: 'composer.button' }] }), 'chat');
  assert.equal(inferPluginCategory({ slots: [{ kind: 'message.action' }] }), 'chat');
  // 工作区界面槽位 → 工作区插件
  assert.equal(inferPluginCategory({ slots: [{ kind: 'files.toolbar' }] }), 'workspace');
  // 钩子 / 不需要工作区权限的工具 → 功能插件
  assert.equal(inferPluginCategory({ hooks: { before_tool: [] } }), 'feature');
  assert.equal(inferPluginCategory({ tools: [{ name: 't' }], permissions: ['notify'] }), 'feature');
  // 只有一行设置项、或什么都没有 → 其他（「其他」就是不属于前三类的兜底）
  assert.equal(inferPluginCategory({ slots: [{ kind: 'settings.row' }] }), 'other');
  assert.equal(inferPluginCategory({}), 'other');
  assert.equal(inferPluginCategory(null), 'other');
  // 归一入口：合法值原样，非法/缺失走推断
  assert.equal(normalizePluginCategory(' workspace ', {}), 'workspace');
  assert.equal(normalizePluginCategory('nope', { slots: [{ kind: 'chat.footer' }] }), 'chat');
});

test('分组：顺序固定、空组不出现、未知归类落「其他」', () => {
  const groups = groupPluginsByCategory([
    { id: 'o1', category: 'other' },
    { id: 'c1', category: 'chat' },
    { id: 'w1', category: 'workspace' },
    { id: 'c2', category: 'chat' },
    { id: 'x1' },
    { id: 'x2', category: '不认识的归类' },
  ]);
  assert.deepEqual(groups.map(group => group.category), ['workspace', 'chat', 'other'], '功能组为空 → 不出现');
  assert.deepEqual(groups.map(group => group.items.map(item => item.id)), [['w1'], ['c1', 'c2'], ['o1', 'x1', 'x2']]);
  assert.deepEqual(groupPluginsByCategory([]), []);
  assert.deepEqual(groupPluginsByCategory(null), []);
});

test('分组：四类齐全时按 工作区 → 聊天 → 功能 → 其他 排列', () => {
  const groups = groupPluginsByCategory(
    PLUGIN_CATEGORIES.slice().reverse().map(category => ({ id: category, category })),
  );
  assert.deepEqual(groups.map(group => group.category), [...PLUGIN_CATEGORIES]);
});

test('market：每个条目都显式声明合法归类，listMarket 暴露的与落盘的一致', () => {
  for (const item of PLUGIN_MARKET) {
    assert.ok(
      PLUGIN_CATEGORIES.includes(item.manifest.category),
      `${item.id} 必须显式声明 category（内置条目的归类是产品裁决，不该靠推断漂移）`,
    );
    assert.equal(validateManifest(item.manifest).ok, true, `${item.id} 清单非法`);
  }
  for (const item of listMarket()) {
    assert.equal(item.category, item.manifest.category, `${item.id} 的展示归类必须等于安装后落盘的归类`);
    assert.equal(normalizeManifest(item.manifest).category, item.category, `${item.id} 归一化后归类不得改变`);
  }
});

test('归类随安装落盘：装 → 序列化 → 读回，category 不丢', async () => {
  const store = memoryStore();
  const manifest = normalizeManifest({
    id: 'cat-demo',
    name: 'Cat Demo',
    category: 'chat',
    slots: [{ kind: 'chat.header', id: 'h', label: 'H' }],
  });
  await installPlugin({ store, manifest });
  const text = store.files[PLUGINS_FILE];
  assert.equal(JSON.parse(text).plugins[0].category, 'chat');
  const loaded = await loadPluginRuntime({ store, capabilities: {} });
  assert.equal(loaded.plugins[0].category, 'chat');
});

test('UI 接线：插件面板对「已安装」与「内置市场」都按归类分组', () => {
  const source = readFileSync(path.resolve('src/extension/WorkspacePluginsPanel.js'), 'utf8');
  assert.ok(source.includes('groupPluginsByCategory'), '面板用归类分组');
  assert.equal((source.match(/groupPluginsByCategory\(/g) || []).length, 2, '两个列表各分一次组');
  for (const category of PLUGIN_CATEGORIES) {
    assert.ok(source.includes(`workspace.plugins.category.${category}`), `${category} 的文案 key 已接线`);
  }
  assert.ok(source.includes('styles.groupLabel'), '分组标题有独立样式');
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
  const slotSource = fs.readFileSync(path.resolve('src/workspace/screen/PluginSlot.js'), 'utf8');
  const table = /const SLOT_RENDER_POINTS = Object\.freeze\(\{([\s\S]*?)\n\}\)/.exec(slotSource);
  assert.ok(table, 'SLOT_RENDER_POINTS 必须是模块级对象字面量（接线表的单一事实源）');
  const entries = [...table[1].matchAll(/'([a-z.]+)':\s*(null|'([^']+)')/g)]
    .map(match => ({ kind: match[1], point: match[3] || null }));
  assert.deepEqual(
    entries.map(entry => entry.kind).sort(),
    [...SLOT_KINDS].sort(),
    '接线表必须覆盖 manifest 的每一种 kind（不多不少）——新增 kind 时要在这里选边',
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

  // 未接线列表必须是**派生**的（别手写第二份），且插件面板要如实展示未接线的槽位
  const derived = /const UNWIRED_SLOT_KINDS = Object\.freeze\(([\s\S]*?)\);/.exec(slotSource);
  assert.ok(derived, 'UNWIRED_SLOT_KINDS 必须存在');
  assert.ok(derived[1].includes('SLOT_RENDER_POINTS'), '未接线列表必须由接线表派生，不得手写');
  const panel = fs.readFileSync(path.resolve('src/extension/WorkspacePluginsPanel.js'), 'utf8');
  assert.ok(panel.includes('UNWIRED_SLOT_KINDS'),
    '插件面板必须如实列出未接线槽位——注册成功却在任何界面都不出现，才是真正的假接线');
});
