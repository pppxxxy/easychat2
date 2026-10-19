// 媒体收集的**并发读**：必须更快，但结果顺序与串行版本完全一致。
//
// 背景（用户 2026-10-19「备份导致发烫」的第三个成因）：
// collectMedia 旧实现是 `for (name of entries) { await getInfoAsync; await readAsStringAsync }`
// —— 每个文件两次原生往返、严格串行。角色卡多的用户有几千张图，2N 次往返排成一条队，
// CPU 大部分时间在等 IO（长时间高负载 → 发热），而不是在算。
//
// 为什么必须保序：dataBackup.test.mjs 断言 `payload.media.map(path)` 与输入顺序一致；
// 备份包也应可复现（同一份数据两次导出字节序相同）。所以并发只影响「谁先读完」，
// 不影响「结果放在第几位」。
//
// 本文件用**可观测的并发峰值**证明「确实并发了」，而不是只断言「结果对」——
// 后者串行也能通过，测不出任何东西。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const PRESET_ENV = require.resolve('@babel/preset-env');
const SRC = path.resolve('src');
const BACKUP_PATH = path.join(SRC, 'storage', 'backup.js');

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

// 造一个「一个目录下 N 个文件」的文件系统，并记录读取并发峰值。
function makeFs({ fileCount, readDelayMs = 4, failFor = new Set() }) {
  const stats = { inFlight: 0, peak: 0, reads: 0, infos: 0 };
  const list = Array.from({ length: fileCount }, (_, i) => `f${String(i).padStart(3, '0')}.png`);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  const fileSystem = {
    documentDirectory: 'file:///doc/',
    EncodingType: { Base64: 'base64' },
    // backup.js 顶层 `import { File } from 'expo-file-system'`（流式写盘用）。
    // 本测试不走到写盘（backupStream 已桩成空生成器），但模块加载阶段需要它存在。
    File: class FakeFile {
      constructor(uri) { this.uri = String(uri); this.exists = false; }
      create() { this.exists = true; }
      open() { return { writeBytes() {}, close() {} }; }
      delete() { this.exists = false; }
    },
    async readDirectoryAsync(uri) {
      // 只让 characters/ 有文件：其它媒体目录返回空。
      // （若对所有目录都返回同一份列表，同一批文件会被重复收集，
      //  unreadableMedia 里就会混进无关条目，断言失去意义。）
      return /\/characters\/$/.test(String(uri)) ? list : [];
    },
    async getInfoAsync(uri) {
      stats.infos += 1;
      assert.match(uri, /^file:\/\/\/doc\/characters\//, `意外的 uri：${uri}`);
      return { exists: true, isDirectory: false };
    },
    async readAsStringAsync(uri) {
      stats.reads += 1;
      stats.inFlight += 1;
      if (stats.inFlight > stats.peak) stats.peak = stats.inFlight;
      try {
        await delay(readDelayMs);
        if (failFor.has(uri)) throw new Error('read failed');
        return 'AAAA';
      } finally {
        stats.inFlight -= 1;
      }
    },
    async makeDirectoryAsync() {},
    async writeAsStringAsync() {},
    async deleteAsync() {},
  };
  return { fileSystem, stats, list };
}

function loadBackupWith(fileSystem, storage = new Map()) {
  const originalLoad = Module._load;
  const mainCode = compileToCjs(BACKUP_PATH); // 装桩前转译（babel 会重入）
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') {
      return { __esModule: true, default: {
        async getItem(key) { return storage.has(key) ? storage.get(key) : null; },
        async setItem(key, value) { storage.set(key, value); },
        async removeItem(key) { storage.delete(key); },
        async multiRemove(keys) { (keys || []).forEach(k => storage.delete(k)); },
        async getAllKeys() { return [...storage.keys()]; },
      } };
    }
    if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
      return { __esModule: true, ...fileSystem };
    }
    if (request.endsWith('/storage/diagnostics.js') || request === './diagnostics.js') {
      return { __esModule: true, recordDiagnostic: () => {} };
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
  try {
    for (const key of Object.keys(Module._cache)) {
      if (key.startsWith(`${SRC}${path.sep}`)) delete Module._cache[key];
    }
    const mod = new Module(BACKUP_PATH);
    mod.filename = BACKUP_PATH;
    mod.paths = Module._nodeModulePaths(path.dirname(BACKUP_PATH));
    mod._compile(mainCode, BACKUP_PATH);
    return mod.exports;
  } finally {
    Module._load = originalLoad;
  }
}

