// 备份**成功**时也要留一条诊断。
//
// 真机反馈（2026-10-20）：用户手动备份成功、弹窗显示「已生成备份 191.99 MB」，
// 但诊断日志里一条记录都没有。于是无法确认：
//   · 是「135 个键全部读成功（0 个失败）」，还是
//   · 「备份根本没跑」。
//
// 这是个可观测性缺口：**只记录失败**会让「一切正常」与「什么都没发生」长得一模一样。
// 本次修法：成功路径各记一条（存储侧 + 媒体侧），失败路径仍记原有诊断，两者互斥不重复。
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

function loadBackup({ storage = new Map(), files = new Map(), directories = {}, throwsOnRead = new Set(), recordDiagnosticCalls = [] } = {}) {
  const fileSystem = {
    documentDirectory: 'file:///doc/',
    EncodingType: { Base64: 'base64' },
    File: class FakeFile {
      constructor(uri) { this.uri = String(uri); this.exists = false; }
      create() { this.exists = true; }
      open() { return { writeBytes() {}, close() {} }; }
      delete() { this.exists = false; }
    },
    async getInfoAsync(uri) { return { exists: files.has(uri), isDirectory: false }; },
    async readAsStringAsync(uri) { return files.has(uri) ? files.get(uri) : ''; },
    async readDirectoryAsync(uri) {
      const names = directories[uri];
      if (!names) throw new Error('no dir');
      return names;
    },
    async makeDirectoryAsync() {},
    async writeAsStringAsync(uri, value) { files.set(uri, value); },
    async deleteAsync(uri) { files.delete(uri); },
  };
  const asyncStorage = {
    async getItem(key) {
      if (throwsOnRead.has(key)) throw new Error('cursor window');
      return storage.has(key) ? storage.get(key) : null;
    },
    async setItem(key, value) { storage.set(key, value); },
    async removeItem(key) { storage.delete(key); },
    async multiRemove(keys) { (keys || []).forEach(k => storage.delete(k)); },
    async getAllKeys() { return [...storage.keys()]; },
  };
  const originalLoad = Module._load;
  const mainCode = compileToCjs(BACKUP_PATH);
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: asyncStorage };
    if (request === 'expo-file-system' || request === 'expo-file-system/legacy') return { __esModule: true, ...fileSystem };
    if (request.endsWith('/storage/diagnostics.js') || request === './diagnostics.js') {
      return { __esModule: true, recordDiagnostic: (...args) => recordDiagnosticCalls.push({ kind: args[0], message: String((args[1] && args[1].message) || args[1]), context: args[2] }) };
    }
    if (request.endsWith('/storage/io.js') || request === './io.js') {
      return {
        __esModule: true,
        readJsonStatus: async key => {
          if (throwsOnRead.has(key)) return { status: 'corrupt' };
          return storage.has(key) ? { status: 'ok', value: JSON.parse(storage.get(key)) } : { status: 'missing' };
        },
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

const DIRECTORIES = {
  'file:///doc/avatars/': [],
  'file:///doc/stickers/': [],
  'file:///doc/chat-images/': [],
  'file:///doc/voice/': [],
  'file:///doc/characters/': [],
  'file:///doc/card-forge/': [],
  'file:///doc/music/': [],
  'file:///doc/books/': [],
  'file:///doc/chat-videos/': [],
};

test('全部成功时：必须留一条「导出成功」诊断（否则无法区分 0 失败 与 没跑）', async () => {
  const storage = new Map([
    ['@easychat2_good', JSON.stringify({ ok: true })],
    ['@easychat2_also', JSON.stringify({ ok: 2 })],
  ]);
  const calls = [];
  const backup = loadBackup({ storage, directories: DIRECTORIES, recordDiagnosticCalls: calls });
  const result = await backup.exportBackup({ appVersion: 'test' });

  assert.equal(result.incomplete, false, '前提：本次零失败');
  assert.deepEqual(result.unreadableKeys, []);
  assert.deepEqual(result.unreadableMedia, []);

  const success = calls.filter(call => /导出成功/.test(call.message));
  assert.equal(success.length, 1, `零失败时必须留一条成功诊断（实际 ${success.length} 条）`);
  assert.equal(success[0].context, 'backup-export');
  assert.match(success[0].message, /2\/2 个数据键/, '要写清成功了多少个键');
});

test('全部成功时：媒体侧也要留一条（含文件数）', async () => {
  const storage = new Map([['@easychat2_good', JSON.stringify({ ok: true })]]);
  const files = new Map([['file:///doc/avatars/a.png', 'AAAA']]);
  const calls = [];
  const backup = loadBackup({
    storage,
    files,
    directories: { ...DIRECTORIES, 'file:///doc/avatars/': ['a.png'] },
    recordDiagnosticCalls: calls,
  });
  await backup.exportBackup({ appVersion: 'test' });

  const mediaSuccess = calls.filter(call => /媒体收集完成/.test(call.message));
  assert.equal(mediaSuccess.length, 1, '零失败时媒体侧也要留痕');
  assert.match(mediaSuccess[0].message, /1 个文件/, '要写清收集了多少个文件');
});

test('有失败时不记「成功」诊断（两者互斥，不重复刷日志）', async () => {
  const storage = new Map([
    ['@easychat2_good', JSON.stringify({ ok: true })],
    ['@easychat2_dead', JSON.stringify({ x: 1 })],
  ]);
  const calls = [];
  const backup = loadBackup({
    storage,
    directories: DIRECTORIES,
    throwsOnRead: new Set(['@easychat2_dead']),
    recordDiagnosticCalls: calls,
  });
  const result = await backup.exportBackup({ appVersion: 'test' });
  assert.equal(result.incomplete, true, '前提：本次有失败');
  const success = calls.filter(call => /导出成功/.test(call.message));
  assert.equal(success.length, 0, '有失败时不得再记「成功」，否则日志自相矛盾');
  const failure = calls.filter(call => call.kind === 'storage');
  assert.equal(failure.length, 1, '失败那条必须仍在');
});