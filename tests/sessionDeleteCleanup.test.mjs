// 会话删除的**键清理**行为测试（回归 2026-10-11 逐行审查 P0）。
//
// 问题：删会话只清 messages / summaries / draft 三个键，漏了
//   @easychat2_session_plan::<sid>   （useChatSend 的 onPlan 持续写）
//   @easychat2_session_stats         （每次请求写，单键多会话）
//   @easychat2_stream_draft::<sid>   （生成中节流落盘）
// 后果：删了会话，它的计划与统计永久留在存储里。
//
// 这个文件立的规矩：**加载真实现**（mutations + sessionCore + sessionPlan + sessionStats +
// streamDraft + sessionBranches + io），只把 AsyncStorage / FileSystem 两个原生边界换成内存
// 替身；种子数据也用**真的写入函数**（saveSessionPlan / recordSessionRequest /
// saveStreamDraft / archiveBranch）铺进去——这样键格式由生产代码决定，测试只断言
// 「删完之后这些键还在不在」，不会因为两边各写一份键名而假绿。

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
  // i18n 只用到 tActive（提示文案）：返回键名即可，避免加载整棵词条树。
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  // 角色域与本次要验的键无关（删除路径只取 DEFAULT_CHARACTER 做兜底会话）。
  if (request.endsWith('/characters.js') || request.endsWith('/characters')) {
    return {
      __esModule: true,
      DEFAULT_CHARACTER: { id: 'default' },
      getCharacterLibrary: async () => [],
      saveCharacterLibrary: async () => {},
    };
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

const { deleteSession, deleteSessions } = loadModule(path.resolve('src/storage/sessionList/mutations.js'));
const {
  ACTIVE_SESSION_KEY,
  SESSIONS_KEY,
  saveSessionsInternal,
  sessionDraftKey,
  sessionMessagesKey,
  sessionPlanKey,
  sessionSummariesKey,
} = loadModule(path.resolve('src/storage/sessionCore.js'));
const { saveSessionPlan } = loadModule(path.resolve('src/storage/sessionPlan.js'));
const { SESSION_STATS_KEY, recordSessionRequest } = loadModule(path.resolve('src/storage/sessionStats.js'));
const { saveStreamDraft, streamDraftKey } = loadModule(path.resolve('src/storage/streamDraft.js'));
const { archiveBranch } = loadModule(path.resolve('src/storage/sessionBranches.js'));
const { sessionBranchItemKey } = loadModule(path.resolve('src/storage/sessionCore.js'));

const SESSION_STATS = SESSION_STATS_KEY;
// 每个会话归档出来的分支 id（archiveBranch 的返回值才是真键的一部分，
// 不能自己编一个 —— 编出来的键断言「不存在」是假绿）。
const branchIds = new Map();

function session(id, characterId, extra = {}) {
  return {
    id,
    type: 'single',
    characterId,
    name: id,
    preview: '',
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  };
}

// 把「一个会话拥有的全部旁路键」用**真的写入函数**铺满，返回键清单。
async function seedSession(id) {
  await saveSessionPlan(id, [{ step: '第一步', status: 'pending' }]);
  await recordSessionRequest(id, { ok: true, at: 1000 });
  await saveStreamDraft(id, { messageId: `${id}-m1`, text: '半截回复', at: 1000 });
  const branch = await archiveBranch(id, `${id}-m1`, [{ id: `${id}-m1`, role: 'assistant', content: '分支内容' }]);
  branchIds.set(id, branch ? branch.id : '');
  await AsyncStorage.setItem(sessionMessagesKey(id), JSON.stringify([{ id: `${id}-m1`, content: 'hi' }]));
  await AsyncStorage.setItem(sessionSummariesKey(id), JSON.stringify([{ upTo: `${id}-m1`, text: '摘要' }]));
  await AsyncStorage.setItem(sessionDraftKey(id), JSON.stringify({ text: '草稿' }));
}

async function seedSessions(ids) {
  store.clear();
  branchIds.clear();
  await saveSessionsInternal(ids.map(id => session(id, `char-${id}`)));
  await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(ids[0]));
  for (const id of ids) await seedSession(id, `char-${id}`);
}

