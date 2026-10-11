// 「工具使用提示」可见性的唯一判定层 + 存储归一化。
//
// 这里钉的是四类**错了也不容易发现**的风险：
//   1) 失败被一起隐藏（用户以为工具没跑过）；
//   2) 默认值反了（没设置就隐藏 = 静默吞提示）；
//   3) 归一化把损坏的 blob 当配置吃下去（含原型污染键）；
//   4) 存储层漏字段（界面拨了开关、重启后回到「显示」）。
//
// 审批相关的边界不在本文件——它由 tests/toolBubbleVisibility.test.mjs 用**真注册表 +
// 真 runTool** 做行为验证（隐藏提示不得跳过确认）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import {
  TOOL_NOTICE_NAME_PATTERN,
  isToolNoticeHidden,
  normalizeHiddenToolNotices,
} from '../src/chat/toolNoticeVisibility.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

// ---------- 归一化 ----------

test('归一化：只认显式 true，其余一律等于「显示」', () => {
  assert.deepEqual(normalizeHiddenToolNotices({ web_search: true }), { web_search: true });
  assert.deepEqual(normalizeHiddenToolNotices({ web_search: false }), {});
  // 模糊值不制造「半开」状态：'yes' / 1 / null 都不是隐藏
  assert.deepEqual(normalizeHiddenToolNotices({ a: 'yes', b: 1, c: null, d: undefined, e: {} }), {});
});

test('归一化：未知工具名**保留**（只做形状校验，不按白名单丢弃）', () => {
  // 决策：保留。聊天页还能显示不在静态聊天工具清单里的工具（read/write 模式下的
  // 工作区工具、MCP 工具），按白名单丢弃会让用户在这些工具上的偏好静默失效。
  const normalized = normalizeHiddenToolNotices({
    web_search: true,
    read_workspace_file: true,
    'mcp__github__create_issue': true,
    brand_new_tool: true,
  });
  assert.deepEqual(normalized, {
    web_search: true,
    read_workspace_file: true,
    'mcp__github__create_issue': true,
    brand_new_tool: true,
  });
});

test('归一化：形状非法的键丢弃（含原型污染键）', () => {
  const normalized = normalizeHiddenToolNotices({
    'has space': true,
    ['x'.repeat(65)]: true,
    '': true,
    '中文工具名': true,
    'semi;colon': true,
    // 这三个的字符全在合法白名单里，但它们在对象上不是普通数据键——必须单独挡掉
    __proto__: true,
    constructor: true,
    prototype: true,
  });
  assert.deepEqual(normalized, {}, '非法形状与保留键都不得进入设置');
  // 挡的是「设置表里的键」，不是把对象整体搞坏
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype, '归一化不得改动原型');
  assert.equal({}.polluted, undefined);
});

