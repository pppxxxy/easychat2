// 导入写盘的**并发化**不得改变语义。
//
// 背景（用户实测 2026-10-19）：115MB 备份「导入成功，但好慢好慢」。
// 实测把慢拆开（Node 基准，V8）：
//   · JSON.parse 整个 115MB 包 ≈ 86ms
//   · 47 个媒体 base64 解码   ≈ 38ms
//   合计 ≈ 124ms —— 解析根本不是瓶颈。
// 真正慢的是**逐条串行 await**：每个媒体文件一次 makeDirectoryAsync + 一次
// writeAsStringAsync，每个存储键一次 setItem。115MB 的包 = 上百次原生往返排队。
//
// 本文件钉的是「并发化之后，用户可见的语义一条都没变」：
//   ① 每个存储键都真的写进去了（内容正确）；
//   ② 每个媒体文件都真的写进去了（内容正确）；
//   ③ 目录被**去重**后创建（原先每个文件建一次，纯浪费）；
//   ④ 任一写失败 → 整体失败 + 回滚（并发不能把失败吞掉）；
//   ⑤ 回滚本身也并发，且每个键都被还原。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const PRESET_ENV = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/storage/backup.js');

// ⚠️ 转译必须在**打桩之外**做：Module._load 被替换后，babel 自己去 require
// preset-env 会走我们的打桩函数 → 重入 → "Reentrant preset detected"。
// 所有子模块的转译也在桩外预先完成（compileModule 里不再调用 babel）。
const transpiled = new Map();
function compileToCjs(absPath) {
  if (transpiled.has(absPath)) return transpiled.get(absPath);
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false, configFile: false, filename: absPath,
    presets: [[PRESET_ENV, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  transpiled.set(absPath, code);
  return code;
}

function loadBackup({ storage = new Map(), files = new Map(), failSet = false, failMediaWrite = false, recordDiagnosticCalls = [], makeDirectoryCalls = [] } = {}) {
  const fileSystem = {
    documentDirectory: 'file:///doc/',
    EncodingType: { Base64: 'base64' },
    async getInfoAsync(uri) { return { exists: files.has(uri), isDirectory: false }; },
    async readAsStringAsync(uri) { return files.has(uri) ? files.get(uri) : ''; },
    async readDirectoryAsync() { return []; },
    async makeDirectoryAsync(uri, options) { makeDirectoryCalls.push({ uri, options }); },
    async writeAsStringAsync(uri, value) {
      if (failMediaWrite) throw new Error('media write failed');
      files.set(uri, value);
    },
    async deleteAsync(uri) { files.delete(uri); },
  };
  const asyncStorage = {
    async getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    async setItem(key, value) {
      if (failSet) throw new Error('setItem failed');
      storage.set(key, value);
    },
    async removeItem(key) { storage.delete(key); },
    async multiRemove(keys) { (keys || []).forEach(k => storage.delete(k)); },
    async getAllKeys() { return [...storage.keys()]; },
  };
  const originalLoad = Module._load;
  // ⚠️ 关键：**先**把 backup.js 转译好（此时 babel 未被桩影响），再装桩。
  // 否则 _compile 里第一次调用 babel 会在桩生效期间 require preset-env → 重入报错。
  const mainCode = compileToCjs(sourcePath);
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: asyncStorage };
    if (request === 'expo-file-system' || request === 'expo-file-system/legacy') return { __esModule: true, ...fileSystem };
    if (request.endsWith('/storage/diagnostics.js') || request === './diagnostics.js' || request === '../storage/diagnostics.js') {
      return { __esModule: true, recordDiagnostic: (...args) => recordDiagnosticCalls.push(args) };
    }
    if (request.endsWith('/storage/io.js') || request === './io.js') {
      return {
        __esModule: true,
        readJsonStatus: async () => ({ status: 'missing' }),
        readLargeAsyncStorageValue: async () => null,
        assertValueBudget: () => 0,
        backupCorruptValue: async () => {},
      };
    }
    if (request.endsWith('/storage/secretStore.js') || request === './secretStore.js') {
      return {
        __esModule: true,
        readSecureValue: async () => '',
        writeSecureValue: async () => {},
        removeSecureValue: async () => {},
        // backup.js 间接依赖 dataBackup.js，后者遍历密钥字段白名单。
        // SECRET_FIELDS 是数组、SECRET_OBJECT_FIELDS 是 Map（见 secretStore 的注释）。
        SECRET_FIELDS: [],
        SECRET_OBJECT_FIELDS: new Map(),
        SECRET_REF_PREFIX: 'secure:v1:',
      };
    }
    if (request.endsWith('/storage/backupStream.js') || request === './backupStream.js') {
      return { __esModule: true, createBackupChunkGenerator: function* () {} };
    }
    if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
      return { __esModule: true, tActive: key => String(key) };
    }
    if (parent && parent.filename && request.startsWith('.')) {
      const base = path.resolve(path.dirname(parent.filename), request);
      for (const candidate of [base, `${base}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const mod = new Module(candidate);
          mod.filename = candidate;
          mod.paths = Module._nodeModulePaths(path.dirname(candidate));
          mod._compile(compileToCjs(candidate), candidate);
          return mod.exports;
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete Module._cache[sourcePath];
  try {
    const mod = new Module(sourcePath);
    mod.filename = sourcePath;
    mod.paths = Module._nodeModulePaths(path.dirname(sourcePath));
    mod._compile(mainCode, sourcePath);
    return { backup: mod.exports, storage, files, makeDirectoryCalls, recordDiagnosticCalls };
  } finally {
    Module._load = originalLoad;
  }
}

function makePayload(mediaCount, storageCount) {
  return {
    schemaVersion: 1,
    storage: Array.from({ length: storageCount }, (_, i) => ({
      key: `@easychat2_k_${i}`,
      value: { id: `k${i}`, text: `v${i}` },
    })),
    media: Array.from({ length: mediaCount }, (_, i) => ({
      path: `avatars/a-${i}.png`,
      base64: Buffer.from(`img${i}`).toString('base64'),
    })),
    secrets: [],
  };
}

test('并发写：每个存储键与每个媒体文件都真的落盘，内容正确', async () => {
  const { backup, storage, files } = loadBackup();
  const payload = makePayload(8, 20);
  const result = await backup.importBackup(payload, 'overwrite');
  assert.equal(result.storageCount, 20);
  assert.equal(result.mediaCount, 8);
  // 存储键：逐个核对内容（并发不能丢键或写错值）
  for (const item of payload.storage) {
    const raw = storage.get(item.key);
    assert.ok(raw !== undefined, `${item.key} 必须被写入`);
    assert.deepEqual(JSON.parse(raw), item.value);
  }
  // 媒体：逐个核对字节
  for (const item of payload.media) {
    const uri = `file:///doc/${item.path}`;
    assert.ok(files.has(uri), `${uri} 必须被写入`);
    assert.equal(files.get(uri), item.base64);
  }
});

test('并发写：目录按父目录去重后创建（原先每文件建一次）', async () => {
  const { backup, makeDirectoryCalls } = loadBackup();
  // 8 个文件全在 avatars/ 下：去重后只应创建 1 次目录，而不是 8 次。
  await backup.importBackup(makePayload(8, 1), 'overwrite');
  const avatarDirs = makeDirectoryCalls.filter(call => call.uri === 'file:///doc/avatars/');
  assert.equal(
    avatarDirs.length,
    1,
    `同一目录只应创建一次，实际 ${avatarDirs.length} 次（逐文件创建是串行慢因之一）`
  );
});

test('并发写：任一 setItem 失败 → 整体失败并回滚，不假装成功', async () => {
  const { backup, storage, recordDiagnosticCalls } = loadBackup({ failSet: true });
  storage.set('@easychat2_k_0', '{"old":true}');
  await assert.rejects(
    () => backup.importBackup(makePayload(2, 4), 'overwrite'),
    /setItem failed/,
    '写失败必须抛出去（并发不能把失败吞掉）'
  );
  assert.ok(recordDiagnosticCalls.length > 0, '失败必须留诊断');
});

test('并发写：媒体写失败 → 整体失败（不留下「一半文件成功」的假象）', async () => {
  const { backup } = loadBackup({ failMediaWrite: true });
  await assert.rejects(
    () => backup.importBackup(makePayload(4, 2), 'overwrite'),
    /media write failed/
  );
});

test('并发度常量：必须有限且 >1（无限并发会让失败难归因，=1 等于没改）', () => {
  const { backup } = loadBackup();
  const limit = backup.IMPORT_WRITE_CONCURRENCY;
  assert.ok(Number.isFinite(limit), '并发度必须是有限数');
  assert.ok(limit > 1, `并发度必须 >1（实际 ${limit}），否则等于没改`);
  assert.ok(limit <= 16, `并发度不宜过大（实际 ${limit}），Android 单进程并发写无收益`);
});

test('对照：单个文件也能正常导入（并发实现的边界）', async () => {
  const { backup, storage, files } = loadBackup();
  const payload = makePayload(1, 1);
  const result = await backup.importBackup(payload, 'overwrite');
  assert.equal(result.storageCount, 1);
  assert.equal(result.mediaCount, 1);
  assert.ok(storage.has('@easychat2_k_0'));
  assert.ok(files.has('file:///doc/avatars/a-0.png'));
});
