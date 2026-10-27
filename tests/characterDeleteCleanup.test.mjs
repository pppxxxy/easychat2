// 角色删除的**清理覆盖面**行为测试（回归 2026-10-11 逐行审查 P1）。
//
// 审查列了 5 个「删角色后残留」的键，本文件把其中能成立的部分钉住、把不成立的部分写成
// 明确的反向断言（免得下次又有人「顺手补一刀」把还在用的数据清掉）：
//
// 1. @easychat2_character_edit_draft::<id>  —— **按角色分键**，删角色必须清。
//    此前只由两个界面的删除流程顺手清一次，换条路径就漏。已注册 onCharacterDeleted。
// 2. @easychat2_session_plan / _session_stats / _stream_draft —— **按会话分键**，不是角色数据：
//    删角色（不删记忆）时会话仍然存在，它们的计划/统计/草稿仍然有效，**不该**被连带清掉；
//    而会话真的被删时，由 sessionList 的删除路径清（见 tests/sessionDeleteCleanup.test.mjs）。
//    本文件用真模块把这两条都断言出来。
// 3. @easychat2_card_forge —— **全局单份草稿**，与任何角色 id 无关联（draft 里没有角色字段，
//    草稿图名也不带角色 id），删任意角色都清它 = 把用户正在进行的制卡草稿清掉，是回归。
//    这里断言「删角色后制卡草稿仍在」，把「不清」这个决定写成可执行的反例。
//
// 加载：真模块 + 真 io.js + 真 characterLifecycle，只把 AsyncStorage / FileSystem 换成内存替身。

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

