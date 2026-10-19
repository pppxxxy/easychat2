// SAF 备份搬运的**按字节**路径（真机 110MB 卡死那一条的修复）。
//
// 事故（用户 2026-10-18 真机日志）：
//   [backup-read] chunked 14 chunk(s)
//     .../easychat2-auto-backup-1792318177690.json size=114886950 elapsed=852442ms
// 14.2 分钟。同一窗口里 app.refreshSessions 记到 **15052ms**（阈值 120ms）。
// 瓶颈不是读文件：8MB 一片要 61 秒，说明主线程被别的活占着；而"整串搬运"必然
// 在 JS 堆里拼出一个 110MB 字符串，分配 + GC 全程压住主线程。
//
// 修法：SAF 搬运不需要"文本"这个中间态——源是 UTF-8 字节，目标也是。逐片
// readBytes → writeBytes，峰值内存 = 一片。
//
// 本文件测的是**行为**：真的会分片、真的按顺序、真的在失败时不留半个文件、
// 以及"没有 FileHandle 能力时如实退回老路径"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { copyFileBytes } from '../src/storage/backupRead.js';
import { createAutoBackupDeps, runAutoBackup } from '../src/backup/autoBackupRun.js';

// 假的 expo-file-system（只实现 FileHandle 那一层）：内存里存字节。
function makeFakeFs(files, { failAfterWrites = -1 } = {}) {
  const stats = { opens: 0, reads: 0, writes: 0, closed: 0 };
  class File {
    constructor(uri) { this.uri = String(uri); }

    get exists() { return Object.prototype.hasOwnProperty.call(files, this.uri); }

    get size() {
      const value = files[this.uri];
      return value ? value.length : 0;
    }

    open() {
      stats.opens += 1;
      const uri = this.uri;
      if (!files[uri]) files[uri] = Buffer.alloc(0);
      let offset = 0;
      const file = files[uri];
      return {
        readBytes(length) {
          stats.reads += 1;
          const slice = file.subarray(offset, offset + length);
          offset += slice.length;
          return new Uint8Array(slice);
        },
        writeBytes(bytes) {
          stats.writes += 1;
          if (failAfterWrites >= 0 && stats.writes > failAfterWrites) {
            throw new Error('disk full');
          }
          // 追加语义：模拟真实 FileHandle 的写入位置
          const current = files[uri];
          const merged = Buffer.concat([current, Buffer.from(bytes)]);
          files[uri] = merged;
        },
        close() { stats.closed += 1; },
      };
    }
  }
  return { File, stats };
}

const noYield = () => Promise.resolve();

test('按字节搬运：分片读写，内容逐字节一致', async () => {
  const payload = Buffer.from('{"schemaVersion":1,"note":"中文也要原样保留"}'.repeat(200), 'utf8');
  const files = { 'file:///app/src.json': payload };
  const fs = makeFakeFs(files);

  const result = await copyFileBytes({
    sourceUri: 'file:///app/src.json',
    targetUri: 'file:///saf/target.json',
    sourceFs: fs,
    targetFs: fs,
    chunkBytes: 64,
    yieldToEventLoop: noYield,
  });

  assert.equal(result.bytes, payload.length, '搬运字节数必须与源文件一致');
  // 假写的追加语义会把 target 初值带上，取尾部等长片段比对
  const written = files['file:///saf/target.json'].subarray(-payload.length);
  assert.deepEqual(written, payload, '逐字节必须完全一致（含多字节 UTF-8）');
  assert.ok(fs.stats.reads > 1, `必须真的分片读（实际 ${fs.stats.reads} 次）`);
  assert.equal(fs.stats.reads, fs.stats.writes, '每次读对应一次写');
  assert.equal(fs.stats.closed, 2, '两个句柄都必须关闭');
});

test('按字节搬运：不构造整串——峰值只由 chunkBytes 决定', async () => {
  // 8MB 源 + 1MB 片：读写次数应为 8 次。若实现"先整读再整写"，次数会是 2。
  const payload = Buffer.alloc(8 * 1024 * 1024, 7);
  const files = { 'file:///app/big.bin': payload };
  const fs = makeFakeFs(files);
  await copyFileBytes({
    sourceUri: 'file:///app/big.bin',
    targetUri: 'file:///saf/target.bin',
    sourceFs: fs,
    targetFs: fs,
    chunkBytes: 1024 * 1024,
    yieldToEventLoop: noYield,
  });
  assert.equal(fs.stats.reads, 8, `应为 8 片，实际 ${fs.stats.reads}`);
});

test('按字节搬运：中途失败要抛出，不假装成功', async () => {
  const payload = Buffer.alloc(1024, 1);
  const files = { 'file:///app/src.bin': payload };
  const fs = makeFakeFs(files, { failAfterWrites: 1 });
  await assert.rejects(
    () => copyFileBytes({
      sourceUri: 'file:///app/src.bin',
      targetUri: 'file:///saf/target.bin',
      sourceFs: fs,
      targetFs: fs,
      chunkBytes: 128,
      yieldToEventLoop: noYield,
    }),
    '写盘失败必须抛出让上层清理半个文件'
  );
  assert.equal(fs.stats.closed, 2, '失败路径也必须关闭句柄（否则泄漏 fd）');
});

