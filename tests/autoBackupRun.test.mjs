import test from 'node:test';
import assert from 'node:assert/strict';

import { runAutoBackup, runAutoBackupIfDue } from '../src/backup/autoBackupRun.js';
import { buildAutoBackupFileName } from '../src/backup/autoBackupPolicy.js';

const NOW = 1700000000000;
const KEEP = buildAutoBackupFileName(NOW);
const OLD = buildAutoBackupFileName(1000);
const APP_DIR = 'file:///app/auto-backups/';

function makeDeps() {
  const calls = [];
  const listed = [
    { name: OLD, uri: `${APP_DIR}${OLD}` },
    { name: KEEP, uri: `${APP_DIR}${KEEP}` },
    { name: 'easychat2-backup-manual.json', uri: `${APP_DIR}easychat2-backup-manual.json` },
  ];
  const deps = {
    getSettings: async () => ({ enabled: true, intervalMs: 86400000, location: { kind: 'app' } }),
    recordLastBackupAt: async at => { calls.push(['record', at]); },
    appDirectory: () => APP_DIR,
    exportBackup: async opts => {
      calls.push(['export', opts]);
      return { uri: `${APP_DIR}${opts.fileName}`, bytes: 123, storageCount: 2, mediaCount: 1, incomplete: false };
    },
    readTextFile: async uri => { calls.push(['read', uri]); return '{"schemaVersion":1}'; },
    deleteFile: async uri => { calls.push(['deleteFile', uri]); },
    listAppBackups: async () => { calls.push(['listApp']); return listed; },
    listSafFiles: async () => { calls.push(['listSaf']); return listed; },
    createSafFile: async (dir, name) => { calls.push(['createSaf', dir, name]); return `content://x/${name}`; },
    writeSafText: async (uri, text) => { calls.push(['writeSaf', uri, text]); },
    deleteSafFile: async uri => { calls.push(['deleteSaf', uri]); },
  };
  return { deps, calls };
}

test('未开启：直接跳过，不做任何导出', async () => {
  const { deps, calls } = makeDeps();
  const result = await runAutoBackup({ settings: { enabled: false }, deps, now: NOW });
  assert.deepEqual(result, { ok: false, skipped: 'disabled' });
  assert.equal(calls.length, 0);
});

test('应用私有目标：导出到 auto-backups/、只淘汰旧自动备份、记录时间', async () => {
  const { deps, calls } = makeDeps();
  const result = await runAutoBackup({ settings: { enabled: true, intervalMs: 86400000, location: { kind: 'app' } }, deps, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.target, 'app');
  assert.equal(result.fileName, KEEP);
  assert.equal(result.pruned, 1);
  const exportCall = calls.find(c => c[0] === 'export')[1];
  assert.equal(exportCall.directory, APP_DIR);
  assert.equal(exportCall.fileName, KEEP);
  const deleted = calls.filter(c => c[0] === 'deleteFile').map(c => c[1]);
  assert.deepEqual(deleted, [`${APP_DIR}${OLD}`]);
  assert.ok(!deleted.includes(`${APP_DIR}easychat2-backup-manual.json`));
  assert.ok(calls.some(c => c[0] === 'record' && c[1] === NOW));
});

test('SAF 目标：搬运到所选文件夹、删应用内临时文件、淘汰旧 SAF 备份、记录时间', async () => {
  const { deps, calls } = makeDeps();
  const result = await runAutoBackup({
    settings: { enabled: true, intervalMs: 86400000, location: { kind: 'saf', uri: 'content://tree/x', name: 'X' } },
    deps,
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.target, 'saf');
  assert.equal(result.uri, `content://x/${KEEP}`);
  assert.ok(calls.some(c => c[0] === 'read' && c[1] === `${APP_DIR}${KEEP}`));
  assert.ok(calls.some(c => c[0] === 'createSaf' && c[1] === 'content://tree/x'));
  assert.ok(calls.some(c => c[0] === 'writeSaf' && c[1] === `content://x/${KEEP}`));
  assert.ok(calls.some(c => c[0] === 'deleteFile' && c[1] === `${APP_DIR}${KEEP}`));
  assert.ok(calls.some(c => c[0] === 'deleteSaf' && c[1] === `${APP_DIR}${OLD}`));
  assert.ok(calls.some(c => c[0] === 'record' && c[1] === NOW));
});

test('SAF 写入失败：清掉半个 SAF 文件并抛出，不记录时间', async () => {
  const { deps, calls } = makeDeps();
  deps.writeSafText = async () => { throw new Error('boom'); };
  await assert.rejects(
    () => runAutoBackup({
      settings: { enabled: true, intervalMs: 86400000, location: { kind: 'saf', uri: 'content://tree/x', name: 'X' } },
      deps,
      now: NOW,
    }),
    /boom/
  );
  assert.ok(calls.some(c => c[0] === 'deleteSaf' && c[1] === `content://x/${KEEP}`));
  assert.ok(!calls.some(c => c[0] === 'record'));
});

test('runAutoBackupIfDue：未到期跳过；force 强制执行', async () => {
  const { deps } = makeDeps();
  deps.getSettings = async () => ({ enabled: true, intervalMs: 86400000, lastBackupAt: NOW - 1000, location: { kind: 'app' } });
  const notDue = await runAutoBackupIfDue({ deps, now: NOW });
  assert.deepEqual(notDue, { ok: false, skipped: 'not-due' });
  const forced = await runAutoBackupIfDue({ deps, now: NOW, force: true });
  assert.equal(forced.ok, true);
});
