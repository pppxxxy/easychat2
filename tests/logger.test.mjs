// 分级日志（Z 系采纳 #10）：级别过滤、debug 仅 dev、脱敏、sink 容错。纯函数直测。

import test from 'node:test';
import assert from 'node:assert/strict';

import { LOG_LEVELS, createLogger } from '../src/logging/logger.js';

function collector() {
  const entries = [];
  return { entries, sink: entry => entries.push(entry) };
}

// 本文件大部分用例验的是分级/格式化/容错，不是脱敏。logger 的脱敏是 fail-closed 的
// （不注入 redact 就省略文本，见下方「脱敏器不可用」用例），所以这些用例显式注入
// 一个透传 redact——这是**主动声明**「本用例不涉及脱敏」，而不是默认放行。
const passthrough = text => text;

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
  const log = createLogger({ scope: 'api', sink, dev: false, redact: passthrough });
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
  const log = createLogger({ scope: 'chat', consoleLike, dev: true, minLevel: 'debug', redact: passthrough });
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

// ---- 脱敏 fail-closed（回归：脱敏器不可用时曾回落原文）----
// 用明显的哨兵串：只要它出现在 sink / console 里，就是「写了原文」。
const SENTINEL = 'sk-SENTINEL-12345';

function assertNoSentinel(entries, lines) {
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message.includes(SENTINEL), false, 'sink 里不得出现原文');
  assert.ok(entries[0].message.length > 0, '应留占位符（省略 ≠ 静默留空）');
  assert.notEqual(entries[0].message, `失败 ${SENTINEL}`, '绝不能回落原文');
  lines.forEach(line => assert.equal(line.includes(SENTINEL), false, 'console 里不得出现原文'));
  // 注：detail 通道不在本批范围（logger.js 只对 message 调 redact）。实际影响有限——
  // 应用装配点 src/logging/index.js 的 appSink 只取 entry.message/entry.scope 落诊断，
  // detail 只出现在 dev console。这是同一族的独立缺口，已在交付报告里单列。
}

test('redact 未注入：省略文本而不是回落原文', () => {
  const { entries, sink } = collector();
  const lines = [];
  const consoleLike = { warn: text => lines.push(text), error: text => lines.push(text) };
  // 不传 redact（默认 null）——旧实现在这里 `String(text)` 直接把原文写下去。
  const log = createLogger({ scope: 's', sink, dev: false, consoleLike });
  log.error(`失败 ${SENTINEL}`);
  assertNoSentinel(entries, lines);
});

test('redact 抛错：同样 fail-closed，不落原文', () => {
  const { entries, sink } = collector();
  const log = createLogger({
    scope: 's',
    sink,
    dev: false,
    redact: () => { throw new Error('masker boom'); },
  });
  log.error(`失败 ${SENTINEL}`);
  assertNoSentinel(entries, []);
});

test('redact 返回非字符串：同样 fail-closed，不落原文', () => {
  const { entries, sink } = collector();
  const log = createLogger({ scope: 's', sink, dev: false, redact: () => null });
  log.error(`失败 ${SENTINEL}`);
  assertNoSentinel(entries, []);
});

test('redact 可用时仍按原样生效（fail-closed 不影响正常路径）', () => {
  const { entries, sink } = collector();
  const log = createLogger({
    scope: 's',
    sink,
    dev: false,
    redact: text => text.replace(/sk-SENTINEL-\d+/g, '[API_KEY已隐藏]'),
  });
  log.error(`失败 ${SENTINEL}`);
  assert.equal(entries[0].message, '失败 [API_KEY已隐藏]');
});