test('按字节搬运：没有 FileHandle 能力时明确报错，不静默成功', async () => {
  await assert.rejects(
    () => copyFileBytes({
      sourceUri: 'a',
      targetUri: 'b',
      sourceFs: {},
      targetFs: {},
      yieldToEventLoop: noYield,
    }),
    '必须抛出而不是返回 0 字节'
  );
});

// ---- 接线：SAF 目标优先走字节路径，老构建才退回整串 ----

// targetScheme：SAF 目录创建出来的文件 URI 用什么 scheme。
// 真实的 SAF 目标**必然是 content://**（用户通过系统选择器授权）；file:// 只用于
// 验证「按字节路径」本身能工作。这个区分是本轮的关键——
// fef85db 没区分，于是在 content:// 上必然抛「cannot be used with content URIs」，
// SAF 自动备份从那时起 100% 失败。
function makeSafDeps({ withNextFs, targetScheme = 'content' }) {
  const calls = [];
  const files = { 'file:///app/src.json': Buffer.from('{"ok":true}', 'utf8') };
  const fs = withNextFs ? makeFakeFs(files) : null;
  const legacyFs = {
    documentDirectory: 'file:///app/',
    getInfoAsync: async () => ({ exists: true, size: 11 }),
    deleteAsync: async uri => { calls.push(['deleteFile', uri]); },
    readDirectoryAsync: async () => [],
    readAsStringAsync: async () => '{"ok":true}',
  };
  const adapter = {
    listChildren: async () => [],
    createFile: async (dir, name) => (targetScheme === 'content'
      ? `content://safe/target-${name}`
      : `file:///saf/target-${name}`),
    writeText: async (uri, text) => { calls.push(['writeSafText', uri, text]); },
    delete: async uri => { calls.push(['deleteSaf', uri]); },
  };
  const deps = createAutoBackupDeps({
    exportBackup: async opts => {
      calls.push(['export', opts.fileName]);
      return { uri: 'file:///app/src.json', bytes: 11, storageCount: 1, mediaCount: 0, incomplete: false };
    },
    getSettings: async () => ({ enabled: true, location: { kind: 'saf', uri: 'content://safe' } }),
    recordLastBackupAt: async () => { calls.push(['record']); },
    fileSystem: legacyFs,
    nextFs: fs ? { File: fs.File } : null,
    adapter,
  });
  return { deps, calls, files, fs };
}

// 关键回归：真实的 SAF 目标（content://）**必须**退回整串路径，而不是硬用 FileHandle。
// 这是 fef85db 的 bug：它对 content:// 调 targetFile.open()，Android 层直接抛
// "This method cannot be used with content URIs"，于是每次自动备份都失败，
// 用户以为有外部备份、实际一个都没有。
test('回归：SAF 目标是 content:// 时必须退回整串路径（FileHandle 不支持 content URI）', async () => {
  const { deps, calls } = makeSafDeps({ withNextFs: true, targetScheme: 'content' });
  const result = await runAutoBackup({
    settings: { enabled: true, location: { kind: 'saf', uri: 'content://safe' } },
    deps,
    now: 1700000000000,
  });
  assert.equal(result.ok, true, '备份必须成功（此前这里每次都在 File.open 处抛错）');
  assert.equal(result.target, 'saf');
  assert.ok(
    calls.some(c => c[0] === 'writeSafText'),
    'content:// 目标必须走整串写入，而不是 FileHandle（后者在 Android 上会抛异常）'
  );
});

test('接线：目标是 file:// 且有 FileHandle 时走字节路径', async () => {
  const { deps, calls } = makeSafDeps({ withNextFs: true, targetScheme: 'file' });
  const result = await runAutoBackup({
    settings: { enabled: true, location: { kind: 'saf', uri: 'content://safe' } },
    deps,
    now: 1700000000000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.target, 'saf');
  assert.ok(
    !calls.some(c => c[0] === 'writeSafText'),
    'file:// 目标且有 FileHandle 时**不得**走整串写入（那是 110MB→14 分钟的路径）'
  );
});

test('接线：老构建（无 FileHandle）如实退回整串路径，功能不丢', async () => {
  const { deps, calls } = makeSafDeps({ withNextFs: false });
  const result = await runAutoBackup({
    settings: { enabled: true, location: { kind: 'saf', uri: 'content://safe' } },
    deps,
    now: 1700000000000,
  });
  assert.equal(result.ok, true);
  assert.ok(
    calls.some(c => c[0] === 'writeSafText'),
    '没有 FileHandle 时必须退回老路径，而不是直接失败'
  );
});
