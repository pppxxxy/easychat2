// 大值兜底读取（readLargeAsyncStorageValue）的**可观测性**行为测试。
//
// 回归 2026-10-11 逐行审查 P1：这个函数此前一路静默 `return null`——它是 Android
// CursorWindow 单值上限（约 2MB）之下「聊天记录永久读不出」的最后一道防线，一旦它坏了，
// 用户只看到「聊天记录读取失败」，诊断日志里**一条记录都没有**，无从判断是数据没了
// 还是兜底路径坏了。这个文件把「失败必须留痕」钉成行为：跑真 io.js，喂各种失败，
// 断言 diagnostics 里真的出现了对应记录。
//
// 加载方式：真 io.js + 真 diagnostics.js，只把 AsyncStorage / FileSystem / expo-sqlite
// 三个原生边界换成可控替身。

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

// 每个用例通过 scenario 控制三个原生边界的行为。
let scenario = {};
const FileSystem = {
  documentDirectory: 'file:///documents/',
  getInfoAsync: async () => {
    if (scenario.infoThrows) throw new Error('file system unavailable');
    return { exists: scenario.dbExists !== false };
  },
};

// 替身必须对齐**本仓真实的 expo-sqlite v16 形态**：openDatabaseSync + getFirstAsync(sql, params)。
//
// 这里曾经写的是 v13 时代的 `openDatabase` + `execAsync([{sql,args}], true)`——
// 而那套 API 在本仓的 expo-sqlite 16.0.10 里**根本不存在**。后果有两层：
//   ① 生产代码照着这个替身写，判据查 `SQLite.openDatabase` 永远为假，大值兜底
//      成了死代码（真机日志：「大值兜底读取不可用（缺少 SQLite 模块）」）；
//   ② 这个测试却一路绿——它验证的是替身自己，不是真实模块的形态。
// 教训：替身的形状必须来自**已核实的真实导出**，否则测试只是自说自话。
function makeSqliteStub() {
  return {
    openDatabaseSync: () => ({
      // 验表（PRAGMA table_info）：io.js 现在会先确认 catalystLocalStorage 存在。
      // 默认返回非空 = 表存在；scenario.tableMissing 时返回空数组模拟「后端已换」。
      getAllAsync: async sqlSource => {
        if (scenario.execThrows) throw new Error('cursor window failure');
        if (/PRAGMA\s+table_info/i.test(String(sqlSource))) {
          return scenario.tableMissing ? [] : [{ name: 'key' }, { name: 'value' }];
        }
        return [];
      },
      getFirstAsync: async (sqlSource, params) => {
        const sql = String(sqlSource || '');
        const args = Array.isArray(params) ? params : [];
        if (scenario.execThrows) throw new Error('cursor window failure');
        if (sql.includes('length(value)')) return { total: scenario.total };
        // 分块查询：按请求长度返回，且 scenario.truncateAt 之后的块返回空（模拟读截断）。
        const offset = Number(args[0]) || 1;
        if (scenario.truncateAt !== undefined && offset > scenario.truncateAt) {
          return { chunk: null };
        }
        const count = Number(args[1]) || 4;
        const remaining = Math.max(0, Number(scenario.total) - (offset - 1));
        return { chunk: 'x'.repeat(Math.min(count, remaining)) };
      },
      closeAsync: async () => {},
    }),
  };
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: AsyncStorage };
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
    return { __esModule: true, ...FileSystem };
  }
  if (request === 'expo-sqlite') {
    if (scenario.sqliteMissing) throw new Error('expo-sqlite not installed');
    return makeSqliteStub();
  }
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

// getSqliteModule 有模块级缓存：同一文件里要同时测「expo-sqlite 不可用」与「可用但读失败」，
// 只能每个用例换一套全新的模块实例（顺带把 diagnostics 也换新，保证查询的是同一实例）。
function freshModules(nextScenario) {
  Object.keys(Module._cache).forEach(key => {
    if (key.startsWith(`${SRC_DIR}${path.sep}`)) delete Module._cache[key];
  });
  // 诊断是**持久化**的（写在 @easychat2_diagnostics 上）：不清存储的话，上一个用例记的
  // 那条会被下一个用例读回来，断言条数就成了 2。
  store.clear();
  scenario = nextScenario;
  const io = loadModule(path.resolve('src/storage/io.js'));
  const diagnostics = loadModule(path.resolve('src/storage/diagnostics.js'));
  diagnostics.__resetDiagnosticsForTests();
  return { io, diagnostics };
}

async function runCase(nextScenario) {
  const { io, diagnostics } = freshModules(nextScenario);
  const result = await io.readLargeAsyncStorageValue('@easychat2_messages::s1');
  // recordDiagnostic 内部走异步队列，等它落定再读。
  await new Promise(resolve => setTimeout(resolve, 0));
  return { result, entries: await diagnostics.getDiagnostics() };
}

test('expo-sqlite 不可用时留痕（而不是静默 return null）', async () => {
  const { result, entries } = await runCase({ sqliteMissing: true });
  assert.equal(result, null);
  assert.equal(entries.length, 1, `应恰好记一条诊断，实际 ${entries.length}`);
  assert.equal(entries[0].kind, 'storage');
  // 诊断的 message 走 i18n（用户可见），测试里 tActive 被桩成「返回键名」。
  assert.match(entries[0].message, /error\.storage\.largeValueFallbackUnavailable/);
  assert.match(entries[0].context, /@easychat2_messages::s1/, '诊断要带上是哪个键');
});

test('访问数据库文件失败时留痕（带上原始错误）', async () => {
  const { result, entries } = await runCase({ infoThrows: true });
  assert.equal(result, null);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'storage');
  assert.match(entries[0].message, /file system unavailable/, '原始错误要进诊断');
  assert.match(entries[0].context, /大值兜底读取/);
});

test('SQLite 读取抛错时留痕（CursorWindow 兜底失败这条路必须可见）', async () => {
  const { result, entries } = await runCase({ execThrows: true });
  assert.equal(result, null);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'storage');
  assert.match(entries[0].message, /cursor window failure/);
  assert.match(entries[0].context, /大值兜底读取失败：@easychat2_messages::s1/);
});

test('分块读截断时留痕（length 说有数据、substr 拿不到）', async () => {
  const { result, entries } = await runCase({ total: 1000, truncateAt: 0 });
  assert.equal(result, null);
  assert.equal(entries.length, 1);
  assert.match(entries[0].message, /error\.storage\.largeValueReadTruncated/);
  assert.match(entries[0].context, /@easychat2_messages::s1/);
});

test('对照：数据库文件不存在 = 键本来就不在，不记诊断（别把正常情况报成故障）', async () => {
  const { result, entries } = await runCase({ dbExists: false });
  assert.equal(result, null);
  assert.deepEqual(entries, [], '「没有这条数据」不是失败，不该留痕');
});

test('对照：读到数据时正常返回，且不记诊断', async () => {
  const { result, entries } = await runCase({ total: 8 });
  assert.equal(result, 'xxxxxxxx', '分块拼接结果');
  assert.deepEqual(entries, []);
});