test('归一化：JSON 里的 __proto__ 键（真实攻击形态）不得污染原型', () => {
  const raw = JSON.parse('{"__proto__": true, "web_search": true}');
  const normalized = normalizeHiddenToolNotices(raw);
  assert.deepEqual(normalized, { web_search: true });
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test('归一化：null / 数组 / 字符串 / 数字一律回落空表', () => {
  for (const raw of [null, undefined, [], [1, 2], 'web_search', 42, true]) {
    assert.deepEqual(normalizeHiddenToolNotices(raw), {}, String(raw));
  }
});

test('工具名形状与注册表同口径', () => {
  assert.equal(TOOL_NOTICE_NAME_PATTERN.test('web_search'), true);
  assert.equal(TOOL_NOTICE_NAME_PATTERN.test('mcp__github__create-issue'), true);
  assert.equal(TOOL_NOTICE_NAME_PATTERN.test(''), false);
  assert.equal(TOOL_NOTICE_NAME_PATTERN.test('a b'), false);
  assert.equal(TOOL_NOTICE_NAME_PATTERN.test('x'.repeat(65)), false);
});

// ---------- 判定（唯一来源） ----------

test('默认可见：设置缺失 / 损坏 / 类型不对都不隐藏任何工具', () => {
  for (const settings of [null, undefined, 'x', 42, [], {}, { hideAllToolNotices: 'yes' }]) {
    assert.equal(isToolNoticeHidden('web_search', settings), false, String(settings));
    assert.equal(isToolNoticeHidden('web_search', settings, 'running'), false);
  }
  assert.equal(isToolNoticeHidden('', { hideAllToolNotices: true }), true, '总开关不依赖工具名');
  assert.equal(isToolNoticeHidden('', { hiddenToolNotices: { web_search: true } }), false, '空工具名不匹配任何项');
});

test('按工具隐藏：只隐藏被点名的工具，别的工具照常显示', () => {
  const settings = { hiddenToolNotices: { web_search: true } };
  assert.equal(isToolNoticeHidden('web_search', settings), true);
  assert.equal(isToolNoticeHidden('web_fetch', settings), false);
  assert.equal(isToolNoticeHidden('web_search', settings, 'running'), true);
  assert.equal(isToolNoticeHidden('web_search', settings, 'done'), true);
});

test('总开关：任何工具名（含清单外的）都被隐藏', () => {
  const settings = { hideAllToolNotices: true };
  for (const name of ['web_search', 'web_fetch', 'read_workspace_file', 'mcp__x__y', 'future_tool']) {
    assert.equal(isToolNoticeHidden(name, settings), true, name);
    assert.equal(isToolNoticeHidden(name, settings, 'running'), true, name);
  }
});

test('边界②：失败（error）永不被隐藏——总开关开着、单项也开着', () => {
  assert.equal(
    isToolNoticeHidden('web_search', { hideAllToolNotices: true, hiddenToolNotices: { web_search: true } }, 'error'),
    false,
    '工具失败必须看得见，否则用户会以为工具根本没跑'
  );
  assert.equal(isToolNoticeHidden('web_search', { hideAllToolNotices: true }, 'error'), false);
  // 非 error 的其他状态不受影响（防止把豁免写成「只要带 status 就不隐藏」）
  assert.equal(isToolNoticeHidden('web_search', { hideAllToolNotices: true }, 'done'), true);
  assert.equal(isToolNoticeHidden('web_search', { hideAllToolNotices: true }, 'running'), true);
});

test('判定对未归一化的输入同样成立（调用方不需要先处理）', () => {
  const dirty = { hiddenToolNotices: { web_search: true, 'bad name': true, nope: 'yes' } };
  assert.equal(isToolNoticeHidden('web_search', dirty), true);
  assert.equal(isToolNoticeHidden('bad name', dirty), false);
  assert.equal(isToolNoticeHidden('nope', dirty), false);
});

// ---------- 存储：归一化真的接在 chatOptions 上 ----------

const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
  getAllKeys: async () => [...store.keys()],
};
const ioStub = {
  readJson: async (key, fallback) => {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  },
};
const SETTINGS_DIR = path.resolve('src/storage/settings');
function loadSettingsModule(absPath) {
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
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request.endsWith('/io.js')) return ioStub;
  if (parent && parent.filename && request.startsWith('.')) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if (resolved.startsWith(`${SETTINGS_DIR}${path.sep}`) && fs.existsSync(resolved)) {
      return loadSettingsModule(resolved);
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
const chatOptions = loadSettingsModule(path.resolve('src/storage/settings/chatOptions.js'));
Module._load = originalLoad;

const CHAT_OPTIONS_KEY = '@easychat2_chat_options';

test('存储：两个字段缺省为「全部显示」，且不干扰既有聊天选项', async () => {
  store.clear();
  const defaults = await chatOptions.getChatOptions();
  assert.equal(defaults.hideAllToolNotices, false);
  assert.deepEqual(defaults.hiddenToolNotices, {});
  assert.equal(defaults.streaming, true, '既有字段不受影响');
  assert.equal(defaults.chatTools, false);
  store.clear();
});

test('存储：读写往返保留总开关与按工具开关（重启后不回落到「显示」）', async () => {
  store.clear();
  await chatOptions.saveChatOptions({
    ...(await chatOptions.getChatOptions()),
    hideAllToolNotices: true,
    hiddenToolNotices: { web_search: true, web_fetch: true },
  });
  const loaded = await chatOptions.getChatOptions();
  assert.equal(loaded.hideAllToolNotices, true);
  assert.deepEqual(loaded.hiddenToolNotices, { web_search: true, web_fetch: true });
  // 判定层读存储读出来的对象，结果必须与写入意图一致
  assert.equal(isToolNoticeHidden('web_search', loaded), true);
  store.clear();
});

test('存储：损坏 / 类型不对的值被归一，不写坏状态', async () => {
  store.set(CHAT_OPTIONS_KEY, '{ not json');
  assert.deepEqual((await chatOptions.getChatOptions()).hiddenToolNotices, {}, '损坏回退空表');
  store.set(CHAT_OPTIONS_KEY, JSON.stringify({
    hiddenToolNotices: { web_search: 'yes', 'bad name': true, ok_tool: true },
    hideAllToolNotices: 'true',
  }));
  const loaded = await chatOptions.getChatOptions();
  assert.deepEqual(loaded.hiddenToolNotices, { ok_tool: true });
  assert.equal(loaded.hideAllToolNotices, false, '非布尔 true 不当作开启');
  store.clear();
});
