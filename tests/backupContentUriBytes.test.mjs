// SAF（content://）备份搬运：必须**按字节整块写**，绝不构造 115MB 字符串。
//
// 背景（用户真机反馈 2026-10-19）：
//   「手机一打开 easychat2 还是会马上发烫，然后有点卡，后台下载是什么东西？」
//   日志里出现 `backup-copy-bytes-skip`（上一批的临时热修）——那条路会把整个备份包
//   读成一个 JS 字符串再整串写回。真机实测 115MB 要 14 分钟，期间主线程被占满。
//
// 一手依据（都读过源码）：
//   · FileSystemPath.kt:65 —— content:// 上 javaFile 抛
//     "This method cannot be used with content URIs" ⇒ FileHandle 必然失败。
//   · FileWriteOptions 只有 encoding、没有 append；SAFDocumentFile.outputStream()
//     = contentResolver.openOutputStream(uri) 每次截断 ⇒ 无法分片追加。
//   · FileSystemFile.kt 的 write(ByteArray) 在 uri.isContentUri 时走 file.outputStream()
//     ⇒ **字节整块写是通的**。
//   ⇒ 唯一可行且高效的做法：分片读字节到预分配 Uint8Array，再单次 write(buffer)。
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
const READ_PATH = path.join(SRC, 'storage', 'backupRead.js');

// ---- 假的 expo-file-system（区分 file:// 与 content:// 的真实能力差异）----
//
// 关键：content:// 上 open() 必须**抛异常**（复现 "cannot be used with content URIs"），
// write(Uint8Array) 必须**成功**。替身只有如实模拟这两条，才能钉住"该走哪条路"。
function makeFakeFs(store) {
  const calls = { opens: 0, writes: 0, reads: 0 };
  class File {
    constructor(uri) { this.uri = String(uri); }

    get isContent() { return /^content:/i.test(this.uri); }

    get exists() { return Object.prototype.hasOwnProperty.call(store, this.uri); }

    get size() { return store[this.uri] ? store[this.uri].length : 0; }

    open() {
      if (this.isContent) {
        // 真实行为：content:// 不支持 FileHandle。
        throw new Error('This method cannot be used with content URIs: ' + this.uri);
      }
      calls.opens += 1;
      const buffer = store[this.uri];
      let offset = 0;
      return {
        readBytes(length) {
          calls.reads += 1;
          const slice = buffer.subarray(offset, offset + length);
          offset += slice.length;
          return new Uint8Array(slice);
        },
        writeBytes() { throw new Error('not used'); },
        close() {},
      };
    }

    // 真实行为：字节写入在 content:// 与 file:// 上都能用。
    write(content) {
      calls.writes += 1;
      store[this.uri] = Buffer.from(content);
    }
  }
  return { fs: { File }, calls };
}

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

function loadBackupRead() {
  const originalLoad = Module._load;
  const mainCode = compileToCjs(READ_PATH); // 必须装桩前转译（babel 会重入）
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
      return { __esModule: true, documentDirectory: 'file:///doc/' };
    }
    if (request === 'expo-sqlite') return { __esModule: true, openDatabaseSync: () => null };
    if (request.endsWith('/storage/diagnostics.js') || request === './diagnostics.js') {
      return { __esModule: true, recordDiagnostic: () => {} };
    }
    if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
      return { __esModule: true, tActive: key => String(key) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    for (const key of Object.keys(Module._cache)) {
      if (key.startsWith(`${SRC}${path.sep}`)) delete Module._cache[key];
    }
    const mod = new Module(READ_PATH);
    mod.filename = READ_PATH;
    mod.paths = Module._nodeModulePaths(path.dirname(READ_PATH));
    mod._compile(mainCode, READ_PATH);
    return mod.exports;
  } finally {
    Module._load = originalLoad;
  }
}

const noYield = () => Promise.resolve();
const CONTENT_URI = 'content://com.android.externalstorage.documents/tree/primary%3A%E6%88%91%E7%9A%84/document/primary%3Abackup.json';

test('content:// 目标：按字节整块写，内容逐字节一致', async () => {
  const payload = Buffer.from('{"schemaVersion":1,"note":"中文也要原样保留"}'.repeat(400), 'utf8');
  const store = { 'file:///app/tmp.json': payload };
  const { fs: fakeFs, calls } = makeFakeFs(store);
  const { copyFileBytesToContentUri } = loadBackupRead();

  const result = await copyFileBytesToContentUri({
    sourceUri: 'file:///app/tmp.json',
    targetUri: CONTENT_URI,
    sourceFs: fakeFs,
    targetFs: fakeFs,
    chunkBytes: 1024,
    yieldToEventLoop: noYield,
  });

  assert.equal(result.bytes, payload.length, '搬运字节数必须与源一致');
  assert.deepEqual(store[CONTENT_URI], payload, '逐字节必须一致（含多字节 UTF-8）');
  assert.ok(calls.reads > 1, `必须真的分片读（实际 ${calls.reads} 次）`);
  assert.equal(calls.writes, 1, 'content:// 无 append ⇒ 必须**单次**整块写');
});

