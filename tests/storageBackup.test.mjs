import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

// 打包/校验层的**唯一权威**媒体目录白名单（dataBackup.js）。这里用真模块而不是手抄一份：
// 下面既断言 backup.js 导出的就是**这个对象**（re-export，不是副本），也用它当棘轮的基准。
import { BACKUP_MEDIA_DIRECTORIES as PACKABLE_MEDIA_DIRECTORIES } from '../src/storage/dataBackup.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const sourcePath = path.resolve('src/storage/backup.js');

function loadBackup({ storage, files, failSet = false, failMediaWrite = false, directories = {}, throwsOnRead = new Set(), recordDiagnosticCalls = [], secretValues = {}, failSecretWriteIds = new Set(), packableDirectories = null, multiRemoveCalls = [], makeDirectoryCalls = [], failGetInfoFor = new Set() }) {
  const fileSystem = {
    documentDirectory: 'file:///doc/',
    EncodingType: { Base64: 'base64' },
    async getInfoAsync(uri) {
      // 模拟「媒体文件不可访问」：真机上 getInfoAsync 会抛
      // "[expo-file-system] getInfoAsync failed for <uri>"，而它发生在快照阶段。
      if (failGetInfoFor.has(uri)) throw new Error(`[expo-file-system] getInfoAsync failed for ${uri}`);
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
    // 记录调用：expo-file-system 的 writeAsStringAsync **不会**自动建父目录，
    // 所以「写回媒体前先 makeDirectoryAsync」是必须被验证的行为，不能是空实现。
    async makeDirectoryAsync(uri, options) {
      makeDirectoryCalls.push({ uri, options });
    },
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
    async multiRemove(keys) { multiRemoveCalls.push([...keys]); keys.forEach(key => storage.delete(key)); },
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
    BACKUP_MODE_QUICK: 'quick',
    // 目录白名单直接用真模块那一份：backup.js 现在从 dataBackup.js 派生（re-export），
    // 桩里给别的数组就测不出「两边是同一个对象」了。
    BACKUP_MEDIA_DIRECTORIES: PACKABLE_MEDIA_DIRECTORIES,
    QUICK_MEDIA_DIRECTORIES: ['avatars', 'characters', 'chat-images', 'voice', 'stickers'],
    // 快速导出键判定：与真实实现同口径（角色/会话/消息/分支/记忆摘要）。
    isQuickExportKey: key => {
      const value = String(key || '');
      return value === '@easychat2_character_index'
        || value === '@easychat2_active_character'
        || value === '@easychat2_affinity'
        || value === '@easychat2_sessions'
        || value === '@easychat2_active_session'
        || value.startsWith('@easychat2_character_item::')
        || value.startsWith('@easychat2_messages::')
        || value.startsWith('@easychat2_session_summaries::')
        || value.startsWith('@easychat2_branch_index::');
    },
    scanSecretRefs: storage => {
      const keys = [];
      const ids = new Set();
      const visit = (value, found) => {
        if (typeof value === 'string') {
          if (value.startsWith('secure:v1:')) found.add(value.slice('secure:v1:'.length));
          return;
        }
        if (Array.isArray(value)) { value.forEach(item => visit(item, found)); return; }
        if (value && typeof value === 'object') Object.values(value).forEach(item => visit(item, found));
      };
      (Array.isArray(storage) ? storage : []).forEach(item => {
        if (!item || item.value === undefined) return;
        const found = new Set();
        visit(item.value, found);
        if (found.size > 0) {
          if (typeof item.key === 'string') keys.push(item.key);
          found.forEach(id => ids.add(id));
        }
      });
      return { keys, ids: [...ids] };
    },
    collectLockSecretIds: value => {
      const locks = value && typeof value === 'object' ? value.characterLocks : null;
      if (!locks || typeof locks !== 'object') return [];
      return Object.keys(locks).flatMap(id => [`character_lock_${id}`, `character_lock_hint_${id}`]);
    },
    // 默认桩原样透传。传了 packableDirectories 才模拟真实打包层的目录白名单过滤
    //（dataBackup.js 的 isAllowedMediaPath），用于验证「白名单一旦变窄 → 文件被丢掉」不再静默。
    buildBackupPayload: input => (packableDirectories
      ? {
        ...input,
        media: (input.media || []).filter(item => packableDirectories
          .some(directory => String(item.path).startsWith(`${directory}/`))),
      }
      : input),
    planBackupImport: (payload, mode) => ({
      valid: true,
      mode: mode === 'replace' ? 'replace' : 'merge',
      storage: payload.storage || [],
      media: payload.media || [],
      secrets: payload.secrets || [],
    }),
  };
  const secretStore = {
    async readSecureValue(id) { return secretValues[id] || ''; },
    async writeSecureValue(id, value) {
      if (failSecretWriteIds.has(id)) throw new Error('secret write failed');
      secretValues[id] = value;
    },
    async removeSecureValue(id) { delete secretValues[id]; },
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
    if (request.endsWith('/secretStore.js')) return secretStore;
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

test('importBackup：写回媒体前先建父目录（writeAsStringAsync 不会自动建目录）', async () => {
  // expo-file-system 的 writeAsStringAsync 在父目录不存在时**直接失败**，
  // 而备份里的媒体路径是 `avatars/x.jpg` 这种带子目录的相对路径（媒体目录可能被系统清空过）。
  // 所以写回前必须先 makeDirectoryAsync(parent, { intermediates: true })。
  // 此前测试桩把 makeDirectoryAsync 写成空实现，这条行为其实**从未被验证**。
  const storage = new Map();
  const files = new Map();
  const makeDirectoryCalls = [];
  const backup = loadBackup({ storage, files, makeDirectoryCalls });
  await backup.importBackup(payload([], [
    { path: 'avatars/c1.jpg', base64: 'AA==' },
    { path: 'voice/sub/deep.m4a', base64: 'BB==' },
  ]), 'merge');
  const created = makeDirectoryCalls.map(call => call.uri);
  assert.ok(
    created.includes('file:///doc/avatars/'),
    `写回 avatars/c1.jpg 前必须建 file:///doc/avatars/，实际建了：${JSON.stringify(created)}`,
  );
  assert.ok(
    created.includes('file:///doc/voice/sub/'),
    `多级子目录也要建，实际建了：${JSON.stringify(created)}`,
  );
  // intermediates 必须为 true：否则多级目录建不出来
  for (const call of makeDirectoryCalls) {
    assert.equal(call.options?.intermediates, true, `${call.uri} 未用 intermediates`);
  }
  // 目录先于文件写入（顺序断言：建目录必须发生在写文件之前）
  assert.equal(files.get('file:///doc/avatars/c1.jpg'), 'AA==');
});

test('importBackup：回滚媒体时同样先建父目录（旧文件被系统清空过也要能还原）', async () => {
  const storage = new Map();
  const files = new Map([['file:///doc/voice/old.m4a', 'OLD']]);
  const makeDirectoryCalls = [];
  const backup = loadBackup({ storage, files, failMediaWrite: true, makeDirectoryCalls });
  await assert.rejects(
    backup.importBackup(payload([], [{ path: 'voice/old.m4a', base64: 'NEW' }]), 'merge'),
    /media write failed/,
  );
  // 回滚把 OLD 写回原路径，同样需要父目录存在
  assert.ok(
    makeDirectoryCalls.some(call => call.uri === 'file:///doc/voice/'),
    `回滚也必须建父目录，实际建了：${JSON.stringify(makeDirectoryCalls.map(c => c.uri))}`,
  );
  assert.equal(files.get('file:///doc/voice/old.m4a'), 'OLD');
});

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

test('importBackup replace：不再先删后写（覆盖语义由 setItem 完成，没有「键全消失」窗口）', async () => {
  const storage = new Map([
    ['@easychat2_character_index', JSON.stringify(['old'])],
    ['@easychat2_keep', JSON.stringify({ keep: true })],
  ]);
  const files = new Map();
  const multiRemoveCalls = [];
  const backup = loadBackup({ storage, files, multiRemoveCalls });
  const result = await backup.importBackup(payload([
    { key: '@easychat2_character_index', value: ['new'] },
  ]), 'replace');
  assert.equal(result.mode, 'replace');
  // 破坏性阶段必须整段消失：storageKeys 与写回键集是同一个集合（见 backup.js 注释），
  // 先删只制造「全部键消失、尚未写回」的窗口——窗口内进程被杀，这些键就永久为空，
  // 而回滚只覆盖抛错、不覆盖进程死亡。
  assert.deepEqual(multiRemoveCalls, [], '覆盖恢复不得先删后写');
  assert.equal(storage.get('@easychat2_character_index'), JSON.stringify(['new']), '包内键以备份内容为准');
  // replace 的语义是「只替换备份管理范围内（= 包内）的数据」（需求 2.4），不是
  // 「清空本地多出的键」：后者会删掉新版本新增的键、让 App 不可用，故包外键保留。
  assert.equal(storage.get('@easychat2_keep'), JSON.stringify({ keep: true }), '包外的本机键保留');
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
  // ⚠️ 总条数不再是 1：成功侧现在也会留一条（`[backup] 媒体收集完成…`），
  // 目的是让用户能区分「0 个失败」与「根本没跑」——真机反馈：备份成功但日志空白，
  // 无法确认修复是否生效。所以改为按 kind 精确定位失败那条。
  const storageDiags = diagnosticCalls.filter(call => call.kind === 'storage');
  assert.equal(storageDiags.length, 1, '失败键必须留且只留一条 storage 诊断');
  assert.match(storageDiags[0].message, /@easychat2_dead/);
  assert.equal(storageDiags[0].context, 'backup-export');
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

test('exportBackup：快速导出仅含角色/会话键与角色聊天媒体', async () => {
  const storage = new Map([
    ['@easychat2_character_index', JSON.stringify(['c1'])],
    ['@easychat2_messages::s1', JSON.stringify([{ id: 'm1' }])],
    ['@easychat2_chat_options', JSON.stringify({ theme: 'dark' })],
    ['@easychat2_api_configs', JSON.stringify({ configs: [] })],
  ]);
  const files = new Map([['file:///doc/avatars/a.jpg', 'A'], ['file:///doc/music/m.mp3', 'M']]);
  const directories = {
    'file:///doc/avatars/': ['a.jpg'],
    'file:///doc/characters/': [],
    'file:///doc/chat-images/': [],
    'file:///doc/voice/': [],
    'file:///doc/stickers/': [],
  };
  const backup = loadBackup({ storage, files, directories });
  const result = await backup.exportBackup({ appVersion: 'test', mode: 'quick' });
  const keys = result.payload.storage.map(i => i.key).sort();
  assert.deepEqual(keys, ['@easychat2_character_index', '@easychat2_messages::s1']);
  assert.equal(result.mode, 'quick');
  assert.equal(result.payload.media.some(m => m.path.startsWith('avatars/')), true);
  assert.equal(result.payload.media.some(m => m.path.startsWith('music/')), false);
});

test('exportBackup：完整导出包含设置与音乐/书籍媒体', async () => {
  const storage = new Map([
    ['@easychat2_character_index', JSON.stringify(['c1'])],
    ['@easychat2_chat_options', JSON.stringify({ theme: 'dark' })],
  ]);
  const files = new Map([['file:///doc/music/m.mp3', 'M']]);
  const directories = {
    'file:///doc/music/': ['m.mp3'],
    'file:///doc/avatars/': [],
    'file:///doc/stickers/': [],
    'file:///doc/chat-images/': [],
    'file:///doc/voice/': [],
    'file:///doc/characters/': [],
    'file:///doc/card-forge/': [],
    'file:///doc/books/': [],
  };
  const backup = loadBackup({ storage, files, directories });
  const result = await backup.exportBackup({ appVersion: 'test' });
  assert.equal(result.payload.storage.some(i => i.key === '@easychat2_chat_options'), true);
  assert.equal(result.payload.media.some(m => m.path === 'music/m.mp3'), true);
  assert.equal(result.mode, 'full');
});

test('exportBackup：includeSecrets 收集安全存储密钥并导出引用它的键', async () => {
  const storage = new Map([
    ['@easychat2_character_index', JSON.stringify(['c1'])],
    ['@easychat2_api_configs', JSON.stringify({ configs: [{ id: 'a', apiKey: 'secure:v1:apiConfigs_a_apiKey' }] })],
    ['@easychat2_security', JSON.stringify({ characterLocks: { c1: true } })],
  ]);
  const files = new Map();
  const directories = {};
  const secretValues = { apiConfigs_a_apiKey: 'sk-real', character_lock_c1: '1234', character_lock_hint_c1: '生日' };
  const backup = loadBackup({ storage, files, directories, secretValues });
  const result = await backup.exportBackup({ appVersion: 'test', mode: 'quick', includeSecrets: true });
  // 快速模式本不含 api_configs/security，但含密钥时须把引用它的键一并导出，避免密钥成孤儿
  const keys = result.payload.storage.map(i => i.key);
  assert.ok(keys.includes('@easychat2_api_configs'));
  assert.ok(keys.includes('@easychat2_security'));
  assert.equal(result.secretsCount, 3);
  assert.deepEqual(
    result.payload.secrets.map(s => s.id).sort(),
    ['apiConfigs_a_apiKey', 'character_lock_c1', 'character_lock_hint_c1']
  );
});

test('importBackup：回填密钥到安全存储并汇报数量', async () => {
  const storage = new Map();
  const files = new Map();
  const secretValues = {};
  const backup = loadBackup({ storage, files, secretValues });
  const result = await backup.importBackup({
    schemaVersion: 1,
    storage: [{ key: '@easychat2_api_configs', value: { configs: [{ apiKey: 'secure:v1:id1' }] } }],
    media: [],
    secrets: [{ id: 'id1', value: 'sk-real' }],
  }, 'merge');
  assert.equal(result.secretsCount, 1);
  assert.equal(secretValues.id1, 'sk-real');
  assert.equal(storage.get('@easychat2_api_configs'), JSON.stringify({ configs: [{ apiKey: 'secure:v1:id1' }] }));
});

test('importBackup：快照阶段失败 = 零副作用（密钥不得先写进保险箱）', async () => {
  // 真 bug（本次修复）：storage/media 快照原先在**密钥写回之后**、且在 try 之外取。
  // 于是 snapshotMediaFiles 抛错（实测 getInfoAsync 对不可访问的媒体文件会抛
  // "[expo-file-system] getInfoAsync failed"）时，密钥**已经写进保险箱**，而数据一个字节
  // 没恢复、catch 也没进去 ⇒ 密钥不回滚。用户看到「导入失败」，但 API Key 已被备份包里的
  // 值悄悄顶掉——界面看着没变，请求却开始 401（正是 backup.js 注释里点名的错配）。
  //
  // 修法：三个快照全部前置到任何写入之前（读全 → 写全）。快照失败 = 零副作用。
  const storage = new Map();
  const files = new Map();
  const secretValues = { id1: 'sk-OLD' };
  const backup = loadBackup({
    storage,
    files,
    secretValues,
    failGetInfoFor: new Set(['file:///doc/avatars/c1.jpg']),
  });
  await assert.rejects(
    backup.importBackup({
      schemaVersion: 1,
      storage: [{ key: '@easychat2_api_configs', value: { configs: [{ apiKey: 'secure:v1:id1' }] } }],
      media: [{ path: 'avatars/c1.jpg', base64: 'AA==' }],
      secrets: [{ id: 'id1', value: 'sk-NEW' }],
    }, 'merge'),
    /getInfoAsync failed/,
  );
  // 核心断言：快照失败时保险箱必须**一个字节都没动**
  assert.equal(secretValues.id1, 'sk-OLD', '快照失败时密钥不得被提前写回（否则会留下错配的保险箱）');
  // 数据侧同样零副作用
  assert.equal(storage.has('@easychat2_api_configs'), false, '快照失败时不得写入任何数据键');
});

test('importBackup：数据写入失败时，已写回的密钥也要回滚（不留错配的保险箱）', async () => {
  const storage = new Map();
  const files = new Map();
  // id1 原来有旧值（导入会把它顶掉），id2 原来不存在（导入会新建）。
  const secretValues = { id1: 'sk-OLD' };
  const backup = loadBackup({ storage, files, secretValues, failSet: true });
  await assert.rejects(
    backup.importBackup({
      schemaVersion: 1,
      storage: [{ key: '@easychat2_api_configs', value: { configs: [{ apiKey: 'secure:v1:id1' }] } }],
      media: [],
      secrets: [{ id: 'id1', value: 'sk-NEW' }, { id: 'id2', value: 'sk-ADDED' }],
    }, 'merge'),
    /storage write failed/
  );
  // 关键：数据回滚了，保险箱也必须回到导入前的样子——否则界面看着正常、请求却 401。
  assert.equal(secretValues.id1, 'sk-OLD', '原有密钥必须还原为旧值');
  assert.equal('id2' in secretValues, false, '导入新建的密钥必须删除（原本不存在）');
});

test('importBackup：单条密钥写失败只计数、不阻断数据恢复，且如实回报 secretsFailed', async () => {
  const storage = new Map();
  const files = new Map();
  const secretValues = {};
  const backup = loadBackup({
    storage, files, secretValues, failSecretWriteIds: new Set(['id1']),
  });
  const result = await backup.importBackup({
    schemaVersion: 1,
    storage: [{ key: '@easychat2_api_configs', value: { configs: [{ apiKey: 'secure:v1:id2' }] } }],
    media: [],
    secrets: [{ id: 'id1', value: 'sk-BAD' }, { id: 'id2', value: 'sk-OK' }],
  }, 'merge');
  assert.equal(result.secretsCount, 1, '成功的计入 secretsCount');
  assert.equal(result.secretsFailed, 1, '失败的必须回报（界面据此提示「部分密钥未恢复」）');
  assert.equal(secretValues.id2, 'sk-OK');
  assert.equal('id1' in secretValues, false);
  assert.equal(storage.has('@easychat2_api_configs'), true, '密钥写失败不得阻断数据恢复');
});

// ---- 媒体目录清单的单一事实源（2026-10-12 建立，2026-10 修 P0 后收紧为「同一份」）----
// 背景：清单此前手写在 exportBackup 的 for 循环里，而**打包层还有第二道白名单**
//（dataBackup.js 的 BACKUP_MEDIA_DIRECTORIES，恢复侧校验也用它）。两处漂移时，收集到的
// 文件会在 buildBackupPayload 里被静默丢掉——用户的音乐库与书籍只有恢复时才发现没进备份，
// 且恢复侧还会拒收含这些路径的包（不可逆）。本批把两份清单合一：backup.js 只 re-export
// dataBackup.js 那一份。下面这组断言把「清单 ⊇ 所有已注册媒体目录」「缺口为空集」
// 「两份是同一个对象」都钉在门禁上。

// 从产出方源码里取目录常量（books/music/localModel/screenWatch 都要 expo 模块，Node 里
// 直接 import 会炸；仓库既有的源码钉桩范式就是读源码）。
function constantIn(file, name) {
  const source = fs.readFileSync(path.resolve(file), 'utf8');
  const match = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*'([^']+)'`).exec(source);
  assert.ok(match, `${file} 里找不到常量 ${name}（常量被改名/搬走时，备份清单也要跟着走）`);
  return match[1];
}

// 扫 `${FileSystem.documentDirectory || ''}NAME/` 这一种形状的字面量目录（常量间接的由上面
// 的常量表覆盖）。新增媒体目录若写成这种形状而没登记，下面的断言会直接变红。
function scanLiteralMediaDirs() {
  const re = /`\$\{FileSystem\.documentDirectory\s*(?:\|\|\s*''\s*)?\}([A-Za-z0-9][A-Za-z0-9_-]*)\//g;
  const found = new Set();
  const walk = dir => {
    for (const entry of fs.readdirSync(path.resolve(dir), { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(path.resolve(full), 'utf8');
        let match;
        const matcher = new RegExp(re.source, 'g');
        while ((match = matcher.exec(source))) found.add(match[1]);
      }
    }
  };
  walk('src');
  return found;
}

test('导出侧媒体清单：覆盖所有已注册的媒体目录（常量产出的）', () => {
  const backup = loadBackup({ storage: new Map(), files: new Map() });
  const list = [...backup.BACKUP_MEDIA_DIRECTORIES];
  const owners = [
    { file: 'src/cardForge/mediaPaths.js', constant: 'AVATAR_DIRECTORY' },
    { file: 'src/cardForge/mediaPaths.js', constant: 'FORGE_MEDIA_DIRECTORY' },
    { file: 'src/books/library.js', constant: 'BOOKS_DIR_NAME' },
    { file: 'src/music/library.js', constant: 'MUSIC_DIR_NAME' },
    // characters 曾被当成「历史遗留、已无写入方」而差点被删掉——实际写入方在
    // storage/characters/payload.js：正文超过 512KB 的角色卡**只**把正文写进这个目录
    //（writeCharacterPayload），删掉它等于让大角色卡正文永远进不了备份。这条断言把它钉住。
    { file: 'src/storage/characters/payload.js', constant: 'CHARACTER_PAYLOAD_DIRECTORY' },
  ];
  for (const owner of owners) {
    const dir = constantIn(owner.file, owner.constant);
    assert.ok(list.includes(dir), `${owner.file} 的 ${owner.constant}（${dir}）必须登记进 BACKUP_MEDIA_DIRECTORIES`);
  }
  // 刻意不登记的目录：必须在清单外，且理由写在 dataBackup.js 的清单注释里
  const excluded = [
    { file: 'src/screenWatch/capture.js', constant: 'SCREEN_WATCH_DIR_NAME', why: '临时截图（滚动清扫）' },
    { file: 'src/localModel/modelManager.js', constant: 'LOCAL_MODEL_DIRECTORY', why: '模型权重可重新下载' },
    { file: 'src/chat/compaction.js', constant: 'COMPACTION_TRANSCRIPT_DIR', why: '会话压缩归档是可由会话重建的中间产物' },
  ];
  for (const owner of excluded) {
    const dir = constantIn(owner.file, owner.constant);
    assert.equal(list.includes(dir), false, `${dir} 不入备份（${owner.why}），不得登记`);
  }
  // workspace/ 的根目录名没有导出常量（`${base}workspace/`，见 workspace/native.js），
  // 只能直接钉字面量：它同样属于刻意排除项（体积可达 GB，是否入备份属产品决策）。
  assert.equal(list.includes('workspace'), false, 'workspace/ 不入备份（体积可达 GB，属产品决策）');
});

test('导出侧媒体清单：字面量写出的目录也必须有归属（登记或写明理由）', () => {
  const backup = loadBackup({ storage: new Map(), files: new Map() });
  const list = [...backup.BACKUP_MEDIA_DIRECTORIES];
  // 例外表（目前**空**）：加进来之前先想清楚——这是在把用户内容排除在备份外。
  // 2026-10 修 P0 前这里挂着 'chat-videos'（理由是「打包白名单还没有它」），那正是本次要
  // 消灭的漂移：现在两份清单合一，chat-videos/ 已登记，聊天视频随备份走。
  const NOT_BACKED_UP = {};
  for (const dir of scanLiteralMediaDirs()) {
    assert.ok(
      list.includes(dir) || NOT_BACKED_UP[dir],
      `${dir}/ 有写入方却不在 BACKUP_MEDIA_DIRECTORIES 里：要么登记（用户内容要能备份），`
      + '要么在 NOT_BACKED_UP 里写明理由（并同步 dataBackup.js 的清单注释）',
    );
  }
  assert.ok(
    list.includes('avatars') && list.includes('chat-images') && list.includes('voice')
      && list.includes('stickers') && list.includes('chat-videos'),
    '字面量扫描出的核心目录都必须在清单里',
  );
});

// 棘轮：导出清单与打包层白名单（dataBackup.js）之间**不许再有缺口**。
// 2026-10 修 P0 之前缺口是 {music, books}：文件在导出侧被收集，却在打包时被
// isAllowedMediaPath 静默丢掉——用户只有恢复时才发现音乐库与书籍没进备份（不可逆），
// 而恢复侧还用同一份窄白名单**拒收**含这些路径的包。清单合一后缺口收紧成**空集**，只许保持为空。
test('导出清单 vs 打包白名单：缺口必须是空集（只许收窄）', () => {
  const backup = loadBackup({ storage: new Map(), files: new Map() });
  const list = [...backup.BACKUP_MEDIA_DIRECTORIES];
  const gap = list.filter(dir => !PACKABLE_MEDIA_DIRECTORIES.includes(dir));
  assert.deepEqual(gap, [],
    '导出清单里有目录不在打包白名单（dataBackup.js）里：文件会被静默丢掉。'
    + '清单只能有一份——把目录加到 dataBackup.js 的 BACKUP_MEDIA_DIRECTORIES，而不是只加到导出侧。');
  // 打包白名单里的目录必须都真的会被收集（否则「允许导入」却永远导不出）
  for (const dir of PACKABLE_MEDIA_DIRECTORIES) {
    assert.ok(list.includes(dir), `${dir}/ 在打包白名单里但导出侧从不收集，两边口径不一致`);
  }
});

// 结构断言：两份清单是**同一份**（backup.js 只 re-export dataBackup.js 的常量）。
// 这条比「内容相等」更强：将来有人再手抄第二份数组，即使内容一时相同也会立刻变红。
test('两份清单是同一份：backup.js 只 re-export，不再维护第二份字面量数组', () => {
  const backup = loadBackup({ storage: new Map(), files: new Map() });
  assert.equal(backup.BACKUP_MEDIA_DIRECTORIES, PACKABLE_MEDIA_DIRECTORIES,
    'backup.js 导出的必须是 dataBackup.js 的**同一个对象**（re-export），不是副本或内容相同的第二份');
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.match(source, /export\s*\{\s*BACKUP_MEDIA_DIRECTORIES\s*\}/,
    'backup.js 必须以 re-export 的形式派生清单（export { BACKUP_MEDIA_DIRECTORIES }）');
  for (const dir of PACKABLE_MEDIA_DIRECTORIES) {
    assert.equal(source.includes(`'${dir}'`), false,
      `backup.js 里不该再出现目录名字面量 '${dir}'：清单只在 dataBackup.js 维护，这里必须派生`);
  }
});

test('打包层过滤掉的文件必须计入 unreadableMedia（不再静默丢失）', async () => {
  const storage = new Map([['@easychat2_a', JSON.stringify({ a: 1 })]]);
  const files = new Map([
    ['file:///doc/avatars/x.jpg', 'X'],
    ['file:///doc/music/song.mp3', 'M'],
  ]);
  const directories = {
    'file:///doc/avatars/': ['x.jpg'],
    'file:///doc/stickers/': [],
    'file:///doc/chat-images/': [],
    'file:///doc/voice/': [],
    'file:///doc/characters/': [],
    'file:///doc/card-forge/': [],
    'file:///doc/music/': ['song.mp3'],
    'file:///doc/books/': [],
  };
  // 这里**人为**把打包白名单调窄（模拟将来有人又拆出第二份清单）：music/ 会被过滤掉。
  // 真实白名单已与导出清单合一（见上面的棘轮测试），这道兜底仍要保证「丢文件」看得见。
  const backup = loadBackup({ storage, files, directories, packableDirectories: ['avatars', 'stickers', 'chat-images', 'voice', 'characters', 'card-forge'] });
  const result = await backup.exportBackup({ appVersion: 'test' });
  assert.equal(result.mediaCount, 2, '导出侧确实收集到了两个文件');
  assert.equal(result.payload.media.length, 1, '打包层只放行了一个');
  assert.deepEqual(result.unreadableMedia, ['music/song.mp3'], '被白名单丢掉的文件必须出现在 unreadableMedia 里');
  assert.equal(result.incomplete, true, '丢文件 = 备份不完整，必须告知用户');
});
