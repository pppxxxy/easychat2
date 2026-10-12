// storage/memoryOwnership.js 的对账（**会写盘的那条路径**）行为测试。
//
// 为什么单独立这一份：本模块是全仓唯一会**改记忆数据**的对账路径（AppContext 读角色库
// 之前跑一次、会话增删后再跑一次）。P0 修的是：读消息走 getMessagesBySession（丢掉
// status）→ 消息体 corrupt 时拿到 [] → planWorldMemoryRetire 认为「boundary 全不匹配」
// → 下次启动把该角色卡上**所有生效记忆条目** enabled:false。也就是「把『读不出』当
// 『没有』」——本波同类 bug 已修 3 处（MemoryProvenanceModal / MemoryCheckupModal /
// checkup.js），但那 3 处只是显示错，这一处会改数据。
//
// 加载方式沿用仓库既有打桩范式（tests/characterRuntimeConfig.test.mjs、
// tests/bookShelves.test.mjs）：babel 转译**真实源码** + Module._load 注入内存版
// AsyncStorage / FileSystem。关键点：消息域走**真实** io.js + 真实
// storage/sessionMessages/messages.js + 真实 sessionCore.js，损坏是往存储里塞**真的
// 坏 JSON 串**（不是 mock 一个 { status: 'corrupt' } 常量），三态分类由 readJsonStatus
// 真实产生。唯一被替换的领域是角色库存储（storage/characters.js）：它不是本次 P0 的
// 面，且下游牵到 src/character/**（别的批次在改）；换成内存库 + 写调用记录后，
// 「盘上条目 enabled 有没有被改」反而断言得更直接。

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
const SESSIONS_KEY = '@easychat2_sessions';
const messagesKey = sessionId => `@easychat2_messages::${sessionId}`;

// ---- 存储桩：真实 io.js 直接读它 ----
const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, String(value)); },
  removeItem: async key => { store.delete(key); },
  multiSet: async pairs => { (pairs || []).forEach(([key, value]) => store.set(key, String(value))); },
  multiRemove: async keys => { (keys || []).forEach(key => store.delete(key)); },
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
const SecureStore = {
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
};

// ---- 角色库桩：内存盘 + 写调用记录（断言「有没有写盘」「写成什么」）----
let library = [];
const saveCalls = [];
const clone = value => JSON.parse(JSON.stringify(value));
const charactersStub = {
  getCharacterLibrary: async () => clone(library),
  saveCharacterLibrary: async list => {
    saveCalls.push(clone(list));
    library = clone(list);
    return list;
  },
};
const worldInfoOf = characterId => {
  const found = library.find(item => String(item.id) === String(characterId));
  return found && Array.isArray(found.worldInfo) ? found.worldInfo : [];
};
// 条目状态快照：'e1:on' / 'e1:off/stale'。
const entryState = characterId => worldInfoOf(characterId)
  .map(item => `${item.id}:${item.enabled === false ? 'off' : 'on'}${item.stale ? '/stale' : ''}`);

// ---- 真实源码加载器（含环容忍：先登记 Module._cache 再编译）----
function resolveFile(base) {
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return '';
}

function loadModule(absPath) {
  const resolved = resolveFile(absPath);
  if (!resolved) return null;
  const cached = Module._cache[resolved];
  if (cached) return cached.exports;
  const code = babel.transformSync(fs.readFileSync(resolved, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: resolved,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const mod = new Module(resolved);
  mod.filename = resolved;
  mod.paths = Module._nodeModulePaths(path.dirname(resolved));
  Module._cache[resolved] = mod;
  try {
    mod._compile(code, resolved);
  } catch (error) {
    delete Module._cache[resolved];
    throw error;
  }
  return mod.exports;
}

const I18N_PATH = path.resolve('src/i18n/index.js');
const CHARACTERS_PATH = path.resolve('src/storage/characters.js');

// 补丁常驻（diagnostics/secretStore 会在**调用时**惰性 require，见 diagnostics.js:9-10）。
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') {
    return { __esModule: true, default: AsyncStorage };
  }
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
    return { __esModule: true, ...FileSystem };
  }
  if (request === 'expo-secure-store') return { __esModule: true, ...SecureStore };
  if (request === 'expo-sqlite') {
    return { __esModule: true, openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolved = resolveFile(path.resolve(path.dirname(parent.filename), request));
    // 只替换两个领域：i18n（纯文案）与角色库存储（非本次 P0 的面）。
    if (resolved === I18N_PATH) {
      return { __esModule: true, tActive: key => String(key), t: key => String(key) };
    }
    if (resolved === CHARACTERS_PATH) return { __esModule: true, ...charactersStub };
    if (resolved && resolved.startsWith(`${SRC_DIR}${path.sep}`)) return loadModule(resolved);
  }
  return originalLoad.call(this, request, parent, isMain);
};
globalThis.__DEV__ = false;