test('content:// 目标：不得对目标调用 open()（真实会抛 cannot be used with content URIs）', async () => {
  const store = { 'file:///app/small.json': Buffer.from('abc', 'utf8') };
  const { fs: fakeFs } = makeFakeFs(store);
  const { copyFileBytesToContentUri } = loadBackupRead();
  // 替身的 File.open() 在 content:// 上抛错：若实现误用 FileHandle 就会失败。
  await copyFileBytesToContentUri({
    sourceUri: 'file:///app/small.json',
    targetUri: CONTENT_URI,
    sourceFs: fakeFs,
    targetFs: fakeFs,
    yieldToEventLoop: noYield,
  });
  assert.deepEqual(store[CONTENT_URI], Buffer.from('abc', 'utf8'), '小文件也要正确写入');
});

test('content:// 目标：源被截断时整包失败（绝不留半个备份）', async () => {
  const payload = Buffer.from('x'.repeat(4096), 'utf8');
  const store = { 'file:///app/trunc.json': payload };
  const { fs: fakeFs } = makeFakeFs(store);
  const { copyFileBytesToContentUri } = loadBackupRead();
  // 让 size 声称比实际可读的多：模拟源被截断。
  const lyingFs = {
    File: class extends fakeFs.File {
      get size() { return 8192; } // 声称 8KB
    },
  };
  await assert.rejects(
    () => copyFileBytesToContentUri({
      sourceUri: 'file:///app/trunc.json',
      targetUri: CONTENT_URI,
      sourceFs: lyingFs,
      targetFs: lyingFs,
      chunkBytes: 1024,
      yieldToEventLoop: noYield,
    }),
    '读到的比声明的少必须抛错（半个备份包比没有更糟）'
  );
  assert.equal(store[CONTENT_URI], undefined, '失败时不得留下目标文件');
});

test('content:// 目标：大小未知时明确拒绝（不猜、不读两遍）', async () => {
  const store = { 'file:///app/nosize.json': Buffer.from('abc', 'utf8') };
  const { fs: fakeFs } = makeFakeFs(store);
  const { copyFileBytesToContentUri } = loadBackupRead();
  const noSizeFs = {
    File: class extends fakeFs.File {
      get size() { return undefined; }
    },
  };
  await assert.rejects(
    () => copyFileBytesToContentUri({
      sourceUri: 'file:///app/nosize.json',
      targetUri: CONTENT_URI,
      sourceFs: noSizeFs,
      targetFs: noSizeFs,
      yieldToEventLoop: noYield,
    }),
    // 文案走 i18n key（tActive 在测试里是恒等桩），具体 reason 在参数里；
    // 这里只断言「明确拒绝」这件事成立，且目标没有被写。
    /error\.backup\.importReadFailed/
  );
  assert.equal(store[CONTENT_URI], undefined, '大小未知时不得写目标');
});

test('接线：copyToSaf 对 content:// 走字节整块路径（不再退回整串）', () => {
  const source = fs.readFileSync(path.join(SRC, 'backup', 'autoBackupRun.js'), 'utf8');
  assert.ok(source.includes('copyFileBytesToContentUri'), '必须引入 content:// 专用的字节搬运');
  assert.ok(
    /isContentUri\s*\?\s*copyFileBytesToContentUri\s*:\s*copyFileBytes/.test(source),
    '必须按目标 URI 形态选择搬运函数（content:// → 字节整块；file:// → 分片读写）'
  );
  // 旧的热修写法（content:// 直接 return null）不得回潮。
  assert.equal(
    /backup-copy-bytes-skip/.test(source),
    false,
    '不得再对 content:// 直接放弃（那会把 115MB 退回整串路径，实测 14 分钟）'
  );
});

test('接线：调度器启动时不立刻跑备份（延迟后才检查到期）', () => {
  const source = fs.readFileSync(path.join(SRC, 'backup', 'autoBackupScheduler.js'), 'utf8');
  assert.ok(
    /DEFAULT_AUTO_BACKUP_START_DELAY_MS/.test(source),
    '必须有启动延迟常量'
  );
  assert.ok(
    /setTimeout\(runDue,\s*startDelayMs\)/.test(source),
    '启动/回前台必须走延迟，而不是立刻 runDue()'
  );
  // `runDue();` 这种「挂载即跑」的裸调用不得存在。
  assert.equal(
    /^\s*runDue\(\);\s*$/m.test(source),
    false,
    '不得在启动路径上裸调 runDue()（那是「一打开就发烫」的直接来源）'
  );
});