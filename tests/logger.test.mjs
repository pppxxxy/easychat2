// 分级日志（Z 系采纳 #10）：级别过滤、debug 仅 dev、脱敏、sink 容错。纯函数直测。

import test from 'node:test';
import assert from 'node:assert/strict';

import { LOG_LEVELS, createLogger } from '../src/logging/logger.js';

function collector() {
  const entries = [];
  return { entries, sink: entry => entries.push(entry) };
}

test('级别过滤：低于 minLevel 的不记录', () => {
  const { entries, sink } = collector();
  const log = createLogger({ scope: 's', minLevel: 'warn', sink, dev: true });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.deepEqual(entries.map(e => e.level), ['warn', 'error']);
});

test('debug 只在 dev 生效，且永不落 sink', () => {
  const { entries, sink } = collector();
  const prod = createLogger({ scope: 's', minLevel: 'debug', sink, dev: false });
  prod.debug('hidden');
  assert.equal(entries.length, 0);
  const dev = createLogger({ scope: 's', minLevel: 'debug', sink, dev: true });
  dev.debug('shown');
  assert.equal(entries.length, 0, 'debug 不进 sink（纯诊断）');
});

test('sink 收到 level/scope/message/detail/at', () => {
  const { entries, sink } = collector();
  const log = createLogger({ scope: 'api', sink, dev: false });
  log.warn('请求失败', { code: 500 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 'warn');
  assert.equal(entries[0].scope, 'api');
  assert.equal(entries[0].message, '请求失败');
  assert.equal(entries[0].detail, '{"code":500}', 'sink 收到的是序列化后的 detail');
  assert.ok(entries[0].at > 0);
});

test('redact 应用到 message', () => {
  const { entries, sink } = collector();
  const log = createLogger({ scope: 's', sink, dev: false, redact: text => text.replace(/sk-\w+/g, '[KEY]') });
  log.error('失败 sk-abcdef123456');
  assert.equal(entries[0].message, '失败 [KEY]');
});

test('sink 抛错不影响主流程', () => {
  const log = createLogger({ scope: 's', sink: () => { throw new Error('sink boom'); }, dev: false });
  assert.doesNotThrow(() => log.error('x'));
});

test('consoleLike 收到带 scope 前缀的文本', () => {
  const lines = [];
  const consoleLike = { warn: text => lines.push(text), error: text => lines.push(text), info: text => lines.push(text), debug: text => lines.push(text) };
  const log = createLogger({ scope: 'chat', consoleLike, dev: true, minLevel: 'debug' });
  log.debug('x', { a: 1 });
  assert.equal(lines[0], '[chat] x {"a":1}');
});

test('Error 详情序列化为 message', () => {
  const { entries, sink } = collector();
  const log = createLogger({ scope: 's', sink, dev: false });
  log.error('oops', new Error('boom'));
  assert.equal(entries[0].detail, 'boom');
});

test('LOG_LEVELS 常量', () => {
  assert.deepEqual([...LOG_LEVELS], ['debug', 'info', 'warn', 'error']);
});
