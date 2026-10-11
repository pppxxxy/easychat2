import test from 'node:test';
import assert from 'node:assert/strict';

import { formatBytes, formatElapsed } from '../src/utils/format.js';
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

test('formatElapsed：m:ss 补零、进位到小时、非法值归零', () => {
  // 指令书给的三个样本
  assert.equal(formatElapsed(7 * 1000), '0:07');
  assert.equal(formatElapsed(83 * 1000), '1:23');
  assert.equal(formatElapsed(725 * 1000), '12:05');
  // 边界：不足一秒向下取整；59:59 不进位到小时
  assert.equal(formatElapsed(999), '0:00');
  assert.equal(formatElapsed(59 * 60 * 1000 + 59 * 1000), '59:59');
  // 满一小时进位成 h:mm:ss
  assert.equal(formatElapsed(3600 * 1000), '1:00:00');
  assert.equal(formatElapsed(3661 * 1000), '1:01:01');
  // 非法/空/负数一律 0:00（不要 NaN、不要负号）
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(-5), '0:00');
  assert.equal(formatElapsed(Number.NaN), '0:00');
  assert.equal(formatElapsed(Number.POSITIVE_INFINITY), '0:00');
  assert.equal(formatElapsed(undefined), '0:00');
  assert.equal(formatElapsed('abc'), '0:00');
  // 数字字符串按数字处理（事件/存储里常是字符串）
  assert.equal(formatElapsed('83000'), '1:23');
});
