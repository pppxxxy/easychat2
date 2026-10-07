import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/storage/backup.js');

function loadBackup({ storage, files, failSet = false, failMediaWrite = false, directories = {}, throwsOnRead = new Set(), recordDiagnosticCalls = [] }) {
  const fileSystem = {
    documentDirectory: 'file:///doc/',
    EncodingType: { Base64: 'base64' },
    async getInfoAsync(uri) {
      return { exists: files.has(uri), isDirectory: false };
    },
    async readAsStringAsync(uri) {
      if (!files.has(uri)) throw new Error('missing file');
      return files.get(uri);
    },
    async readDirectoryAsync(uri) {
      const names = directories[uri];
      if (!names) throw new Error('no dir');
      return names;
    },
    async makeDirectoryAsync() {},
    async writeAsStringAsync(uri, value) {
      if (failMediaWrite) throw new Error('media write failed');
      files.set(uri, value);
    },
    async deleteAsync(uri) {
      files.delete(uri);
    },
  };
  const asyncStorage = {
    async getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    async setItem(key, value) {
      if (failSet) {
        failSet = false;
        throw new Error('storage write failed');
      }
      storage.set(key, value);
    },
    async removeItem(key) { storage.delete(key); },
    async multiRemove(keys) { keys.forEach(key => storage.delete(key)); },
    async getAllKeys() { return [...storage.keys()]; },
  };
  const io = {
    async readJsonStatus(key) {
      if (throwsOnRead.has(key)) {
        // 模拟 getItem 抛错（如 CursorWindow 2MB 上限）且分块兜底也读不回：
        // 连原始串都没有，只能返回 raw: undefined。
        return { status: 'corrupt', raw: undefined };
      }
      if (!storage.has(key)) return { status: 'missing' };
      const raw = storage.get(key);
      try {
        return { status: 'ok', value: JSON.parse(raw) };
      } catch (error) {
        // 与真实 io.js 对齐：corrupt 时回传能拿到的原始串，供导出侧 opaqueRaw 抢救。
        return { status: 'corrupt', raw: typeof raw === 'string' ? raw : undefined };
      }
    },
    async readLargeAsyncStorageValue() { return null; },
    utf8ByteLength: text => Buffer.byteLength(String(text), 'utf8'),
  };
  const dataBackup = {
    BACKUP_MAX_BYTES: 64 * 1024 * 1024,
    buildBackupPayload: input => input,
    planBackupImport: (payload, mode) => ({
      valid: true,
      mode: mode === 'replace' ? 'replace' : 'merge',
      storage: payload.storage || [],
      media: payload.media || [],
    }),
  };
  const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: sourcePath,
    presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  // 新版 expo-file-system 的 File/FileHandle 打桩：
  // 写入按顺序 append 到 files，delete 时移除，用于验证流式写盘与取消清理。
  class FakeFileHandle {
    constructor(file) {
      this.file = file;
      this.closed = false;
    }
    writeBytes(bytes) {
      if (this.closed) throw new Error('file handle is closed');
      const previous = files.get(this.file.uri) || '';
      files.set(this.file.uri, previous + Buffer.from(bytes).toString('utf8'));
    }
    close() {
      this.closed = true;
    }
  }
  class FakeFile {
    constructor(...segments) {
      this.uri = segments.map(String).join('');
    }
    get exists() {
      return files.has(this.uri);
    }
    create() {
      if (failMediaWrite) throw new Error('backup write failed');
      if (!files.has(this.uri)) files.set(this.uri, '');
    }
    open() {
      return new FakeFileHandle(this);
    }
    delete() {
      files.delete(this.uri);
    }
  }
  const newFileSystem = { File: FakeFile };
  const diagnostics = {
    recordDiagnostic(kind, error, context = '') {
      recordDiagnosticCalls.push({ kind, message: error && error.message, context });
    },
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') return asyncStorage;
    if (request === 'expo-file-system/legacy') return fileSystem;
    if (request === 'expo-file-system') return newFileSystem;
    if (request.endsWith('/dataBackup.js')) return dataBackup;
    if (request.endsWith('/io.js')) return io;
    if (request.endsWith('/diagnostics.js')) return diagnostics;
    return originalLoad.call(this, request, parent, isMain);
  };
  const runtime = new Module(sourcePath);
  runtime.filename = sourcePath;
  runtime.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  runtime._compile(transformed, sourcePath);
  Module._load = originalLoad;
  return runtime.exports;
}

function payload(storage, media = []) {
  return { schemaVersion: 1, storage, media };
}

test('importBackup：恢复媒体文件并保留合并模式已有键', async () => {
  const storage = new Map([['@easychat2_keep', JSON.stringify({ keep: true })]]);
  const files = new Map();
  const backup = loadBackup({ storage, files });
  const result = await backup.importBackup(payload([
    { key: '@easychat2_character_index', value: ['c1'] },
  ], [{ path: 'avatars/c1.jpg', base64: 'AA==' }]), 'merge');
  assert.equal(result.mediaCount, 1);
  assert.equal(storage.has('@easychat2_keep'), true);
  assert.equal(storage.get('@easychat2_character_index'), JSON.stringify(['c1']));
  assert.equal(files.get('file:///doc/avatars/c1.jpg'), 'AA==');
});

