// P5：agent transcript 工具轨迹（提取 / 截断 / 展开 / 挂载）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  TOOL_TRACE_MAX_BYTES,
  TOOL_TRACE_TOOL_CONTENT_MAX,
  attachToolTrace,
  expandHistoryWithTraces,
  extractToolTrace,
  sanitizeTrace,
} from '../src/chat/toolTrace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USE_CHAT_SEND = readFileSync(path.join(HERE, '..', 'src', 'chat', 'useChatSend.js'), 'utf8');

test('extractToolTrace：保留 assistant(tool_calls)+tool，丢掉纯文本终稿', () => {
  const appended = [
    { role: 'assistant', content: '思考', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '结果正文' },
    { role: 'assistant', content: '最终回复' }, // 纯文本终稿（无 tool_calls）→ 丢掉
  ];
  const trace = extractToolTrace(appended);
  assert.equal(trace.length, 2);
  assert.equal(trace[0].role, 'assistant');
  assert.equal(trace[0].tool_calls[0].id, 'c1');
  assert.equal(trace[1].role, 'tool');
  assert.equal(trace[1].content, '结果正文');
  // 无工具调用 → null
  assert.equal(extractToolTrace([{ role: 'assistant', content: 'hi' }]), null);
  assert.equal(extractToolTrace(null), null);
});

test('extractToolTrace：随消息带下来的 isError 原样保留；老轨迹（无该字段）不带', () => {
  const trace = extractToolTrace([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '失败了', isError: true },
    { role: 'tool', tool_call_id: 'c2', content: '成功了', isError: false },
    { role: 'tool', tool_call_id: 'c3', content: '老轨迹没有这个字段' },
  ]);
  assert.equal(trace[1].isError, true, '权威失败标记保留');
  assert.equal(trace[2].isError, false, '权威成功标记也保留（可与「不知道」区分）');
  assert.equal('isError' in trace[3], false, '无该字段的老轨迹不带——展示层回落正文正则，不假装知道');
});

test('sanitizeTrace：逐条截断超大 tool 内容；总预算超限则整体丢弃', () => {
  const big = 'X'.repeat(50000);
  const out = sanitizeTrace([{ role: 'tool', tool_call_id: 'c1', content: big }]);
  assert.ok(out[0].content.length < big.length);
  assert.match(out[0].content, /轨迹截断/);
  assert.ok(out[0].content.length <= TOOL_TRACE_TOOL_CONTENT_MAX + 20);
  // 30 条 × 16KB = 480KB > 256KB → null（宁缺毋滥）
  const huge = Array.from({ length: 30 }, (_, i) => ({ role: 'tool', tool_call_id: `c${i}`, content: 'Y'.repeat(16000) }));
  assert.equal(sanitizeTrace(huge), null);
  assert.equal(sanitizeTrace([]), null);
  assert.ok(TOOL_TRACE_MAX_BYTES < 30 * 16000);
});

test('expandHistoryWithTraces：把 toolTrace 就地展开到消息之前', () => {
  const msgs = [
    { id: 'm1', role: 'user', text: 'hi' },
    { id: 'm2', role: 'assistant', text: 'done', toolTrace: [{ role: 'tool', tool_call_id: 'c1', content: 'r' }] },
  ];
  const out = expandHistoryWithTraces(msgs);
  assert.equal(out.length, 3);
  assert.equal(out[1].role, 'tool');
  assert.equal(out[2].id, 'm2');
  // 无轨迹原样返回
  const plain = [{ id: 'a', role: 'user', text: 'x' }];
  assert.deepEqual(expandHistoryWithTraces(plain), plain);
});

test('attachToolTrace：挂到首个助手正文分段；空轨迹/无分段不动', () => {
  const msgs = [
    { id: 'a1', role: 'assistant', text: 'hello' },
    { id: 'a2', role: 'assistant', text: '[[表情包:x]]', kind: 'sticker' },
  ];
  const replyParts = [{ id: 'a1', role: 'assistant', text: 'hello' }];
  const trace = [{ role: 'tool', tool_call_id: 'c1', content: 'r' }];
  const out = attachToolTrace(msgs, replyParts, trace);
  assert.equal(out[0].toolTrace.length, 1);
  assert.equal(out[1].toolTrace, undefined, '只挂首个正文分段');
  // 空轨迹 / 无正文分段 → 原样
  assert.equal(attachToolTrace(msgs, replyParts, []), msgs);
  assert.equal(attachToolTrace(msgs, [{ id: 'a2', kind: 'sticker' }], trace), msgs);
});

// D 线 5752f6d 只补了 agent 侧（中止时也发 transcript）。若宿主中止分支不挂轨迹，
// 「按了停止之后这一轮做过什么」照样查不到——这条守卫钉住宿主侧那一半。
test('宿主中止路径：先结算占位气泡，再把本轮工具轨迹挂上去', () => {
  assert.ok(
    USE_CHAT_SEND.includes('onTranscript: msgs => { turnTrace = extractToolTrace(msgs); }'),
    'agent 侧要把 transcript 收进 turnTrace'
  );
  const abortAt = USE_CHAT_SEND.indexOf("recordStats('');");
  assert.ok(abortAt > 0, '找不到中止分支（recordStats(\'\')）');
  const branch = USE_CHAT_SEND.slice(abortAt, abortAt + 1000);
  const settleAt = branch.indexOf('settlePendingMessage(current, pendingAssistantMessage.id');
  const attachAt = branch.indexOf('attachToolTrace(settled, [{ id: pendingAssistantMessage.id }], turnTrace)');
  assert.ok(settleAt >= 0, '中止分支应先结算占位气泡');
  assert.ok(attachAt >= 0, '中止分支必须把 turnTrace 挂到结算后的消息上');
  assert.ok(settleAt < attachAt, '顺序不能反：先结算（拿到最终消息列表）再挂轨迹');
});
