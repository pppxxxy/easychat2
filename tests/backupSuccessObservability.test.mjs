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

function loadBackup({ storage = new Map(), files = new Map(), directories = {}, throwsOnRead = new Set(), corruptRaw = new Map(), mediaThrowsFor = new Set(), recordDiagnosticCalls = [] } = {}) {
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
    async readAsStringAsync(uri) {
      if (mediaThrowsFor.has(uri)) throw new Error('read failed');
      return files.has(uri) ? files.get(uri) : '';
    },
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
          // corruptRaw：getItem 读得到原始串，但 JSON 解析不了 ⇒ 走 opaqueRaw 抢救。
          if (corruptRaw.has(key)) return { status: 'corrupt', raw: corruptRaw.get(key) };
          if (!storage.has(key)) return { status: 'missing' };
          // 保真：真实 readJsonStatus 对 parse 失败返回 { status:'corrupt', raw }，
          // 而不是把 SyntaxError 抛给调用方（io.js:343-353）。桩若直接抛，
          // 「真损坏仍计入 partialKeys」这条就永远测不到。
          const raw = storage.get(key);
          try {
            return { status: 'ok', value: JSON.parse(raw) };
          } catch (error) {
            return { status: 'corrupt', raw };
          }
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
      // 必须做插值：真实 tActive 会把 {keys}/{files} 换成实际值，桩只回键名的话
      // 「日志里有没有这个键名」这条断言就永远查不到东西（测了个假前提）。
      return {
        __esModule: true,
        tActive: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : String(key)),
      };
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

// ── 真机反馈（2026-10-20 二次）：日志里只出现了「媒体收集完成」，没有「导出成功」──
//
// 用户装的是含本批成功日志的包，媒体那一行出现了、存储那一行没出现。
// 根因不是「存储侧没跑」，而是当时写成 `if (有失败) … else if (无抢救) …`：
// **「有抢救、无失败」这一态两条都不进、一个字都不写。**
// 这正是最需要看见的一态：数据没丢（原始串已入包），但应用内读不出。
test('有抢救、无失败时：必须记「抢救」那条，且不得记成「成功」', async () => {
  // 键必须在 storage 里，否则 getAllKeys() 不会返回它、根本轮不到读（前提就假了）。
  const storage = new Map([
    ['@easychat2_good', JSON.stringify({ ok: true })],
    ['@easychat2_salvage', '{ not valid json'],
  ]);
  const calls = [];
  const backup = loadBackup({
    storage,
    directories: DIRECTORIES,
    corruptRaw: new Map([['@easychat2_salvage', '{ not valid json']]),
    recordDiagnosticCalls: calls,
  });
  const result = await backup.exportBackup({ appVersion: 'test' });

  assert.deepEqual(result.partialKeys, ['@easychat2_salvage'], '前提：本次有抢救');
  assert.deepEqual(result.unreadableKeys, [], '前提：本次零失败');

  const salvaged = calls.filter(call => /exportPartialSalvaged/.test(call.message));
  assert.equal(salvaged.length, 1, `抢救必须留痕，否则日志空白（实际 ${salvaged.length} 条）`);
  assert.match(salvaged[0].message, /@easychat2_salvage/, '要写清是哪个键');
  assert.equal(salvaged[0].kind, 'storage');

  const success = calls.filter(call => /导出成功/.test(call.message));
  assert.equal(success.length, 0, '有抢救就不能报「成功」——数据入包了但应用内读不出，不是全绿');
});

test('抢救与失败同时存在时：两条都要记，互不吞掉', async () => {
  const storage = new Map([
    ['@easychat2_good', JSON.stringify({ ok: true })],
    ['@easychat2_dead', JSON.stringify({ x: 1 })],
    ['@easychat2_salvage', '{ broken'],
  ]);
  const calls = [];
  const backup = loadBackup({
    storage,
    directories: DIRECTORIES,
    throwsOnRead: new Set(['@easychat2_dead']),
    corruptRaw: new Map([['@easychat2_salvage', '{ broken']]),
    recordDiagnosticCalls: calls,
  });
  await backup.exportBackup({ appVersion: 'test' });

  const storageCalls = calls.filter(call => call.kind === 'storage');
  assert.equal(storageCalls.length, 2, `失败 + 抢救各一条（实际 ${storageCalls.length} 条）`);
  assert.ok(storageCalls.some(call => /@easychat2_dead/.test(call.message)), '失败那条在');
  assert.ok(storageCalls.some(call => /@easychat2_salvage/.test(call.message)), '抢救那条在');
  assert.equal(calls.filter(call => /导出成功/.test(call.message)).length, 0);
});

