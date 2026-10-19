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

// 可控的 expo-sqlite 替身：按 v16 的真实形态实现。
//
// 关键：替身必须模拟**真实的路径拼接行为**（fef85db 的教训是替身与真实 API 不一致，
// 于是测试一路绿而生产一路错）。这里照抄 pathUtils.createDatabasePath 的规则：
//     createDatabasePath(name, dir) = `${dir 去尾斜杠}/${name 去前导斜杠}`
// 未传 directory 时用 defaultDatabaseDirectory（真实值 = filesDir/SQLite）。
const DEFAULT_DB_DIR = 'file:///app/files/SQLite';

const sqliteState = {
  rowsByKey: new Map(),
  opened: [],
  queries: [],
  closed: 0,
  failOpen: false,
  // 假文件系统里「真实存在」的库路径集合（用来模拟「库不存在 = 不该被创建」）。
  existingDatabases: new Set(),
  // 被 SQLite **新建**的库路径（模拟 OpenDatabaseOptions 无 readonly 时的行为）。
  createdDatabases: [],
  // 表是否存在（false = 模拟 AsyncStorage 后端已换）。
  hasTable: true,
};
function resetSqlite() {
  sqliteState.rowsByKey.clear();
  sqliteState.opened.length = 0;
  sqliteState.queries.length = 0;
  sqliteState.closed = 0;
  sqliteState.failOpen = false;
  sqliteState.existingDatabases.clear();
  // documentDirectory = file:///app/files/ ⇒ 「../databases/RKStorage」= file:///app/databases/RKStorage
  sqliteState.existingDatabases.add('file:///app/databases/RKStorage');
  sqliteState.createdDatabases.length = 0;
  sqliteState.hasTable = true;
}

