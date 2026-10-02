import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/storage/backup.js');

function loadBackup({ storage, files, failSet = false, failMediaWrite = false, directories = {} }) {
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
      if (!storage.has(key)) return { status: 'missing' };
      try {
        return { status: 'ok', value: JSON.parse(storage.get(key)) };
      } catch (error) {
        return { status: 'corrupt' };
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
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') return asyncStorage;
    if (request === 'expo-file-system/legacy') return fileSystem;
    if (request.endsWith('/dataBackup.js')) return dataBackup;
    if (request.endsWith('/io.js')) return io;
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

test('exportBackup：损坏键与读不出的媒体计入 incomplete 并回传清单', async () => {
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
  assert.deepEqual(result.unreadableKeys, ['@easychat2_broken']);
  assert.deepEqual(result.unreadableMedia, ['avatars/bad.jpg']);
  assert.equal(result.storageCount, 1);
  assert.equal(result.mediaCount, 1);
});