// 该会话拥有的全部存储键（删完必须一个都不剩）。
function keysOf(id) {
  return [
    sessionMessagesKey(id),
    sessionSummariesKey(id),
    sessionDraftKey(id),
    sessionPlanKey(id),
    streamDraftKey(id),
    `@easychat2_branch_index::${id}`,
    sessionBranchItemKey(id, branchIds.get(id)),
  ];
}

function statsStore() {
  const raw = store.get(SESSION_STATS);
  return raw ? JSON.parse(raw) : {};
}

test('删除单个会话：计划 / 统计 / 流式草稿一并清掉（这三条曾经全漏）', async () => {
  await seedSessions(['s1', 's2']);

  // 前置：种子真的落盘了（否则下面的「不存在」会因为压根没写而假绿）
  assert.ok(store.has(sessionPlanKey('s1')), '前置：计划键已写入');
  assert.ok(store.has(streamDraftKey('s1')), '前置：流式草稿键已写入');
  assert.equal(statsStore().s1 !== undefined, true, '前置：统计已写入');
  assert.equal(store.has('@easychat2_branch_index::s1'), true, '前置：分支索引已写入');
  assert.equal(store.has(sessionBranchItemKey('s1', branchIds.get('s1'))), true, '前置：分支条目已写入');

  await deleteSession('s1');

  for (const key of keysOf('s1')) {
    assert.equal(store.has(key), false, `删会话后不得残留：${key}`);
  }
  // 分支条目按前缀扫描兜底：索引与条目一起走
  const leftovers = [...store.keys()].filter(key => key.startsWith('@easychat2_branch_item::s1::'));
  assert.deepEqual(leftovers, [], '分支条目键必须一起清掉');
  // 统计是单键多会话：只能删自己那一条，别的会话不能被牵连
  assert.equal(statsStore().s1, undefined, '被删会话的统计必须清掉');
  assert.equal(statsStore().s2 !== undefined, true, '别的会话的统计必须保留');
  // 会话列表本身
  assert.deepEqual(JSON.parse(store.get(SESSIONS_KEY)).map(item => item.id), ['s2']);
});

test('批量删除：每个会话的计划 / 统计 / 流式草稿都清掉，且不牵连未删除的会话', async () => {
  await seedSessions(['s1', 's2', 's3']);

  await deleteSessions(['s1', 's3']);

  for (const id of ['s1', 's3']) {
    for (const key of keysOf(id)) {
      assert.equal(store.has(key), false, `批量删除后不得残留：${key}`);
    }
    assert.equal(statsStore()[id], undefined, `批量删除后统计不得残留：${id}`);
  }
  // 未删除的会话完好无损
  assert.ok(store.has(sessionPlanKey('s2')), '未删除会话的计划必须保留');
  assert.ok(store.has(streamDraftKey('s2')), '未删除会话的流式草稿必须保留');
  assert.equal(statsStore().s2 !== undefined, true, '未删除会话的统计必须保留');
  assert.deepEqual(JSON.parse(store.get(SESSIONS_KEY)).map(item => item.id), ['s2']);
});

test('群聊会话删除同样清掉计划 / 统计 / 流式草稿（不因 type=group 走另一条路）', async () => {
  store.clear();
  branchIds.clear();
  await saveSessionsInternal([
    session('g1', '', { type: 'group', members: ['c1', 'c2'] }),
  ]);
  await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify('g1'));
  await seedSession('g1', '');

  await deleteSession('g1');

  assert.equal(store.has(sessionPlanKey('g1')), false, '群聊的计划键要清');
  assert.equal(store.has(streamDraftKey('g1')), false, '群聊的流式草稿要清');
  assert.equal(statsStore().g1, undefined, '群聊的统计要清');
});
