import test from 'node:test';
import assert from 'node:assert/strict';

import { formatBytes } from '../src/utils/format.js';
import { formatBytes as fromModelLogs } from '../src/localModel/modelLogs.js';

test('formatBytes：边界与进位', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(-5), '');
  assert.equal(formatBytes(Number.NaN), '');
  assert.equal(formatBytes(512), '512B');
  assert.equal(formatBytes(1024), '1.0KB');
  assert.equal(formatBytes(1536), '1.5KB');
  assert.equal(formatBytes(10 * 1024), '10KB');
  assert.equal(formatBytes(1024 * 1024), '1.0MB');
  assert.equal(formatBytes(2.7 * 1024 * 1024 * 1024), '2.7GB');
});

test('formatBytes：modelLogs 的再导出与 utils 是同一实现（C5 合一）', () => {
  assert.equal(fromModelLogs, formatBytes);
});
