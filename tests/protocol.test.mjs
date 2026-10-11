// Agent 事件协议：归一 / JSONL 往返 / 适配器（纯逻辑）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_EVENT,
  AGENT_EVENT_ARGS_MAX_CHARS,
  AGENT_PROTOCOL_VERSION,
  createProtocolEmitter,
  normalizeAgentEvent,
  parseAgentEvent,
  serializeAgentEvent,
} from '../src/agent/protocol.js';

test('normalizeAgentEvent：白名单字段 + 版本 + 不透传内部对象', () => {
  const text = normalizeAgentEvent(AGENT_EVENT.TEXT, { text: 'hi', secret: 'x' }, 111);
  assert.deepEqual(text, { v: 1, type: 'text', at: 111, text: 'hi' });
  assert.equal(text.secret, undefined, '内部字段不透传');

  const ts = normalizeAgentEvent(AGENT_EVENT.TOOL_START, { name: 'read', round: 2, args: { path: 'a' } }, 1);
  assert.deepEqual(ts, { v: 1, type: 'tool_start', at: 1, name: 'read', round: 2, args: { path: 'a' } });

  assert.equal(normalizeAgentEvent(AGENT_EVENT.TOOL_END, { name: 'read', round: 2 }, 1).ok, true);
  assert.equal(normalizeAgentEvent(AGENT_EVENT.TOOL_END, { name: 'read', ok: false }, 1).ok, false);

  const usage = normalizeAgentEvent(AGENT_EVENT.USAGE, { round: 1, promptTokens: 10, completionTokens: 2, cachedTokens: 5 }, 1);
  assert.equal(usage.promptTokens, 10);
  assert.equal(usage.cachedTokens, 5);

  assert.equal(normalizeAgentEvent(AGENT_EVENT.RUN_END, { text: 'done' }, 1).text, 'done');
  assert.equal(normalizeAgentEvent(AGENT_EVENT.RUN_START, { mode: 'read' }, 1).mode, 'read');
  assert.equal(AGENT_PROTOCOL_VERSION, 1);
});

test('serialize/parse：JSONL 往返；坏行 → null', () => {
  const event = normalizeAgentEvent(AGENT_EVENT.TEXT, { text: 'x' }, 5);
  assert.equal(parseAgentEvent(serializeAgentEvent(event)).text, 'x');
  assert.equal(parseAgentEvent('not json'), null);
  assert.equal(parseAgentEvent(''), null);
});

test('createProtocolEmitter：归一出口 + 回调抛错被吞 + 无回调不炸', () => {
  const seen = [];
  const emitter = createProtocolEmitter(event => seen.push(event));
  emitter.text('a');
  emitter.toolStart({ name: 'read', round: 1 });
  emitter.runEnd({ text: 'ok' });
  assert.deepEqual(seen.map(event => event.type), ['text', 'tool_start', 'run_end']);

  const thrower = createProtocolEmitter(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => thrower.text('x'));
  assert.doesNotThrow(() => createProtocolEmitter(null).text('x'));
});

// ---- P2 三处语义修正（2026-10-11 逐行审查）----

// 回归 P2：`at` 原先归一成 `int(at) || Date.now()`——`at = 0`（epoch 起点）是合法时间戳，
// 却被当 falsy 丢掉、回落到「现在」。回放/测试里传入 0 时，事件时间戳会整体变成当前时刻，
// 乱序与耗时统计因此失真。
test('回归 P2：at = 0 是合法时间戳，不得被当成缺失而回落到当前时间', () => {
  const zero = normalizeAgentEvent(AGENT_EVENT.TEXT, { text: 'x' }, 0);
  assert.equal(zero.at, 0, 'at = 0 必须原样保留');
  assert.equal(normalizeAgentEvent(AGENT_EVENT.TEXT, { text: 'x' }, 1234).at, 1234);
  assert.equal(normalizeAgentEvent(AGENT_EVENT.TEXT, { text: 'x' }, 12.7).at, 12, '向下取整');
  // 真正缺失/非法才回落（null 要显式判：Number(null) === 0，不能靠 Number 兜）
  const before = Date.now();
  for (const missing of [undefined, null, '', 'abc', Number.NaN]) {
    const at = normalizeAgentEvent(AGENT_EVENT.TEXT, { text: 'x' }, missing).at;
    assert.ok(Number.isFinite(at) && at >= before, `at=${String(missing)} 应回落到当前时间`);
  }
});