const messagesStore = loadModule(path.resolve('src/storage/sessionMessages/messages.js'));
const checkup = loadModule(path.resolve('src/memory/checkup.js'));
const { reconcileWorldMemories } = loadModule(path.resolve('src/storage/memoryOwnership.js'));
const { getMessagesBySession, getMessagesBySessionStatus } = messagesStore;

// ---- 造数据 ----
const memoryEntry = (id, boundary, overrides = {}) => ({
  id,
  comment: '记忆总结 1',
  content: '一段记忆',
  enabled: true,
  boundary,
  ...overrides,
});
const character = (id, worldInfo) => ({ id, name: `角色 ${id}`, builtin: false, worldInfo });
const singleSession = (id, characterId) => ({ id, type: 'single', characterId, summarizedUpTo: '' });

// messageValues：会话 id → 原始串（损坏）/ 数组（合法消息体）；不给该会话 = 键不存在（missing）。
function seedWorld({ sessions = [], characters = [], messageValues = {} } = {}) {
  store.clear();
  saveCalls.length = 0;
  library = clone(characters);
  store.set(SESSIONS_KEY, JSON.stringify(sessions));
  Object.entries(messageValues).forEach(([sessionId, value]) => {
    store.set(messagesKey(sessionId), typeof value === 'string' ? value : JSON.stringify(value));
  });
}

test('前提：消息体损坏时三态读报 corrupt，而 getMessagesBySession 把它抹成空数组', async () => {
  seedWorld({
    sessions: [singleSession('s1', 'c1')],
    characters: [character('c1', [memoryEntry('e1', 'm1')])],
    messageValues: { s1: '{ 这不是 JSON' },
  });
  const status = await getMessagesBySessionStatus('s1');
  assert.equal(status.status, 'corrupt', '损坏的原始串必须被 readJsonStatus 真实判成 corrupt');
  assert.deepEqual(status.messages, []);
  // 旧写法丢掉的正是这个 status：调用方只能看到 []，与「会话里没有消息」完全同形。
  assert.deepEqual(await getMessagesBySession('s1'), []);
  assert.equal(store.has(`${messagesKey('s1')}__corrupt_backup`), true, '损坏原值已备份（走的是真实 io.js 路径）');
  // missing 必须与 corrupt 可区分，否则「空会话」与「读不出」又会同形。
  store.delete(messagesKey('s1'));
  const missing = await getMessagesBySessionStatus('s1');
  assert.equal(missing.status, 'missing');
  assert.deepEqual(missing.messages, []);
});

test('P0：消息体损坏时对账不动任何条目，绝不把生效记忆 enabled:false', async () => {
  seedWorld({
    sessions: [singleSession('s1', 'c1')],
    characters: [character('c1', [
      memoryEntry('e1', 'm1'),
      memoryEntry('e2', 'm2', { comment: '记忆总结 2' }),
    ])],
    messageValues: { s1: '{ broken' },
  });
  const result = await reconcileWorldMemories();
  assert.equal(result.retired, 0, '读不出消息时不许退休任何条目');
  assert.deepEqual(result.characters, []);
  assert.equal(saveCalls.length, 0, '读不出消息时不得写角色库');
  assert.deepEqual(entryState('c1'), ['e1:on', 'e2:on'], '所有生效条目原样保留（既不停用也不标 stale）');
});

test('P0：合法 JSON 但结构不是数组，同样算 corrupt ⇒ 不动', async () => {
  seedWorld({
    sessions: [singleSession('s1', 'c1')],
    characters: [character('c1', [memoryEntry('e1', 'm1')])],
    messageValues: { s1: '{"role":"user"}' },
  });
  const result = await reconcileWorldMemories();
  assert.equal(result.retired, 0);
  assert.equal(saveCalls.length, 0);
  assert.deepEqual(entryState('c1'), ['e1:on']);
});

test('missing（会话确实没有消息）仍按空集退休：防过度修正', async () => {
  seedWorld({
    sessions: [singleSession('s1', 'c1')],
    characters: [character('c1', [memoryEntry('e1', 'm1')])],
    // 消息键根本不存在 = missing：这是「真的没有」，不是「读不出」。
  });
  const result = await reconcileWorldMemories();
  assert.equal(result.retired, 1, 'missing 若也当成失败，空会话上的边界条目就永远退不了休');
  assert.equal(saveCalls.length, 1);
  assert.deepEqual(entryState('c1'), ['e1:off/stale']);
});

