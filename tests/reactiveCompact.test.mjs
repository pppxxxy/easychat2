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

// 回归 2026-10-11 审查 P1-2：本模块原先传 `{ toolTranscript: buildToolTranscript(list) }`，
// 而 compaction.js 的取值是 `传入值 || buildToolTranscript(expanded)`——**传入值非空就短路**。
// 只要 list 里有顶层 tool_calls（工作区 loop 的历史就是这样），短路就成立，
// 于是只挂在展示消息 `toolTrace` 里的工具调用**完全不会被转写**：
// M 线「压缩靶子改为完整 transcript」的卖点在这条路径上静默失效。
// 这条测试必须同时具备两种工具调用（顶层一个 + toolTrace 里一个），否则短路触发不起来，
// 测试就会「假绿」——这正是原 bug 能活下来的原因。
test('回归 P1-2：reactive 路径的摘要请求必须展开 toolTrace（不被传入的转写短路）', async () => {
  const messages = [
    { role: 'user', text: '改一下 a.js' },
    {
      role: 'assistant',
      text: '改完了',
      // 展示消息上的轨迹：这里的工具调用**只**存在于 toolTrace 内。
      toolTrace: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 't1',
            type: 'function',
            function: { name: 'write_workspace_file', arguments: JSON.stringify({ path: 'a.js', content: 'x' }) },
          }],
        },
        { role: 'tool', tool_call_id: 't1', content: '已写入 a.js（1 字符）' },
      ],
    },
    // 顶层 tool_calls：让「未展开的转写」非空，从而触发旧代码的短路分支。
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 't2',
        type: 'function',
        function: { name: 'read_workspace_file', arguments: JSON.stringify({ path: 'b.js' }) },
      }],
    },
    { role: 'tool', tool_call_id: 't2', content: 'b.js 的内容' },
  ];

  let seenRequest = null;
  const result = await runReactiveCompact({
    messages,
    error: { code: 'context_length_exceeded' },
    deps: {
      summarize: async request => { seenRequest = request; return '摘要'; },
    },
  });
  assert.equal(result.compacted, true);
  assert.ok(seenRequest, '摘要器必须收到请求');
  const userContent = String(seenRequest[1].content);
  assert.ok(userContent.includes('a.js'), 'toolTrace 里的写调用必须被转写进摘要请求');
  assert.ok(userContent.includes('b.js'), '顶层 tool_calls 的读调用同样必须在（两者都要）');
  assert.ok(userContent.includes('write_workspace_file'), '转写要带上工具名');
  assert.ok(userContent.includes('read_workspace_file'));
});

