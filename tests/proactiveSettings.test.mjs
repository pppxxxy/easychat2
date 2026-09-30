import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/storage.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => {
    store.set(key, value);
  },
  removeItem: async key => {
    store.delete(key);
  },
  multiSet: async pairs => {
    for (const [key, value] of pairs) store.set(key, value);
  },
  multiRemove: async keys => {
    for (const key of keys) store.delete(key);
  },
  getAllKeys: async () => [...store.keys()],
};

const FileSystem = {
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: async () => ({ exists: false }),
  makeDirectoryAsync: async () => {},
  writeAsStringAsync: async () => {},
  readAsStringAsync: async () => '',
  readDirectoryAsync: async () => [],
  deleteAsync: async () => {},
};

const SQLite = { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };

const STORAGE_DIR = path.resolve('src/storage');

// storage.js 会 require 拆出的 src/storage/*.js；这些模块是 ESM，若走 require(esm)
// 其内部依赖会绕过 Module._load 打桩。这里按需把它们转成 CJS 再加载。
function loadStorageModule(absPath) {
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
  // 写入 Module._cache，让多个子模块 import 同一 sessionCore 时拿到同一实例
  // （匹配真实 ESM 单例语义，避免模块级共享状态被复制成多份）。
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
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === 'expo-file-system') return FileSystem;
  if (request === 'expo-sqlite') return SQLite;
  if (request.endsWith('/presets') || request === './presets.js') {
    return { __esModule: true, default: [] };
  }
  if (request.endsWith('/imageGen/providers') || request === './imageGen/providers.js') {
    return { __esModule: true, isKnownImageProvider: () => true };
  }
  if (request.endsWith('/cardForge/forge') || request === './cardForge/forge.js') {
    return {
      __esModule: true,
      FORGE_FIELDS: ['description'],
      FORGE_QUESTIONS: [],
      MAX_PRESERVED_TEXT: 500000,
      MAX_PRESERVED_ITEMS: 2000,
    };
  }
  if (request.endsWith('/moments/moments') || request === './moments/moments.js') {
    return { __esModule: true, removeMomentsBySessionIds: async () => {} };
  }
  if (request.endsWith('/context/characterIdentity') || request === './context/characterIdentity.js') {
    return { __esModule: true };
  }
  if (request.endsWith('/context/sessionLibrary') || request === './context/sessionLibrary.js') {
    return { __esModule: true };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if (resolved.startsWith(`${STORAGE_DIR}${path.sep}`) && fs.existsSync(resolved)) {
      return loadStorageModule(resolved);
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

const filename = path.resolve('src/storage.js');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
runtimeModule._compile(transformed, filename);
Module._load = originalLoad;

const {
  getProactiveSettings,
  saveProactiveSettings,
  bindProactiveSlotSession,
  makeProactiveSlotId,
  PROACTIVE_MODES,
} = runtimeModule.exports;

const KEY = '@easychat2_proactive_settings';

test.beforeEach(() => store.clear());

test('同一角色可保存多个时间槽', async () => {
  const saved = await saveProactiveSettings({
    apiConfigId: 'cfg-1',
    model: 'model-a',
    slots: [
      { slotId: 's1', roleId: 'role-a', hour: 8, minute: 0, mode: 'WORK' },
      { slotId: 's2', roleId: 'role-a', hour: 21, minute: 30, mode: 'EXACT' },
    ],
  });
  assert.equal(saved.slots.length, 2);
  assert.deepEqual(saved.slots.map(item => item.hour), [8, 21]);
  const loaded = await getProactiveSettings();
  assert.equal(loaded.slots.length, 2);
  assert.equal(loaded.apiConfigId, 'cfg-1');
  assert.equal(loaded.model, 'model-a');
  assert.equal(loaded.slots[1].mode, 'EXACT');
});

test('缺失字段回退默认值且非法值被纠正', async () => {
  const saved = await saveProactiveSettings({
    slots: [
      { roleId: 'role-a', hour: 99, minute: -3, mode: 'NOPE' },
      { roleId: '', hour: 9, minute: 10 },
    ],
  });
  // roleId 为空的槽被丢弃
  assert.equal(saved.slots.length, 1);
  const slot = saved.slots[0];
  assert.equal(slot.hour, 8);
  assert.equal(slot.minute, 0);
  assert.ok(PROACTIVE_MODES.includes(slot.mode));
  assert.equal(slot.mode, 'WORK');
  assert.equal(slot.enabled, true);
});

test('slotId 缺省时稳定派生，显式值被保留', async () => {
  const saved = await saveProactiveSettings({
    slots: [
      { roleId: 'role-a', hour: 7, minute: 5 },
      { slotId: 'keep-me', roleId: 'role-b', hour: 7, minute: 6 },
    ],
  });
  assert.equal(saved.slots[0].slotId, 'slot-0-role-a-7-5');
  assert.equal(saved.slots[1].slotId, 'keep-me');
});

test('损坏数据先备份再返回空设置，不静默覆盖', async () => {
  store.set(KEY, '{not-json');
  const loaded = await getProactiveSettings();
  assert.deepEqual(loaded.slots, []);
  assert.equal(store.get(`${KEY}__corrupt_backup`), '{not-json');
  // 备份存在时原值未被默认值覆盖
  assert.equal(store.get(KEY), '{not-json');
});

test('makeProactiveSlotId 生成的 id 唯一', () => {
  assert.notEqual(makeProactiveSlotId(), makeProactiveSlotId());
});

test('互动面板：折叠选择 API/模型/角色 + 权限状态勾叉问号', () => {
  const panel = fs.readFileSync(path.resolve('src/ProactivePanel.js'), 'utf8');
  // 折叠选择器，避免一次性罗列大量 API/模型/角色
  assert.ok(panel.includes('CollapsibleSelect'));
  assert.ok(panel.includes('消息来源（API）'));
  assert.ok(panel.includes('具体模型'));
  assert.ok(panel.includes('选择角色'));
  // 权限状态：勾/叉/问号三态
  assert.ok(panel.includes('getPermissionStatus'));
  assert.ok(panel.includes("'checkmark-circle'"));
  assert.ok(panel.includes("'close-circle'"));
  assert.ok(panel.includes("'help-circle'"));
  assert.ok(panel.includes('permissionRow'));
});

test('消息类型：槽可保存 messageType 与 customPrompt，非法值回退默认', async () => {
  const saved = await saveProactiveSettings({
    slots: [
      { roleId: 'role-a', hour: 8, minute: 0, messageType: 'CARE' },
      { roleId: 'role-b', hour: 9, minute: 0, messageType: 'CUSTOM', customPrompt: '问我吃了吗' },
      { roleId: 'role-c', hour: 10, minute: 0, messageType: 'BOGUS' },
    ],
  });
  assert.equal(saved.slots[0].messageType, 'CARE');
  assert.equal(saved.slots[1].messageType, 'CUSTOM');
  assert.equal(saved.slots[1].customPrompt, '问我吃了吗');
  // 非法类型回退默认，避免原生 MessageType.valueOf 抛错
  assert.equal(saved.slots[2].messageType, 'DEFAULT');
  const loaded = await getProactiveSettings();
  assert.equal(loaded.slots[1].messageType, 'CUSTOM');
});

test('互动面板：提供默认/关心心情/问好/自定义四种消息类型与自定义输入框', () => {
  const panel = fs.readFileSync(path.resolve('src/ProactivePanel.js'), 'utf8');
  assert.ok(panel.includes('MESSAGE_TYPE_OPTIONS'));
  for (const label of ['默认', '关心心情', '问好', '自定义']) {
    assert.ok(panel.includes(label), `缺少消息类型选项 ${label}`);
  }
  // 选「自定义」时才出现提示词输入框
  assert.ok(panel.includes("slot.messageType === 'CUSTOM'"));
  assert.ok(panel.includes('customPrompt'));
});

test('主动消息落库：存储导出 appendProactiveMessage，桥接消费并 ack', () => {
  assert.equal(typeof runtimeModule.exports.appendProactiveMessage, 'function');
  const app = fs.readFileSync(path.resolve('App.js'), 'utf8');
  assert.ok(app.includes('consumePendingMessages'));
  assert.ok(app.includes('ingestProactiveMessages'));
  assert.ok(app.includes('ackPendingMessages'));
  // 跳转前先落库，保证点通知进入即可见
  const bridge = app.match(/function ProactiveMessageBridge[\s\S]*?\n}\n/)[0];
  const ingestIndex = bridge.indexOf('await ingestPending()');
  const switchIndex = bridge.indexOf('await switchCharacter(roleId)');
  assert.ok(ingestIndex > 0 && switchIndex > 0, '缺少落库或切换调用');
  assert.ok(ingestIndex < switchIndex, '必须先落库再切换角色');
});

test('找不到角色的待写消息不 ack 删除，改为保留重试', () => {
  const app = fs.readFileSync(path.resolve('App.js'), 'utf8');
  const ctx = fs.readFileSync(path.resolve('src/context/AppContext.js'), 'utf8');
  // ingest 返回 deferred 名单
  assert.ok(ctx.includes('deferred'), 'AppContext 应返回 deferred');
  // 角色不在库时进 deferred（而非 skipped）
  const roleMissing = ctx.match(/角色当前不在库[\s\S]{0,120}/);
  assert.ok(roleMissing, '未找到角色缺失分支');
  assert.ok(roleMissing[0].includes('deferred.push'), '角色缺失应保留重试');
  // App.js 只 ack written + skipped，不含 deferred
  const bridge = app.match(/function ProactiveMessageBridge[\s\S]*?\n}\n/)[0];
  assert.ok(!/acked\s*=\s*\[[^\]]*deferred/.test(bridge), 'deferred 不得被 ack');
  assert.match(bridge, /const acked = \[\.\.\.written, \.\.\.skipped\]/);
});