test('抢救/媒体失败的词条：两种语言都要有，且不是同一句', () => {
  // 桩把 tActive 换成键名，所以上面只能断言「用了哪个键」；
  // 词条本身是否存在、两种语言是否都翻译了，在这里单独钉住
  //（i18nKeyAudit 只查代码引用的键是否存在，查不到「en 漏翻」）。
  const zh = fs.readFileSync(path.resolve('src/i18n/locales/zh-CN/error.js'), 'utf8');
  const en = fs.readFileSync(path.resolve('src/i18n/locales/en/error.js'), 'utf8');
  for (const key of ['exportPartialSalvaged', 'exportMediaUnreadable']) {
    assert.ok(zh.includes(`'error.backup.${key}'`), `zh-CN 缺 error.backup.${key}`);
    assert.ok(en.includes(`'error.backup.${key}'`), `en 缺 error.backup.${key}`);
  }
  // 抢救 ≠ 失败：两者性质不同（一个数据在包里、一个不在），文案不能混用同一句。
  const zhSalvaged = zh.match(/'error\.backup\.exportPartialSalvaged':\s*'([^']*)'/)[1];
  const zhUnreadable = zh.match(/'error\.backup\.exportUnreadable':\s*'([^']*)'/)[1];
  assert.notEqual(zhSalvaged, zhUnreadable, '抢救与失败必须是两句不同的话');
  assert.match(zhSalvaged, /抢救/, '抢救那条要说「抢救」，否则用户以为数据丢了');
});

test('媒体读取失败时：必须记失败那条（此前完全静默）', async () => {
  const storage = new Map([['@easychat2_good', JSON.stringify({ ok: true })]]);
  const calls = [];
  // 目录里列出了一个文件，但 readAsStringAsync 抛错 ⇒ 该文件进 unreadableMedia。
  const backup = loadBackup({
    storage,
    directories: { ...DIRECTORIES, 'file:///doc/avatars/': ['bad.png'] },
    mediaThrowsFor: new Set(['file:///doc/avatars/bad.png']),
    recordDiagnosticCalls: calls,
  });
  const result = await backup.exportBackup({ appVersion: 'test' });

  assert.deepEqual(result.unreadableMedia, ['avatars/bad.png'], '前提：媒体有失败');
  const mediaFailure = calls.filter(call => /媒体|bad\.png/.test(call.message) && call.kind === 'storage');
  assert.equal(mediaFailure.length, 1, `媒体失败必须留痕（实际 ${mediaFailure.length} 条）`);
  assert.match(mediaFailure[0].message, /avatars\/bad\.png/, '要写清是哪个文件');
  assert.equal(calls.filter(call => /媒体收集完成/.test(call.message)).length, 0, '不得同时报「无读取失败」');
});

test('成功日志带模式：自动备份与手动备份同段代码，不带模式分不出来', async () => {
  const storage = new Map([['@easychat2_good', JSON.stringify({ ok: true })]]);
  const calls = [];
  const backup = loadBackup({ storage, directories: DIRECTORIES, recordDiagnosticCalls: calls });
  await backup.exportBackup({ appVersion: 'test', mode: 'quick' });
  const success = calls.filter(call => /导出成功/.test(call.message));
  assert.equal(success.length, 1);
  assert.match(success[0].message, /快速/, '快速模式要写明');
});