test('importBackup replace：写入失败后回滚原有存储', async () => {
  const storage = new Map([
    ['@easychat2_character_index', JSON.stringify(['old'])],
    ['@easychat2_keep', JSON.stringify({ keep: true })],
  ]);
  const files = new Map();
  const backup = loadBackup({ storage, files, failSet: true });
  await assert.rejects(
    backup.importBackup(payload([
      { key: '@easychat2_character_index', value: ['new'] },
    ]), 'replace'),
    /storage write failed/
  );
  assert.equal(storage.get('@easychat2_character_index'), JSON.stringify(['old']));
  assert.equal(storage.get('@easychat2_keep'), JSON.stringify({ keep: true }));
});

test('importBackup：媒体写入失败后回滚已存在媒体', async () => {
  const storage = new Map();
  const files = new Map([['file:///doc/voice/old.m4a', 'OLD']]);
  const backup = loadBackup({ storage, files, failMediaWrite: true });
  await assert.rejects(
    backup.importBackup(payload([], [{ path: 'voice/old.m4a', base64: 'NEW' }]), 'merge'),
    /media write failed/
  );
  assert.equal(files.get('file:///doc/voice/old.m4a'), 'OLD');
});

test('exportBackup：损坏键被抢救为 opaqueRaw，读不出的媒体计入 incomplete', async () => {
  const storage = new Map([
    ['@easychat2_ok', JSON.stringify({ ok: true })],
    ['@easychat2_broken', '{ not valid json'],
  ]);
  const files = new Map([
    ['file:///doc/avatars/good.jpg', 'GOOD'],
    // 目录里有 good 与 bad 两个文件，bad 读不出来
    ['file:///doc/avatars', undefined],
  ]);
  const directories = {
    'file:///doc/avatars/': ['good.jpg', 'bad.jpg'],
    'file:///doc/stickers/': [],
    'file:///doc/chat-images/': [],
    'file:///doc/voice/': [],
    'file:///doc/characters/': [],
    'file:///doc/card-forge/': [],
  };
  const backup = loadBackup({ storage, files, directories });
  const result = await backup.exportBackup({ appVersion: 'test' });
  assert.equal(result.incomplete, true);
  // parse 失败但原始串拿得到：进 partialKeys，原始串原样入包，不再算「读取失败」
  assert.deepEqual(result.unreadableKeys, []);
  assert.deepEqual(result.partialKeys, ['@easychat2_broken']);
  const salvaged = result.payload.storage.find(item => item.key === '@easychat2_broken');
  assert.equal(salvaged.opaqueRaw, '{ not valid json');
  assert.equal(salvaged.value, undefined);
  assert.deepEqual(result.unreadableMedia, ['avatars/bad.jpg']);
  assert.equal(result.storageCount, 2);
  assert.equal(result.mediaCount, 1);
});

test('exportBackup：onProgress 依次上报 storage/media/packing/writing/done 阶段', async () => {
  const storage = new Map([
    ['@easychat2_a', JSON.stringify({ a: 1 })],
    ['@easychat2_b', JSON.stringify({ b: 2 })],
  ]);
  const files = new Map([['file:///doc/avatars/x.jpg', 'X']]);
  const directories = {
    'file:///doc/avatars/': ['x.jpg'],
    'file:///doc/stickers/': [],
    'file:///doc/chat-images/': [],
    'file:///doc/voice/': [],
    'file:///doc/characters/': [],
    'file:///doc/card-forge/': [],
  };
  const backup = loadBackup({ storage, files, directories });
  const phases = [];
  const result = await backup.exportBackup({
    appVersion: 'test',
    onProgress: p => phases.push(p),
  });
  assert.ok(phases.some(p => p.phase === 'storage' && p.done === 2 && p.total === 2), '应上报数据键进度');
  assert.ok(phases.some(p => p.phase === 'media' && p.done === 1), '应上报媒体文件进度');
  assert.ok(phases.some(p => p.phase === 'packing'), '应上报打包阶段');
  assert.ok(phases.some(p => p.phase === 'done'), '应上报完成阶段');
  assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result.payload), 'utf8'));
});

test('exportBackup：signal 已中止时立即抛 AbortError（不产出文件）', async () => {
  const storage = new Map([['@easychat2_a', JSON.stringify({ a: 1 })]]);
  const files = new Map();
  const directories = {};
  const backup = loadBackup({ storage, files, directories });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    backup.exportBackup({ appVersion: 'test', signal: controller.signal }),
    error => error && error.name === 'AbortError'
  );
});