// 与 pathUtils.createDatabasePath 逐字对应的拼接规则。
function createDatabasePath(databaseName, directory) {
  const dir = String(directory ?? DEFAULT_DB_DIR).replace(/\/*$/, '');
  const name = String(databaseName).replace(/^\/+/, '');
  return `${dir}/${name}`;
}

// 归一：去掉 'files/../' 这种无意义跳转，便于按「真实文件」比较。
// （真机上 File 层会自己解析 '..'，JS 里只能手动抹平。）
function normalizePath(p) {
  return String(p).replace('/files/../', '/');
}

function makeFakeDatabase(path_) {
  // 空库（真库之外新建的那个）里没有 catalystLocalStorage 表 ⇒ 任何查询都抛
  // 「no such table: catalystLocalStorage」。这是真机日志里那条错误的精确形态，
  // 替身必须复现它，否则「打开错路径」在测试里只表现为路径字符串不同、
  // 而不是**用户可见的失败**。
  const isRealDatabase = sqliteState.existingDatabases.has(normalizePath(path_));
  const assertTable = () => {
    if (!sqliteState.hasTable) return [];
    if (!isRealDatabase) {
      throw new Error('Error code : no such table: catalystLocalStorage');
    }
    return null;
  };
  return {
    // 验表：PRAGMA table_info(catalystLocalStorage) 无行 ⇒ 表不存在。
    getAllAsync: async (sql, params = []) => {
      sqliteState.queries.push({ sql, params });
      if (/PRAGMA\s+table_info/i.test(sql)) {
        if (!isRealDatabase) {
          throw new Error('Error code : no such table: catalystLocalStorage');
        }
        return sqliteState.hasTable ? [{ name: 'key' }, { name: 'value' }] : [];
      }
      return assertTable() || [];
    },
    getFirstAsync: async (sql, params = []) => {
      sqliteState.queries.push({ sql, params });
      const failed = assertTable();
      if (failed) throw new Error('Error code : no such table: catalystLocalStorage');
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
    databasePath: path_,
    closeAsync: async () => { sqliteState.closed += 1; },
  };
}

// 记录「模块被判据接受/拒绝」用它来判断：v16 形态必须被接受。
const fakeSqliteModule = {
  defaultDatabaseDirectory: DEFAULT_DB_DIR,
  openDatabaseSync(name, options, directory) {
    if (sqliteState.failOpen) throw new Error('cannot open');
    const rawPath = createDatabasePath(name, directory);
    const dbPath = normalizePath(rawPath);
    sqliteState.opened.push({ name, directory, path: dbPath, rawPath });
    // 模拟真实行为：库不存在时 SQLite 会**新建**（原生端没有 readonly 选项）。
    if (!sqliteState.existingDatabases.has(dbPath)) sqliteState.createdDatabases.push(dbPath);
    return makeFakeDatabase(dbPath);
  },
  async openDatabaseAsync(name, options, directory) {
    return fakeSqliteModule.openDatabaseSync(name, options, directory);
  },
  // 故意**不**提供 openDatabase：v16 真实形态就是这样。
};

const fakeFileSystem = {
  documentDirectory: 'file:///app/files/',
  // 存在性以 sqliteState.existingDatabases 为准——「真库不存在」这条用例需要它真的返回 false，
  // 否则「不新建空库」就测不出来了。
  // ⚠️ io.js 查的是**带 '..' 的原始串**（file:///app/files/../databases/RKStorage），
  // 而库路径是 createDatabasePath 拼出来的。两者字符串不同但指同一文件，
  // 所以这里要归一（去掉 'files/../'）后再比，否则测试会因为字符串不等而永远「库不存在」。
  getInfoAsync: async uri => {
    const normalized = String(uri).replace('/files/../', '/');
    const known = [...sqliteState.existingDatabases].some(db => db === normalized);
    return { exists: known };
  },
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

// ── 本轮核心：路径必须指向**真库**，且绝不新建空库 ──────────────────────────
//
// fef85db 的 bug：传 name='../databases/RKStorage'、不带 directory，于是
//   createDatabasePath('../databases/RKStorage', filesDir/SQLite)
//     = filesDir/SQLite/../databases/RKStorage = filesDir/databases/RKStorage
// 那是**另一个库**（不存在）⇒ SQLite 新建空库 ⇒ 查询报 no such table。
// 用户日志里每次启动都出现的那条错误正是它。

test('路径：必须用 directory 指向真库目录，且 path 里不得出现 ".."', async () => {
  sqliteState.rowsByKey.set('@k', 'abc');
  await io.readLargeAsyncStorageValue('@k');
  assert.equal(sqliteState.opened.length >= 1, true, '必须真的打开过数据库');
  const opened = sqliteState.opened[sqliteState.opened.length - 1];
  // 真实布局：documentDirectory = file:///app/files/ ⇒ 真库在 file:///app/databases/RKStorage
  assert.equal(
    opened.path,
    'file:///app/databases/RKStorage',
    `必须解析到 AsyncStorage 的真库（不是 files/SQLite 下那个），实际：${opened.path}`
  );
  // 后果链：路径错了 ⇒ 那是另一个库 ⇒ 不存在 ⇒ SQLite 新建空库 ⇒ 查询报 no such table。
  // 所以「有没有新建库」是本 bug 最直接的判据（比字符串检查更贴近真机行为）。
  assert.deepEqual(
    sqliteState.createdDatabases,
    [],
    `不得新建任何库文件（新建 = 打开了错路径的空库），实际：${JSON.stringify(sqliteState.createdDatabases)}`
  );
  assert.equal(opened.name, 'RKStorage', 'name 必须是纯文件名');
  assert.match(String(opened.directory), /databases\/?$/, 'directory 必须指向 databases/');
});

test('不新建空库：真库不存在时直接返回 null，根本不调用 openDatabase', async () => {
  sqliteState.rowsByKey.clear();
  sqliteState.existingDatabases.clear(); // 真库不存在
  // fakeFileSystem.getInfoAsync 恒返回 exists:true，这里改为按集合判断
  sqliteState.failOpen = false;
  const openedBefore = sqliteState.opened.length;
  const value = await io.readLargeAsyncStorageValue('@k');
  assert.equal(value, null);
  // 关键：existingDatabases 里没有真库 ⇒ 若代码仍去 open，替身会记进 createdDatabases。
  assert.deepEqual(
    sqliteState.createdDatabases,
    [],
    `不得新建任何库文件，实际新建：${JSON.stringify(sqliteState.createdDatabases)}`
  );
  assert.equal(sqliteState.opened.length, openedBefore, '真库不存在时不该进入打开流程');
});

test('验表：catalystLocalStorage 不存在时如实留痕（「后端已换」而不是一句 no such table）', async () => {
  sqliteState.rowsByKey.set('@k', 'abc');
  sqliteState.hasTable = false;
  const value = await io.readLargeAsyncStorageValue('@k');
  assert.equal(value, null);
  const diags = sqliteState.queries.filter(q => q.diagnostic);
  assert.ok(diags.length >= 1, '表不存在必须留痕');
  // 诊断文案走 tActive（真实 i18n，zh-CN 基准语言）：必须指出「表不存在 / 后端可能已换」，
  // 而不是笼统的「读取失败」——后者无法区分「数据没了」与「存储实现换了」。
  assert.match(
    String(diags[diags.length - 1].diagnostic),
    /catalystLocalStorage|表不存在/,
    `诊断要指出「表不存在/后端可能已换」，实际：${diags[diags.length - 1].diagnostic}`
  );
  // 验表之后不该再盲查行
  const rowQueries = sqliteState.queries.filter(q => q.sql && /length\(value\)/.test(q.sql));
  assert.equal(rowQueries.length, 0, '表不存在时不得再盲查数据行');
});
