import test from 'node:test';
import assert from 'node:assert/strict';

import { formatCurrentTime, buildTimeAwareText } from '../src/chat/currentTime.js';

test('formatCurrentTime：本地日期与星期', () => {
  const text = formatCurrentTime(new Date(2026, 8, 30, 15, 4));
  assert.equal(text, '2026-09-30 周三 15:04');
});

test('formatCurrentTime：个位月/日/时分补零', () => {
  assert.equal(formatCurrentTime(new Date(2026, 0, 5, 8, 7)), '2026-01-05 周一 08:07');
});

test('formatCurrentTime：非法日期返回空串', () => {
  assert.equal(formatCurrentTime(new Date('invalid')), '');
});

test('buildTimeAwareText：关闭或无有效时间返回空串', () => {
  assert.equal(buildTimeAwareText(false, new Date(2026, 8, 30, 15, 4)), '');
  assert.equal(buildTimeAwareText(true, new Date('invalid')), '');
});

test('buildTimeAwareText：开启时带 [当前时间] 前缀', () => {
  const text = buildTimeAwareText(true, new Date(2026, 8, 30, 15, 4));
  assert.equal(text, '[当前时间] 2026-09-30 周三 15:04');
});