test('corrupt 与「boundary 全不匹配」可区分：前者不动，后者才退休', async () => {
  const sessions = [singleSession('s1', 'c1')];
  const characters = [character('c1', [memoryEntry('e1', 'm1')])];

  // (a) 读不出：消息体坏
  seedWorld({ sessions, characters, messageValues: { s1: '{ broken' } });
  const unreadable = await reconcileWorldMemories();
  const unreadableState = entryState('c1');

  // (b) 读得出，但会话里只有别的消息 → boundary 真的不属于这个会话
  seedWorld({
    sessions,
    characters,
    messageValues: { s1: [{ id: 'm9', role: 'user', text: 'hi' }] },
  });
  const mismatch = await reconcileWorldMemories();
  const mismatchState = entryState('c1');

  assert.equal(unreadable.retired, 0, '读不出 ⇒ 本次不动');
  assert.equal(mismatch.retired, 1, 'boundary 全不匹配 ⇒ 照旧退休');
  assert.deepEqual(unreadableState, ['e1:on']);
  assert.deepEqual(mismatchState, ['e1:off/stale']);
  assert.notDeepEqual(unreadableState, mismatchState, '两种情形的结果必须可区分');
});

test('boundary 属于唯一会话 ⇒ 不退休（与「读不出」区分开，防过度修正）', async () => {
  seedWorld({
    sessions: [singleSession('s1', 'c1')],
    characters: [character('c1', [memoryEntry('e1', 'm1')])],
    messageValues: { s1: [{ id: 'm1', role: 'user', text: 'hi' }] },
  });
  const result = await reconcileWorldMemories();
  assert.equal(result.retired, 0);
  assert.equal(saveCalls.length, 0);
  assert.deepEqual(entryState('c1'), ['e1:on']);
});

test('会话数 ≥2 时照旧退休：本次修复只改「读不出」这一支，不改变会话数判定', async () => {
  seedWorld({
    sessions: [singleSession('s1', 'c1'), singleSession('s2', 'c1')],
    characters: [character('c1', [memoryEntry('e1', 'm1')])],
    messageValues: { s1: '{ broken' },
  });
  const result = await reconcileWorldMemories();
  assert.equal(result.retired, 1, '多会话隔离是会话数判定，与消息读不读得出无关');
  assert.deepEqual(entryState('c1'), ['e1:off/stale']);
});

test('会话列表本身损坏：对账抛错且不写盘（同族 fail-closed）', async () => {
  seedWorld({
    characters: [character('c1', [memoryEntry('e1', 'm1')])],
  });
  store.set(SESSIONS_KEY, '{ broken');
  await assert.rejects(
    () => reconcileWorldMemories(),
    error => error && error.code === 'SESSIONS_CORRUPT'
  );
  assert.equal(saveCalls.length, 0);
  assert.deepEqual(entryState('c1'), ['e1:on']);
});

// P2-7：singleChatSessionsOf 曾在 memory/checkup.js 与 storage/memoryOwnership.js 里逐字
// 重复两份，任一侧漂移就会出现「体检说正常、对账在悄悄改」。这里做**行为**证明：
// babel 转译后的 ESM 调用是 `_checkup.singleChatSessionsOf(...)` 的属性访问（调用时才取），
// 所以替换 checkup 模块的导出即可观察到对账是否真的走它——若 memoryOwnership 还自带一份
// 本地实现，这个探针永远打不到。
test('P2-7：对账复用 memory/checkup.js 的 singleChatSessionsOf（单一实现）', async () => {
  seedWorld({
    sessions: [singleSession('s1', 'c1')],
    characters: [character('c1', [memoryEntry('e1', 'm1')])],
    messageValues: { s1: [{ id: 'm1', role: 'user', text: 'hi' }] },
  });
  const original = checkup.singleChatSessionsOf;
  let calls = 0;
  checkup.singleChatSessionsOf = (...args) => { calls += 1; return original(...args); };
  try {
    await reconcileWorldMemories();
  } finally {
    checkup.singleChatSessionsOf = original;
  }
  assert.ok(calls > 0, '对账必须真的调用 checkup 的 singleChatSessionsOf（不能自带副本）');

  // 源码锚点（补充，不是主要证据）：本模块不再定义该函数，改为 import。
  const source = fs.readFileSync(path.resolve('src/storage/memoryOwnership.js'), 'utf8');
  assert.ok(source.includes("from '../memory/checkup.js'"), '应改为从 memory/checkup.js 导入');
  assert.ok(!source.includes('function singleChatSessionsOf'), '不得再保留本地副本');
  // 无循环依赖：checkup.js 只依赖 memory/ 内的纯函数，不反向依赖 storage/**。
  // 判据只认 **import 说明符**：checkup.js 的注释里会提到本模块（说明「单一实现」的缘由），
  // 那不是依赖，按裸字符串匹配会把注释误判成环。
  const checkupSource = fs.readFileSync(path.resolve('src/memory/checkup.js'), 'utf8');
  assert.ok(!/from\s+'[^']*storage\//.test(checkupSource), 'checkup.js 不得反向依赖 storage/**');
  assert.ok(!/from\s+'[^']*memoryOwnership/.test(checkupSource), 'checkup.js 不得 import memoryOwnership.js');
});
