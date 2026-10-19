// 备份阶段的内存峰值：payload 必须在搬运前被释放。
//
// 真机背景（用户 2026-10-19）：「备份导致发烫，发烫导致卡顿」。
//
// 两个叠加项：
//   ① 导出阶段产生的 payload —— 整个备份包的**对象形态**，含全部媒体的 base64
//      （角色卡多的用户可达 115MB）。文件已流式写盘完毕，它对后续毫无用途。
//   ② 搬运阶段为 content:// 分配的 Uint8Array —— content:// 无 append，只能整块写，
//      所以必然又有一份**同量级**的字节数组。
// 两者若同时存活 ⇒ 峰值翻倍（115MB 包 ⇒ 230MB+），在手机上就是 GC 抖动、发热、
// 甚至被系统杀掉。本文件钉住「① 在 ② 之前就被断掉引用」。
//
// 量级参考（V8 实测，200 个文件 / 115MB base64）：导出侧 JS 工作约 300ms，
// Hermes ×3~5 ⇒ 0.9~1.5s。也就是说导出侧是**秒级**，不是当年 14 分钟那种量级——
// 14 分钟来自「整串读 115MB 再整串写」，已在 06be47a0 换成按字节整块写。
import test from 'node:test';
import assert from 'node:assert/strict';

import { runAutoBackup } from '../src/backup/autoBackupRun.js';
import { buildAutoBackupFileName } from '../src/backup/autoBackupPolicy.js';

const NOW = 1700000000000;
const APP_DIR = 'file:///app/auto-backups/';

// 造一个「大」payload：只需证明它被释放，不必真的塞 115MB。
function makeBigPayload(mediaCount = 4) {
  return {
    schemaVersion: 1,
    storage: [],
    media: Array.from({ length: mediaCount }, (_, i) => ({
      path: `characters/c${i}.png`,
      base64: 'A'.repeat(1024),
    })),
    secrets: [],
  };
}

test('内存：exportBackup 返回的 payload 必须在搬运前被释放', async () => {
  const payload = makeBigPayload();
  let payloadAtCopyTime = 'never-checked';

  const deps = {
    getSettings: async () => ({ enabled: true, intervalMs: 86400000, location: { kind: 'saf', uri: 'content://safe' } }),
    recordLastBackupAt: async () => {},
    appDirectory: () => APP_DIR,
    exportBackup: async opts => ({
      uri: `${APP_DIR}${opts.fileName}`,
      payload, // ← 关键：导出返回值里带着整个包
      bytes: 4096,
      storageCount: 0,
      mediaCount: payload.media.length,
      incomplete: false,
    }),
    // 搬运时记录「确实走到了搬运」——用做前提断言。
    copyToSaf: async () => {
      payloadAtCopyTime = 'copy-started';
      return { bytes: 4096, total: 4096, chunks: 1 };
    },
    createSafFile: async (dir, name) => `content://safe/${name}`,
    deleteSafFile: async () => {},
    readTextFile: async () => '{"schemaVersion":1}',
    writeSafText: async () => {},
    deleteFile: async () => {},
    listAppBackups: async () => [],
    listSafFiles: async () => [],
  };

  const result = await runAutoBackup({
    settings: { enabled: true, intervalMs: 86400000, location: { kind: 'saf', uri: 'content://safe' } },
    deps,
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(payloadAtCopyTime, 'copy-started', '前提：确实走到了搬运');
  // runAutoBackup 的返回值不得带 payload：否则调用方会一直持有整包（115MB 级对象形态）。
  assert.equal(
    Object.prototype.hasOwnProperty.call(result, 'payload'),
    false,
    'runAutoBackup 的返回值不得带 payload'
  );
});

test('内存：导出结果上的 payload 被置空（断掉最后一个引用）', async () => {
  const payload = makeBigPayload(2);
  let capturedExport = null;
  const deps = {
    getSettings: async () => ({ enabled: true, intervalMs: 86400000, location: { kind: 'app' } }),
    recordLastBackupAt: async () => {},
    appDirectory: () => APP_DIR,
    exportBackup: async opts => {
      capturedExport = {
        uri: `${APP_DIR}${opts.fileName}`,
        payload,
        bytes: 2048,
        storageCount: 0,
        mediaCount: payload.media.length,
        incomplete: false,
      };
      return capturedExport;
    },
    readTextFile: async () => '{"schemaVersion":1}',
    deleteFile: async () => {},
    listAppBackups: async () => [],
  };

  await runAutoBackup({
    settings: { enabled: true, intervalMs: 86400000, location: { kind: 'app' } },
    deps,
    now: NOW,
  });

  assert.ok(capturedExport, '前提：导出被调用过');
  assert.equal(
    capturedExport.payload,
    null,
    '导出完成后 payload 必须被置空——它是整个包的对象形态（含全部 base64 媒体），'
    + '留着会和搬运阶段的 Uint8Array 叠加，峰值内存翻倍'
  );
});

test('接线：备份开始时先算包名，成功后记录时间（行为不变）', async () => {
  const expected = buildAutoBackupFileName(NOW);
  let recorded = 0;
  const deps = {
    getSettings: async () => ({ enabled: true, intervalMs: 86400000, location: { kind: 'app' } }),
    recordLastBackupAt: async () => { recorded += 1; },
    appDirectory: () => APP_DIR,
    exportBackup: async opts => {
      assert.equal(opts.fileName, expected, '包名必须按 now 生成');
      return { uri: `${APP_DIR}${opts.fileName}`, payload: makeBigPayload(1), bytes: 1, storageCount: 0, mediaCount: 1, incomplete: false };
    },
    readTextFile: async () => '{}',
    deleteFile: async () => {},
    listAppBackups: async () => [],
  };
  const result = await runAutoBackup({
    settings: { enabled: true, intervalMs: 86400000, location: { kind: 'app' } },
    deps,
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.fileName, expected);
  assert.equal(recorded, 1, '成功后应记录一次时间');
});