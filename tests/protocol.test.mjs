// Agent 事件协议：归一 / JSONL 往返 / 适配器（纯逻辑）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_EVENT,
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
