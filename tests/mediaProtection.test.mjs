import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getMediaWriteRevision,
  getNextRecentMediaExpiry,
  isMediaWriteRevisionCurrent,
  isRecentMediaUri,
  markMediaWrite,
} from '../src/mediaProtection.js';

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
