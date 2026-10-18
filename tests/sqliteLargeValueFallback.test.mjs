// 大值兜底读取（readLargeAsyncStorageValue）的 SQLite 版本判据。
//
// 事故（真机日志，反复出现）：
//   storage: 大值兜底读取不可用（缺少 SQLite 模块）
//     context: @easychat2_session_draft::session-muv4pyxs-g56ze6
// 模块明明装着——只是判据查的是 `SQLite.openDatabase`，而本仓的 expo-sqlite 是 **v16**，
// 它导出 `openDatabaseSync` / `openDatabaseAsync`，从来没有 `openDatabase`。
// 后果不是"兜底偶尔失败"，而是"兜底从未存在"：任何超过 CursorWindow ~2MB 单值上限的
// 键，readJsonStatus 只能判 corrupt，用户的草稿/会话被判成读不出。
//
// 本文件钉两件事：
//   ① 判据必须对着真实的导出名（v16 的两个 open 函数），不能靠记忆里的旧名字；
//   ② 拿到模块后**真的**走 getFirstAsync 分片读，而不是 execAsync([{sql,args}], true)
//      那套 v13 形态（v16 的 execAsync 只收一个字符串，传数组会直接抛）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const SRC_DIR = path.resolve('src');

// 可控的 expo-sqlite 替身：按 v16 的真实形态实现（openDatabaseSync + getFirstAsync）。
const sqliteState = {
  rowsByKey: new Map(),
  opened: [],
  queries: [],
  closed: 0,
  failOpen: false,
};
function resetSqlite() {
  sqliteState.rowsByKey.clear();
  sqliteState.opened.length = 0;
  sqliteState.queries.length = 0;
  sqliteState.closed = 0;
  sqliteState.failOpen = false;
}

function makeFakeDatabase() {
  return {
    getFirstAsync: async (sql, params = []) => {
      sqliteState.queries.push({ sql, params });
      if (/length\(value\)/.test(sql)) {
        const value = sqliteState.rowsByKey.get(params[0]);
        return value === undefined ? null : { total: value.length };
      }
      if (/substr\(value/.test(sql)) {
        const [start, length, key] = params;
        const value = sqliteState.rowsByKey.get(key);
        if (value === undefined) return null;
        return { chunk: value.slice(start - 1, start - 1 + length) };
      }
      return null;
    },
    closeAsync: async () => { sqliteState.closed += 1; },
  };
}

// 记录「模块被判据接受/拒绝」用它来判断：v16 形态必须被接受。
const fakeSqliteModule = {
  openDatabaseSync(name) {
    if (sqliteState.failOpen) throw new Error('cannot open');
    sqliteState.opened.push(name);
    return makeFakeDatabase();
  },
  // 故意**不**提供 openDatabase：v16 真实形态就是这样。
};

const fakeFileSystem = {
  documentDirectory: 'file:///app/files/',
  getInfoAsync: async () => ({ exists: true }),
};

const fakeDiagnostics = {
  __esModule: true,
  recordDiagnostic: (kind, error, ctx) => {
    sqliteState.queries.push({ diagnostic: String((error && error.message) || error), ctx });
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'expo-sqlite') return fakeSqliteModule;
  if (request === 'expo-file-system/legacy' || request === 'expo-file-system') return fakeFileSystem;
  if (request === '@react-native-async-storage/async-storage') {
    return { __esModule: true, default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } };
  }
  if (request.endsWith('/storage/diagnostics.js') || request === './diagnostics.js' || request === '../storage/diagnostics.js') {
    return fakeDiagnostics;
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const base = path.resolve(path.dirname(parent.filename), request);
    if (base.startsWith(`${SRC_DIR}${path.sep}`)) {
      const file = require('node:fs').existsSync(base) ? base : `${base}.js`;
      const fs = require('node:fs');
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
const ioPath = path.join(SRC_DIR, 'storage', 'io.js');
const ioCode = babel.transformSync(require('node:fs').readFileSync(ioPath, 'utf8'), {
  babelrc: false, configFile: false, filename: ioPath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const ioModule = new Module(ioPath);
ioModule.filename = ioPath;
ioModule.paths = Module._nodeModulePaths(path.dirname(ioPath));
ioModule._compile(ioCode, ioPath);
const io = ioModule.exports;

test.beforeEach(() => { resetSqlite(); });

test('判据：v16 的 openDatabaseSync 必须被认（旧判据查 openDatabase → 永远为假）', () => {
  // 这条直接钉住事故本身：模块「有 openDatabaseSync、没有 openDatabase」时必须可用。
  const resolved = io.resolveSqliteOpener(fakeSqliteModule);
  assert.equal(resolved, 'openDatabaseSync', 'v16 的同步打开函数必须被识别');
  assert.equal(io.resolveSqliteOpener({}), null, '空模块必须判为不可用');
  assert.equal(io.resolveSqliteOpener(null), null);
});

test('判据：只有异步打开函数时也能识别（不同 expo-sqlite 版本）', () => {
  assert.equal(
    io.resolveSqliteOpener({ openDatabaseAsync: async () => ({}) }),
    'openDatabaseAsync'
  );
});

test('读取：走 getFirstAsync 分片取回完整字符串', async () => {
  const big = 'x'.repeat(700 * 1024); // 700KB > 256KB 片长，必须分多片
  sqliteState.rowsByKey.set('@k', big);
  const value = await io.readLargeAsyncStorageValue('@k');
  assert.equal(value, big, '必须原样拼回（分片顺序不能乱）');
  assert.ok(sqliteState.opened.length >= 1, '必须真的打开了数据库');
  assert.ok(sqliteState.closed >= 1, '必须关闭数据库');
  // 分片读必须用 substr 多次往返，而不是一次性取回
  const substrQueries = sqliteState.queries.filter(q => q.sql && /substr\(value/.test(q.sql));
  assert.ok(substrQueries.length >= 3, `700KB / 256KB 至少 3 片，实际 ${substrQueries.length}`);
  // 每片的参数形态必须是 [start, length, key]（v16 的 getFirstAsync(sql, params)）
  assert.equal(substrQueries[0].params.length, 3);
});

test('读取：键不存在时返回 null 且不误报为失败', async () => {
  const value = await io.readLargeAsyncStorageValue('@missing');
  assert.equal(value, null);
  const diags = sqliteState.queries.filter(q => q.diagnostic);
  assert.equal(diags.length, 0, '「键不存在」是正常情形，不该记诊断');
});

test('读取：打开失败要留痕并返回 null（不抛给上层）', async () => {
  sqliteState.rowsByKey.set('@k', 'abc');
  sqliteState.failOpen = true;
  const value = await io.readLargeAsyncStorageValue('@k');
  assert.equal(value, null);
  const diags = sqliteState.queries.filter(q => q.diagnostic);
  assert.ok(diags.length >= 1, '失败必须留一条诊断，否则用户与开发者都无从判断');
});
