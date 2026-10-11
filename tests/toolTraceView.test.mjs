// 工具调用轨迹展示归纳（toolTraceView）测试。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeToolTrace,
  countToolCalls,
  TOOL_TRACE_STEP_MAX,
  TOOL_TRACE_PREVIEW_CHARS,
} from '../src/chat/toolTraceView.js';

test('summarizeToolTrace：按 tool_call_id 配对名字 / 参数 / 结果', () => {
  const trace = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'read_workspace_file', arguments: '{"path":"a.js"}' }] },
    { role: 'tool', tool_call_id: 'c1', content: '内容:a.js' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', name: 'write_workspace_file', arguments: '{"path":"b.js"}' }] },
    { role: 'tool', tool_call_id: 'c2', content: '写入 b.js' },
  ];
  const steps = summarizeToolTrace(trace);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], { name: 'read_workspace_file', args: '{"path":"a.js"}', result: '内容:a.js' });
  assert.equal(steps[1].name, 'write_workspace_file');
  assert.equal(steps[1].result, '写入 b.js');
});

test('summarizeToolTrace：缺结果 → 空串；一轮多条调用；空 / 坏输入不崩', () => {
  const trace = [
    { role: 'assistant', tool_calls: [{ id: 'x', name: 'list_workspace_files', arguments: '' }] },
    { role: 'assistant', tool_calls: [{ id: 'y', name: 'search_workspace', arguments: '{}' }, { id: 'z', name: 'run_shell', arguments: '{}' }] },
  ];
  const steps = summarizeToolTrace(trace);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].result, '', '没有配对结果时为空串');
  assert.equal(summarizeToolTrace(null).length, 0);
  assert.equal(summarizeToolTrace([{ role: 'tool', content: 'x' }]).length, 0, '没有调用就没有步骤');
});

test('summarizeToolTrace：单行化 + 截断；步数上限', () => {
  const long = 'x'.repeat(TOOL_TRACE_PREVIEW_CHARS + 100);
  const trace = [
    { role: 'assistant', tool_calls: [{ id: 'c', name: 'run_shell', arguments: `line1\nline2 ${long}` }] },
    { role: 'tool', tool_call_id: 'c', content: 'ok\n\n   done' },
  ];
  const steps = summarizeToolTrace(trace);
  assert.equal(steps[0].args.includes('\n'), false, '压成单行');
  assert.ok(steps[0].args.length <= TOOL_TRACE_PREVIEW_CHARS);
  assert.equal(steps[0].result, 'ok done', '多空白折叠');
  const many = summarizeToolTrace([{
    role: 'assistant',
    tool_calls: Array.from({ length: TOOL_TRACE_STEP_MAX + 5 }, (unused, i) => ({ id: `c${i}`, name: 't', arguments: '{}' })),
  }]);
  assert.equal(many.length, TOOL_TRACE_STEP_MAX);
});

test('countToolCalls：只数有名字的调用', () => {
  assert.equal(countToolCalls([{ role: 'assistant', tool_calls: [{ name: 'a' }, { name: 'b' }] }, { role: 'tool' }]), 2);
  assert.equal(countToolCalls([{ role: 'assistant', tool_calls: [{ name: '' }, {}] }]), 0);
  assert.equal(countToolCalls(null), 0);
});