// ── 裸文本键不是损坏 ────────────────────────────────────────────────────
//
// 真机日志（2026-10-20）：
//   `@easychat2_session_draft::session-muv4pyxs-g56ze6 结构损坏，已按原始串抢救入包`
//
// 那份草稿是**好的**。根因是导出侧对每个键无条件 JSON.parse，而草稿存的是
// `setItem(key, 用户手打原文)`（sessionMessages/drafts.js:49）。
// 于是草稿内容决定成败：`"好的"` 能 parse、`"他说：这样行吗？"` 抛错。
test('草稿键存的是裸文本：必须原样入包，且**不得**报成「结构损坏」', async () => {
  const DRAFT_KEY = '@easychat2_session_draft::session-mux';
  const DRAFT_TEXT = '他说：这样行吗？\n第二行';
  // 关键：原始串不是合法 JSON。旧实现会在 JSON.parse 抛错后把它当 corrupt。
  const storage = new Map([[DRAFT_KEY, DRAFT_TEXT]]);
  const calls = [];
  const backup = loadBackup({ storage, directories: DIRECTORIES, recordDiagnosticCalls: calls });
  const result = await backup.exportBackup({ appVersion: 'test' });

  assert.deepEqual(result.partialKeys, [], '草稿不是损坏，不得计入 partialKeys');
  assert.deepEqual(result.unreadableKeys, []);
  assert.equal(result.incomplete, false, '草稿正常时备份就是完整的');

  const entry = result.payload.storage.find(item => item.key === DRAFT_KEY);
  assert.equal(entry.opaqueRaw, DRAFT_TEXT, '必须逐字节原样入包');
  assert.equal(entry.value, undefined, '不得试图给出结构化 value');

  assert.equal(calls.filter(call => /exportPartialSalvaged/.test(call.message)).length, 0,
    '不得记「抢救」——它没坏');
  assert.equal(calls.filter(call => /导出成功/.test(call.message)).length, 1, '应当正常报成功');
});

test('草稿内容是合法 JSON 时也不得被 parse 改值（"1e5" 会变成 100000）', async () => {
  const DRAFT_KEY = '@easychat2_session_draft::session-mux';
  // `1e5` 是合法 JSON 数字 ⇒ 旧实现 JSON.parse 得 100000，
  // 恢复时 JSON.stringify(100000) 写回 "100000"：草稿被静默改写。
  const storage = new Map([[DRAFT_KEY, '1e5']]);
  const backup = loadBackup({ storage, directories: DIRECTORIES, recordDiagnosticCalls: [] });
  const result = await backup.exportBackup({ appVersion: 'test' });
  const entry = result.payload.storage.find(item => item.key === DRAFT_KEY);
  assert.equal(entry.opaqueRaw, '1e5', '草稿必须原样保留，不能被当成数字');
  assert.equal(entry.value, undefined);
});

test('裸文本键清单：开关类键也走原样入包，不报损坏', async () => {
  const storage = new Map([
    ['@easychat2_onboarding_done', 'true'],
    ['@easychat2_perf_probe', 'false'],
    ['@easychat2_disclaimer_ack', '3'],
  ]);
  const calls = [];
  const backup = loadBackup({ storage, directories: DIRECTORIES, recordDiagnosticCalls: calls });
  const result = await backup.exportBackup({ appVersion: 'test' });

  assert.deepEqual(result.partialKeys, [], '这些键本来就不是 JSON，不算损坏');
  assert.equal(result.incomplete, false);
  for (const [key, raw] of storage) {
    const entry = result.payload.storage.find(item => item.key === key);
    assert.equal(entry.opaqueRaw, raw, `${key} 必须原样入包`);
  }
});

test('真正损坏的 JSON 键仍然计入 partialKeys（不能因为放行裸文本就放过真损坏）', async () => {
  const storage = new Map([['@easychat2_sessions', '{ 这不是合法 JSON']]);
  const calls = [];
  const backup = loadBackup({ storage, directories: DIRECTORIES, recordDiagnosticCalls: calls });
  const result = await backup.exportBackup({ appVersion: 'test' });
  assert.deepEqual(result.partialKeys, ['@easychat2_sessions'], '真损坏仍要报');
  assert.equal(calls.filter(call => /exportPartialSalvaged/.test(call.message)).length, 1);
});