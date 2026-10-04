import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getMediaWriteRevision,
  getNextRecentMediaExpiry,
  isMediaWriteRevisionCurrent,
  isRecentMediaUri,
  markMediaWrite,
} from '../src/storage/mediaProtection.js';

test('媒体写入 revision 与最近 URI 保护会更新', () => {
  const before = getMediaWriteRevision();
  const uri = 'file:///documents/chat-images/test-image.jpg';
  markMediaWrite(uri);
  assert.equal(isMediaWriteRevisionCurrent(before), false);
  assert.equal(isRecentMediaUri(uri), true);
});

test('最近写入 URI 会给出未来的过期时间用于回收重试', () => {
  const before = Date.now();
  const uri = 'file:///documents/chat-images/retry-image.jpg';
  markMediaWrite(uri);
  const expiry = getNextRecentMediaExpiry();
  assert.ok(expiry > before);
  assert.ok(expiry <= Date.now() + 10 * 60 * 1000 + 1000);
});

test('mtime 双保险：宽限窗内的文件跳过删除，宽限窗外允许删（冷启动竞态保护）', async () => {
  const { isRecentlyModifiedFile } = await import('../src/storage/mediaProtection.js');
  const now = Date.now();
  const mk = secs => `/documents/avatars/${secs}.jpg`;
  const fakeFs = {
    getInfoAsync: async uri => {
      const secs = Number(String(uri).match(/(\d+)\.jpg$/)[1]);
      return { exists: true, isDirectory: false, uri, modificationTime: secs };
    },
  };
  // legacy API 给的是秒级 modificationTime：1 分钟前=宽限窗内，11 分钟前=窗外
  const fresh = mk(Math.floor((now - 60_000) / 1000));
  const stale = mk(Math.floor((now - 11 * 60_000) / 1000));
  assert.equal(await isRecentlyModifiedFile(fresh, undefined, fakeFs), true, '宽限窗内 → 跳过删除');
  assert.equal(await isRecentlyModifiedFile(stale, undefined, fakeFs), false, '超出宽限窗 → 允许删除');
  assert.equal(await isRecentlyModifiedFile(stale, Number.POSITIVE_INFINITY, fakeFs), true, '显式不限龄 → 跳过');
  // 毫秒级时间戳兼容
  const fakeMs = { getInfoAsync: async uri => ({ exists: true, modificationTime: now - 60_000, uri }) };
  assert.equal(await isRecentlyModifiedFile('/x.jpg', undefined, fakeMs), true, '毫秒级 mtime 同样判定');
  // 文件不存在 → 允许删（没什么可保护）
  assert.equal(
    await isRecentlyModifiedFile('/missing.jpg', undefined, {
      getInfoAsync: async () => ({ exists: false }),
    }),
    false,
  );
  // 读取失败 → 宁可放过（fail-safe）
  assert.equal(
    await isRecentlyModifiedFile('/boom.jpg', undefined, {
      getInfoAsync: async () => { throw new Error('io error'); },
    }),
    true,
  );
});