// 回归 P2：序列化失败原先返回 `''`——空串会被消费方当成「一条空事件」，
// 与「序列化失败」无法区分（而两者该被区别对待：前者跳过、后者报警）。
// 另外 JSON.stringify 对 undefined / 函数 / Symbol 返回 undefined（不抛），也必须按失败处理。
test('回归 P2：序列化失败返回 null（可与空事件区分），成功才返回字符串', () => {
  const event = normalizeAgentEvent(AGENT_EVENT.TEXT, { text: 'x' }, 5);
  assert.equal(typeof serializeAgentEvent(event), 'string');
  assert.equal(parseAgentEvent(serializeAgentEvent(event)).text, 'x', '正常路径仍是可解析的 JSONL');

  const circular = { v: 1, type: 'text', at: 1 };
  circular.self = circular;
  assert.equal(serializeAgentEvent(circular), null, '循环引用 → null（不是空串）');
  assert.equal(serializeAgentEvent(undefined), null, 'JSON.stringify(undefined) 返回 undefined → 也算失败');
  assert.equal(serializeAgentEvent(() => {}), null, '函数同样无法序列化');
  // 关键区分：null 与空事件不再混淆
  assert.notEqual(serializeAgentEvent(circular), '');
  assert.equal(parseAgentEvent(''), null, '空行解析仍是 null（消费方据此跳过）');
});

// 回归 P2：args 原先原样透传（`source.args == null ? null : source.args`），与文件头那句
// 「只放契约字段，绝不透传内部对象」矛盾——内部对象、函数、循环引用与超大载荷都会跟着出去。
// args 是模型给的、体量不可控（一次写文件能把整个文件内容塞进 args.content）。
test('回归 P2：args 只放纯数据、设有上限、超限退化为键名', () => {
  // 上限内：原值保留（消费方仍能看到「读的是哪个文件」）
  assert.deepEqual(
    normalizeAgentEvent(AGENT_EVENT.TOOL_START, { name: 'read', args: { path: 'a.js' } }, 1).args,
    { path: 'a.js' },
  );
  // 非对象 / 空：null（字符串/数字形态的参数没有契约意义）
  assert.equal(normalizeAgentEvent(AGENT_EVENT.TOOL_START, { name: 'read', args: 'a.js' }, 1).args, null);
  assert.equal(normalizeAgentEvent(AGENT_EVENT.TOOL_START, { name: 'read' }, 1).args, null);
  assert.equal(normalizeAgentEvent(AGENT_EVENT.TOOL_START, { name: 'read', args: null }, 1).args, null);
  // 内部对象不透传：函数被 JSON 往返剥掉（这正是「只放契约字段」的含义）
  const withFn = normalizeAgentEvent(AGENT_EVENT.TOOL_START, {
    name: 'write',
    args: { path: 'a.js', internal: () => 'secret', nested: { ok: true } },
  }, 1);
  assert.deepEqual(withFn.args, { path: 'a.js', nested: { ok: true } }, '函数字段必须被剥掉');
  assert.equal(typeof withFn.args.internal, 'undefined');
  // 超大载荷：退化为键名 + 体量，绝不把几 MB 塞进一条事件
  const huge = normalizeAgentEvent(AGENT_EVENT.TOOL_START, {
    name: 'write_workspace_file',
    args: { path: 'big.txt', content: 'x'.repeat(50 * 1024) },
  }, 1);
  assert.deepEqual(huge.args.keys, ['path', 'content']);
  assert.equal(huge.args.truncated, true);
  assert.ok(huge.args.originalChars > AGENT_EVENT_ARGS_MAX_CHARS);
  assert.ok(serializeAgentEvent(huge).length < AGENT_EVENT_ARGS_MAX_CHARS, '整条事件必须被压在上限附近');
  // 循环引用的 args：不抛、降级
  const circularArgs = { path: 'a.js' };
  circularArgs.self = circularArgs;
  const degraded = normalizeAgentEvent(AGENT_EVENT.TOOL_START, { name: 'read', args: circularArgs }, 1);
  assert.equal(degraded.args.truncated, true);
  assert.deepEqual(degraded.args.keys, ['path', 'self']);
  assert.doesNotThrow(() => serializeAgentEvent(degraded));
});