test('衔接对话：槽可保存 sessionTargetId，非法/缺失回退空串', async () => {
  const saved = await saveProactiveSettings({
    slots: [
      { roleId: 'role-a', hour: 8, minute: 0, sessionTargetId: 'sess-1' },
      { roleId: 'role-b', hour: 9, minute: 0 },
    ],
  });
  assert.equal(saved.slots[0].sessionTargetId, 'sess-1');
  assert.equal(saved.slots[1].sessionTargetId, '', '缺省应为空串（新建对话）');
});

test('bindProactiveSlotSession：仅更新指定槽的绑定，保留其它编辑', async () => {
  await saveProactiveSettings({
    slots: [
      { slotId: 's1', roleId: 'role-a', hour: 8, minute: 0 },
      { slotId: 's2', roleId: 'role-a', hour: 9, minute: 0, sessionTargetId: 'keep' },
    ],
  });
  const ok = await bindProactiveSlotSession('s1', 'new-session');
  assert.equal(ok, true);
  const loaded = await getProactiveSettings();
  assert.equal(loaded.slots.find(item => item.slotId === 's1').sessionTargetId, 'new-session');
  assert.equal(loaded.slots.find(item => item.slotId === 's2').sessionTargetId, 'keep');
  // 未命中的槽返回 false，不误报
  assert.equal(await bindProactiveSlotSession('nope', 'x'), false);
  // 空参数直接拒绝
  assert.equal(await bindProactiveSlotSession('', 'x'), false);
  assert.equal(await bindProactiveSlotSession('s1', ''), false);
});