test('并发读：读取确实并发（峰值 > 1），而不是串行排队', async () => {
  const { fileSystem, stats } = makeFs({ fileCount: 24, readDelayMs: 6 });
  const backup = loadBackupWith(fileSystem);
  const result = await backup.exportBackup({ appVersion: 'test' });
  assert.equal(result.mediaCount, 24, '24 个文件都应收集到');
  assert.ok(
    stats.peak > 1,
    `读取必须并发（峰值应为 >1，实际 ${stats.peak}）——串行时峰值恒为 1，备份会慢 N 倍`
  );
  // 上界保护：并发度必须有限（无限并发会让峰值内存重新失控）。
  assert.ok(
    stats.peak <= backup.MEDIA_READ_CONCURRENCY,
    `并发峰值不得超过设定上限 ${backup.MEDIA_READ_CONCURRENCY}（实际 ${stats.peak}）：`
    + '每个在飞文件都占一份 base64 内存，开太大等于把刚修好的峰值内存问题带回来'
  );
});

test('并发读：结果顺序与串行版一致（并发不改变第几位）', async () => {
  const { fileSystem, list } = makeFs({ fileCount: 30, readDelayMs: 3 });
  const backup = loadBackupWith(fileSystem);
  const result = await backup.exportBackup({ appVersion: 'test' });
  const paths = result.payload.media.map(item => item.path);
  assert.deepEqual(
    paths,
    list.map(name => `characters/${name}`),
    '媒体顺序必须与目录列举顺序一致（dataBackup 测试也依赖这一点）'
  );
});

test('并发读：串行等价性——并发快于串行（同一 N 下耗时更短）', async () => {
  const fileCount = 18;
  const delayMs = 8;
  // 并发版（当前实现）
  const concurrent = makeFs({ fileCount, readDelayMs: delayMs });
  const t0 = process.hrtime.bigint();
  await loadBackupWith(concurrent.fileSystem).exportBackup({ appVersion: 'test' });
  const concurrentMs = Number(process.hrtime.bigint() - t0) / 1e6;
  // 串行基准：直接顺序 await 同样次数
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < fileCount; i += 1) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  const serialFloorMs = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.ok(
    concurrentMs < serialFloorMs,
    `并发读应明显快于串行等待（并发 ${concurrentMs.toFixed(0)}ms vs 串行下界 ${serialFloorMs.toFixed(0)}ms）`
  );
});

test('并发读：单个文件读失败只计入 unreadableMedia，不中断其余文件', async () => {
  const failUri = 'file:///doc/characters/f002.png';
  const { fileSystem } = makeFs({ fileCount: 8, readDelayMs: 2, failFor: new Set([failUri]) });
  const backup = loadBackupWith(fileSystem);
  const result = await backup.exportBackup({ appVersion: 'test' });
  assert.equal(result.mediaCount, 7, '其余 7 个文件照常收集');
  assert.deepEqual(result.unreadableMedia, ['characters/f002.png'], '读不出的文件要被记录');
  assert.equal(result.incomplete, true, '丢了文件 ⇒ 备份不完整，必须告知用户');
});

test('并发度常量：必须是有限值且 >1（=1 等于没改）', () => {
  const { fileSystem } = makeFs({ fileCount: 1 });
  const backup = loadBackupWith(fileSystem);
  const limit = backup.MEDIA_READ_CONCURRENCY;
  assert.ok(Number.isFinite(limit), '并发度必须是有限数');
  assert.ok(limit > 1, `并发度必须 >1（实际 ${limit}）`);
  assert.ok(limit <= 16, `并发度不宜过大（实际 ${limit}），否则峰值内存会重新失控`);
});