const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, String(value)); },
  removeItem: async key => { store.delete(key); },
  multiRemove: async keys => { (Array.isArray(keys) ? keys : []).forEach(key => store.delete(key)); },
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

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: AsyncStorage };
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
    return { __esModule: true, ...FileSystem };
  }
  if (request === 'expo-sqlite') return { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolvedBase = path.resolve(path.dirname(parent.filename), request);
    if (resolvedBase.startsWith(`${SRC_DIR}${path.sep}`)) {
      for (const candidate of [resolvedBase, `${resolvedBase}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return loadModule(candidate);
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

const { runCharacterCleanup, __listCharacterCleanupHooks } = loadModule(
  path.resolve('src/storage/characterLifecycle.js')
);
const characters = loadModule(path.resolve('src/storage/characters.js'));
const cardForge = loadModule(path.resolve('src/storage/cardForge.js'));
const { saveSessionPlan } = loadModule(path.resolve('src/storage/sessionPlan.js'));
const { SESSION_STATS_KEY, recordSessionRequest } = loadModule(path.resolve('src/storage/sessionStats.js'));
const { saveStreamDraft, streamDraftKey } = loadModule(path.resolve('src/storage/streamDraft.js'));
const { deleteSessions } = loadModule(path.resolve('src/storage/sessionList/mutations.js'));
const { saveSessionsInternal } = loadModule(path.resolve('src/storage/sessionCore.js'));

const DRAFT_PREFIX = '@easychat2_character_edit_draft';
const CARD_FORGE_KEY = '@easychat2_card_forge';

test('角色编辑草稿的清理钩子已注册（谁的数据谁负责）', () => {
  assert.ok(
    __listCharacterCleanupHooks().includes('characterEditDraft'),
    'characterEditDraft 必须注册到角色生命周期'
  );
});

test('删角色：被删角色的编辑草稿清掉，别人的保留', async () => {
  store.clear();
  await characters.saveCharacterEditDraft('c1', { name: '甲' }, 'sig-1');
  await characters.saveCharacterEditDraft('c2', { name: '乙' }, 'sig-2');
  assert.equal(store.has(`${DRAFT_PREFIX}::c1`), true, '前置：草稿已写入');

  await runCharacterCleanup(['c1']);

  assert.equal(store.has(`${DRAFT_PREFIX}::c1`), false, '被删角色的编辑草稿必须清掉');
  assert.equal(store.has(`${DRAFT_PREFIX}::c2`), true, '别人的草稿不得连带清掉');
  // 未保存的编辑内容仍能读回（不是把整个草稿表清了）
  assert.equal((await characters.takeCharacterEditDraft('c2')).formState.name, '乙');
});

test('删角色（不删记忆）：会话级旁路键不得被连带清掉——会话还在，数据仍然有效', async () => {
  store.clear();
  await saveSessionsInternal([{ id: 's1', characterId: 'c1', type: 'single', updatedAt: 1 }]);
  await saveSessionPlan('s1', [{ step: '第一步' }]);
  await recordSessionRequest('s1', { ok: true, at: 1 });
  await saveStreamDraft('s1', { messageId: 'm1', text: '半截回复', at: 1 });

  await runCharacterCleanup(['c1']);

  assert.equal(store.has('@easychat2_session_plan::s1'), true, '会话还在 → 计划不该被角色清理连带删掉');
  assert.equal(store.has(streamDraftKey('s1')), true, '会话还在 → 流式草稿不该被连带删掉');
  assert.equal(JSON.parse(store.get(SESSION_STATS_KEY)).s1 !== undefined, true, '会话还在 → 统计不该被连带删掉');
});

test('删角色（连记忆一起删）→ 会话被删时，三个会话级键由会话删除路径清掉', async () => {
  store.clear();
  await saveSessionsInternal([
    { id: 's1', characterId: 'c1', type: 'single', updatedAt: 1 },
    { id: 's2', characterId: 'c2', type: 'single', updatedAt: 2 },
  ]);
  await saveSessionPlan('s1', [{ step: '第一步' }]);
  await recordSessionRequest('s1', { ok: true, at: 1 });
  await saveStreamDraft('s1', { messageId: 'm1', text: '半截回复', at: 1 });
  await saveSessionPlan('s2', [{ step: '别人的' }]);

  // 真实删除流程（character/characterLibraryDelete.js 的 runCharacterDelete，P1-2）顺序是
  // 「**先删角色**（可重试；失败即抛出，盘上什么都没被破坏）→ 角色删成功后才做不可逆清理
  // （动态 → 会话/记忆）」。这里的两个调用分别对应那两步：runCharacterCleanup 是删角色那一步
  // 内部跑的 onCharacterDeleted 钩子（storage/characterState.js 无条件触发），deleteSessions 是
  // 清理阶段的会话删除。本测试只钉「会话真的被删时，三个会话级键由会话删除路径清掉」，
  // 两个调用在此互不依赖，故按断言需要的顺序直接调它们，不重演整条编排。
  await deleteSessions(['s1']);
  await runCharacterCleanup(['c1']);

  assert.equal(store.has('@easychat2_session_plan::s1'), false, '会话删了 → 计划跟着走');
  assert.equal(store.has(streamDraftKey('s1')), false, '会话删了 → 流式草稿跟着走');
  assert.equal(JSON.parse(store.get(SESSION_STATS_KEY)).s1, undefined, '会话删了 → 统计跟着走');
  assert.equal(store.has('@easychat2_session_plan::s2'), true, '别的会话不受影响');
});

test('删角色不得清掉制卡草稿（那是全局单份草稿，与角色 id 无关联）', async () => {
  store.clear();
  await cardForge.saveCardForge({
    version: 1,
    step: 1,
    answers: { tone: '冷淡' },
    draft: { name: '新角色' },
    transcript: [{ id: 'x', role: 'note', text: '笔记' }],
    updatedAt: 1,
  });
  assert.equal(store.has(CARD_FORGE_KEY), true, '前置：制卡草稿已写入');

  await runCharacterCleanup(['c1']);

  assert.equal(
    store.has(CARD_FORGE_KEY),
    true,
    '制卡草稿是全局单份、与角色 id 无关联：删任意角色都清它会把用户正在进行的草稿清掉（回归）'
  );
  assert.equal((await cardForge.getCardForge()).draft.name, '新角色', '内容完好');
});