test('互动面板：每个槽可选择衔接的历史对话或新建对话', () => {
  const panel = fs.readFileSync(path.resolve('src/ProactivePanel.js'), 'utf8');
  assert.ok(panel.includes("label: '新建对话'"));
  assert.ok(panel.includes('sessionTargetId'));
  assert.ok(panel.includes('sessionOptions'));
  // 候选只取该角色的单聊会话
  assert.match(panel, /item\.type !== 'group' && item\.characterId === activeRoleId/);
});

test('互动面板：时间槽不自动按时间排序，改为按钮显式触发', () => {
  const panel = fs.readFileSync(path.resolve('src/ProactivePanel.js'), 'utf8');
  // roleSlots 只过滤、不再 sort：编辑时间时不会立即跳位
  const roleSlotsBlock = panel.match(
    /const roleSlots = useMemo\([\s\S]*?\[slots, activeRoleId\]\s*\)/
  );
  assert.ok(roleSlotsBlock, '未找到 roleSlots 定义');
  assert.equal(roleSlotsBlock[0].includes('.sort('), false, 'roleSlots 不应再自动 sort');
  assert.match(roleSlotsBlock[0], /slots\.filter\(item => item\.roleId === activeRoleId\)/);
  // 提供显式的排序按钮与处理函数
  assert.ok(panel.includes('sortSlotsByTime'));
  assert.ok(panel.includes('按时间排序'));
});