test('exportBackup：流式写盘内容与整包序列化逐字一致', async () => {
  const storage = new Map([
    ['@easychat2_a', JSON.stringify({ a: 1, 中文: '值' })],
    ['@easychat2_b', JSON.stringify({ b: [1, 2, 3] })],
  ]);
  const files = new Map([['file:///doc/avatars/x.jpg', 'XYZ']]);
  const directories = {
    'file:///doc/avatars/': ['x.jpg'],
    'file:///doc/stickers/': [],
    'file:///doc/chat-images/': [],
    'file:///doc/voice/': [],
    'file:///doc/characters/': [],
    'file:///doc/card-forge/': [],
  };
  const backup = loadBackup({ storage, files, directories });
  const result = await backup.exportBackup({ appVersion: 'test' });
  const written = files.get(result.uri);
  assert.equal(written, JSON.stringify(result.payload), '流式写盘内容应与整包 JSON 一致');
  assert.equal(result.bytes, Buffer.byteLength(written, 'utf8'));
});

test('exportBackup：写盘阶段可取消（signal 在流式写入中生效）', async () => {
  const storage = new Map([
    ['@easychat2_a', JSON.stringify({ a: 1 })],
    ['@easychat2_b', JSON.stringify({ b: 2 })],
  ]);
  const files = new Map();
  const directories = {};
  const backup = loadBackup({ storage, files, directories });
  const controller = new AbortController();
  const phases = [];
  await assert.rejects(
    backup.exportBackup({
      appVersion: 'test',
      signal: controller.signal,
      onProgress: p => {
        phases.push(p.phase);
        // 一旦进入写盘阶段就取消：应中止且不留下半成品文件
        if (p.phase === 'writing') controller.abort();
      },
    }),
    error => error && error.name === 'AbortError'
  );
  assert.ok(phases.includes('writing'), '取消应发生在写盘阶段');
  const leftovers = [...files.keys()].filter(uri => uri.includes('easychat2-backup-'));
  assert.equal(leftovers.length, 0, '取消后不应残留半成品备份文件');
});

test('exportBackup：三态分流——正常/损坏抢救/真读不出互不混淆', async () => {
  const storage = new Map([
    ['@easychat2_good', JSON.stringify({ ok: true })],
    ['@easychat2_broken', '{ not valid json'],
    ['@easychat2_dead', JSON.stringify({ ignored: true })],
  ]);
  const files = new Map();
  const directories = {
    'file:///doc/avatars/': [],
    'file:///doc/stickers/': [],
    'file:///doc/chat-images/': [],
    'file:///doc/voice/': [],
    'file:///doc/characters/': [],
    'file:///doc/card-forge/': [],
  };
  const diagnosticCalls = [];
  const backup = loadBackup({
    storage,
    files,
    directories,
    throwsOnRead: new Set(['@easychat2_dead']),
    recordDiagnosticCalls: diagnosticCalls,
  });
  const result = await backup.exportBackup({ appVersion: 'test' });
  // 正常键：结构化 value
  assert.deepEqual(result.payload.storage.find(i => i.key === '@easychat2_good').value, { ok: true });
  // 损坏键：opaqueRaw 原样入包，计入 partialKeys，不计入 unreadableKeys
  const broken = result.payload.storage.find(i => i.key === '@easychat2_broken');
  assert.equal(broken.opaqueRaw, '{ not valid json');
  assert.deepEqual(result.partialKeys, ['@easychat2_broken']);
  // 真读不出：计入 unreadableKeys，不上包
  assert.deepEqual(result.unreadableKeys, ['@easychat2_dead']);
  assert.equal(result.payload.storage.some(i => i.key === '@easychat2_dead'), false);
  // 键名进诊断日志（带原因）
  assert.equal(diagnosticCalls.length, 1);
  assert.equal(diagnosticCalls[0].kind, 'storage');
  assert.match(diagnosticCalls[0].message, /@easychat2_dead/);
  assert.equal(diagnosticCalls[0].context, 'backup-export');
  assert.equal(result.incomplete, true);
});

test('importBackup：opaqueRaw 条目原样写回（不 parse），并汇报抢救数量', async () => {
  const storage = new Map();
  const files = new Map();
  const backup = loadBackup({ storage, files });
  const result = await backup.importBackup(payload([
    { key: '@easychat2_good', value: { ok: true } },
    { key: '@easychat2_broken', opaqueRaw: '{ not valid json' },
  ]), 'merge');
  // 正常键仍走 JSON.stringify
  assert.equal(storage.get('@easychat2_good'), JSON.stringify({ ok: true }));
  // 损坏键原样写回，未被再次 stringify
  assert.equal(storage.get('@easychat2_broken'), '{ not valid json');
  assert.equal(result.opaqueCount, 1);
});

test('importBackup：不含 opaqueRaw 的旧备份照常导入', async () => {
  const storage = new Map();
  const files = new Map();
  const backup = loadBackup({ storage, files });
  const result = await backup.importBackup(payload([
    { key: '@easychat2_old', value: { legacy: true } },
  ]), 'merge');
  assert.equal(storage.get('@easychat2_old'), JSON.stringify({ legacy: true }));
  assert.equal(result.opaqueCount, 0);
});
