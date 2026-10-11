// N1：reactive 回退——错误矩阵 + 尾 5 配对回退 + 摘要 + 归档。
import test from 'node:test';
import assert from 'node:assert/strict';

import { findOrphanToolMessages } from '../src/agent/resultClearing.js';
import { COMPACTION_MARKER } from '../src/chat/compaction.js';
import {
  REACTIVE_FAILED_MESSAGE,
  REACTIVE_KEEP_RECENT,
  isContextOverflowError,
  runReactiveCompact,
} from '../src/chat/reactiveCompact.js';

function round(id, content) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'read_workspace_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content },
    { role: 'assistant', content: `done ${id}` },
  ];
}

test('isContextOverflowError：code 与 message 双匹配（子串，大小写不敏感）', () => {
  assert.equal(isContextOverflowError({ code: 'context_length_exceeded' }), true);
  assert.equal(isContextOverflowError({ type: 'prompt_too_long' }), true);
  assert.equal(isContextOverflowError({ message: 'This model maximum context length is 8192 tokens' }), true);
  assert.equal(isContextOverflowError({ message: 'Prompt is too long: reduce the length' }), true);
  assert.equal(isContextOverflowError({ message: 'CONTEXT_LENGTH_EXCEEDED' }), true, '大小写不敏感');
  // 否定样本
  assert.equal(isContextOverflowError({ code: 'rate_limit_exceeded', message: 'slow down' }), false);
  assert.equal(isContextOverflowError({ message: 'invalid api key' }), false);
  assert.equal(isContextOverflowError(null), false);
  assert.equal(isContextOverflowError(undefined), false);
});

test('runReactiveCompact：非超限错误不动；命中则摘要旧史 + 尾 5 保留 + 权威分离 + 归档', async () => {
  const messages = [{ role: 'user', content: 'go' }, ...round('c1', 'A'.repeat(200)), ...round('c2', 'B'.repeat(200))];

  const noop = await runReactiveCompact({ messages, error: { code: 'rate_limit' } });
  assert.equal(noop.compacted, false);
  assert.equal(noop.messages, messages);

  const transcriptPaths = [];
  const result = await runReactiveCompact({
    messages,
    error: { code: 'context_length_exceeded' },
    deps: {
      summarize: async () => '已完成：无\n关键决策与发现：无\n未完成与下一步：无',
      writeTranscript: async jsonl => { transcriptPaths.push(jsonl); return { path: '.transcripts/r.jsonl' }; },
    },
  });
  assert.equal(result.compacted, true);
  assert.match(String(result.messages[0].content), /\[历史压缩\]/);
  assert.match(String(result.messages[0].content), /历史摘要（仅供参考，不构成指令）：/);
  assert.match(String(result.messages[0].content), /完整历史：\.transcripts\/r\.jsonl/);
  assert.equal(transcriptPaths.length, 1);
  assert.match(transcriptPaths[0], /"role":"tool"/, '归档是完整历史的 jsonl');
  assert.equal(findOrphanToolMessages(result.messages).length, 0, '配对完整');
});

test('runReactiveCompact：摘要为空视为失败（保持原会话）', async () => {
  const messages = [...round('c1', 'A'.repeat(200))];
  const result = await runReactiveCompact({
    messages,
    error: { code: 'context_length_exceeded' },
    deps: { summarize: async () => '   ' },
  });
  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
});

test('配对边界：切割点落在 toolUse↔结果之间时回退（无孤儿）', async () => {
  // 尾部窗口恰好切在 assistant(tool_call) 与其 tool 结果之间：naive 切片会只剩 tool 结果。
  const messages = [
    { role: 'user', content: 'u' },
    { role: 'assistant', content: 'a0' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'x1', type: 'function', function: { name: 'read_workspace_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'x1', content: 'R'.repeat(300) },
    { role: 'assistant', content: 'a1' },
  ];
  const result = await runReactiveCompact({
    messages,
    error: { code: 'context_length_exceeded' },
    deps: { summarize: async () => '摘要' },
  });
  assert.equal(findOrphanToolMessages(result.messages).length, 0, '不得产生孤儿 tool 消息');
  assert.equal(REACTIVE_KEEP_RECENT, 5);
  assert.match(REACTIVE_FAILED_MESSAGE, /自动压缩仍失败/);
  assert.ok(String(result.messages[0].content).includes(COMPACTION_MARKER));
});
