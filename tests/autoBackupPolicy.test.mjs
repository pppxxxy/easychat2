import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_BACKUP_FILE_PREFIX,
  AUTO_BACKUP_INTERVAL_PRESET_HOURS,
  AUTO_BACKUP_MAX_INTERVAL_MS,
  AUTO_BACKUP_MIN_INTERVAL_MS,
  DAY_MS,
  DEFAULT_AUTO_BACKUP_INTERVAL_MS,
  HOUR_MS,
  buildAutoBackupFileName,
  clampAutoBackupInterval,
  isAutoBackupDue,
  isAutoBackupFileName,
  isSafTreeUri,
  matchIntervalPresetHours,
  normalizeAutoBackupLocation,
  normalizeAutoBackupSettings,
  selectStaleAutoBackups,
} from '../src/backup/autoBackupPolicy.js';

test('normalizeAutoBackupSettings：缺省/非法输入回默认', () => {
  const s = normalizeAutoBackupSettings(null);
  assert.equal(s.enabled, false);
  assert.equal(s.onExit, false);
  assert.equal(s.intervalMs, DEFAULT_AUTO_BACKUP_INTERVAL_MS);
  assert.deepEqual(s.location, { kind: 'app', uri: '', name: '' });
  assert.equal(s.lastBackupAt, 0);
});

test('normalizeAutoBackupSettings：保留合法字段并夹取间隔', () => {
  const s = normalizeAutoBackupSettings({
    enabled: true,
    onExit: true,
    intervalMs: 6 * HOUR_MS,
    lastBackupAt: 12345,
    location: { kind: 'saf', uri: 'content://tree/primary%3ABackup', name: 'Backup' },
  });
  assert.equal(s.enabled, true);
  assert.equal(s.onExit, true);
  assert.equal(s.intervalMs, 6 * HOUR_MS);
  assert.equal(s.lastBackupAt, 12345);
  assert.equal(s.location.kind, 'saf');
  assert.equal(s.location.name, 'Backup');
  // 超范围被夹取。
  assert.equal(normalizeAutoBackupSettings({ intervalMs: 1 }).intervalMs, AUTO_BACKUP_MIN_INTERVAL_MS);
  assert.equal(normalizeAutoBackupSettings({ intervalMs: 999 * 24 * HOUR_MS }).intervalMs, AUTO_BACKUP_MAX_INTERVAL_MS);
  assert.equal(clampAutoBackupInterval(NaN), DEFAULT_AUTO_BACKUP_INTERVAL_MS);
});

test('normalizeAutoBackupLocation：非 content:// 一律回落到应用私有', () => {
  assert.deepEqual(normalizeAutoBackupLocation({ kind: 'saf', uri: 'file:///x', name: 'x' }), { kind: 'app', uri: '', name: '' });
  assert.deepEqual(normalizeAutoBackupLocation({ kind: 'saf', uri: '', name: 'x' }), { kind: 'app', uri: '', name: '' });
  assert.equal(isSafTreeUri('content://x'), true);
  assert.equal(isSafTreeUri('file:///x'), false);
});

test('isAutoBackupDue：未开启不到期；从未备份立即到期；按间隔判定', () => {
  const base = { enabled: true, intervalMs: DAY_MS, lastBackupAt: 0 };
  assert.equal(isAutoBackupDue({ ...base, enabled: false }, 10 ** 12), false);
  assert.equal(isAutoBackupDue(base, 10 ** 12), true);
  assert.equal(isAutoBackupDue({ ...base, lastBackupAt: 1000 }, 1000 + DAY_MS - 1), false);
  assert.equal(isAutoBackupDue({ ...base, lastBackupAt: 1000 }, 1000 + DAY_MS), true);
});

test('文件名：前缀+时间戳，且只有自动备份文件被识别', () => {
  const name = buildAutoBackupFileName(1700000000000);
  assert.equal(name, `${AUTO_BACKUP_FILE_PREFIX}1700000000000.json`);
  assert.equal(isAutoBackupFileName(name), true);
  assert.equal(isAutoBackupFileName('easychat2-backup-1700000000000.json'), false);
  assert.equal(isAutoBackupFileName('random.json'), false);
});

test('selectStaleAutoBackups：只选自动备份、排除要保留的、不动其它文件', () => {
  const keep = buildAutoBackupFileName(3000);
  const entries = [
    { name: buildAutoBackupFileName(1000), uri: 'u1' },
    { name: keep, uri: 'u2' },
    { name: buildAutoBackupFileName(2000), uri: 'u3' },
    { name: 'easychat2-backup-1.json', uri: 'manual' },
    { name: 'notes.txt', uri: 'u4' },
  ];
  const stale = selectStaleAutoBackups(entries, keep).map(e => e.name);
  assert.deepEqual(stale.sort(), [buildAutoBackupFileName(1000), buildAutoBackupFileName(2000)].sort());
  assert.deepEqual(selectStaleAutoBackups(null, keep), []);
});

test('matchIntervalPresetHours：命中预设返回小时数，否则 null', () => {
  assert.equal(matchIntervalPresetHours(24 * HOUR_MS), 24);
  assert.equal(matchIntervalPresetHours(6 * HOUR_MS), 6);
  assert.equal(matchIntervalPresetHours(5 * HOUR_MS), null);
  assert.ok(AUTO_BACKUP_INTERVAL_PRESET_HOURS.includes(168));
});
