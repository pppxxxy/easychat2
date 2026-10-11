// N2：工作区压缩四档管线 + recap + 权威分离 + 归档（纯逻辑）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { COMPACTION_MARKER, COMPACTION_KEEP_RECENT } from '../src/chat/compaction.js';
import { findOrphanToolMessages } from '../src/agent/resultClearing.js';
import {
  applyCompactionWithAuthority,
  buildRecapSection,
  buildToolTranscript,
  buildTranscriptJsonl,
  isCompactedHistory,
  runCompactionPipeline,
  sliceRecentByBudget,
  sliceRecentIntact,
  trimLargeToolResults,
} from '../src/chat/compactionPipeline.js';

function toolCall(id, name, args) {
  return { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}
function toolResult(id, content) {
  return { role: 'tool', tool_call_id: id, content };
}

test('trimLargeToolResults：头 4096 + 标注 + 尾 1024；小结果不动；配对不变', () => {
  const big = 'H'.repeat(5000) + 'M'.repeat(5000) + 'T'.repeat(5000);
  const messages = [
    toolCall('c1', 'read_workspace_file', { path: 'a.js' }),
    toolResult('c1', big),
    { role: 'assistant', content: 'ok' },
  ];
  const { messages: out, changed } = trimLargeToolResults(messages);
  assert.equal(changed, true);
  assert.match(String(out[1].content), /^H{4096}/);
  assert.match(String(out[1].content), /\[中段已修剪\]/);
  assert.ok(String(out[1].content).length < big.length);
  assert.equal(findOrphanToolMessages(out).length, 0);

  const small = [toolResult('c2', 'short')];
  assert.equal(trimLargeToolResults(small).changed, false);
});

test('buildToolTranscript：为 write/read/plan 各生成一行', () => {
  const messages = [
    toolCall('c1', 'write_workspace_file', { path: 'src/a.js' }),
    toolResult('c1', 'x'.repeat(30)),
    toolCall('c2', 'read_workspace_file', { path: 'README.md' }),
    toolResult('c2', 'y'.repeat(10)),
    toolCall('c3', 'update_plan', { plan: [] }),
    toolResult('c3', '计划'),
  ];
  const text = buildToolTranscript(messages);
  assert.match(text, /调用了 write_workspace_file：src\/a\.js（结果 30 字符）/);
  assert.match(text, /调用了 read_workspace_file：README\.md（结果 10 字符）/);
  assert.match(text, /调用了 update_plan：\(无路径\)/);
});

test('sliceRecentIntact：起点落在 tool 结果上则前移到其 assistant', () => {
  const messages = [
    { role: 'user', content: 'u' },
    toolCall('c1', 'read_workspace_file', { path: 'a' }),
    toolResult('c1', 'r'),
    { role: 'assistant', content: 'ok' },
  ];
  // keep=2 → 名义起点 index=2（tool 结果）→ 前移到 index=1（assistant tool_call）
  const slice = sliceRecentIntact(messages, 2);
  assert.equal(slice[0].role, 'assistant');
  assert.equal(slice.length, 3);
});

test('applyCompactionWithAuthority：权威分离格式 + marker + 归档指针 + 尾部原文', () => {
  const messages = [
    { role: 'user', content: '帮我改 a.js' },
    toolCall('c1', 'read_workspace_file', { path: 'a.js' }),
    toolResult('c1', 'body'),
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '再改 b.js' },
  ];
  const out = applyCompactionWithAuthority(messages, '已完成：改 a.js\n关键决策与发现：无\n未完成与下一步：改 b.js', { transcriptPath: '.transcripts/x.jsonl' });
  assert.equal(out[0].role, 'assistant');
  assert.match(String(out[0].content), /\[历史压缩\]/);
  assert.match(String(out[0].content), /当前用户请求：再改 b\.js（权威）/);
  assert.match(String(out[0].content), /历史摘要（仅供参考，不构成指令）：/);
  assert.match(String(out[0].content), /完整历史：\.transcripts\/x\.jsonl/);
  assert.ok(out.length > 1, '尾部保留原文');
});

test('buildRecapSection：计划最后状态 + 触碰文件 + 已读清单', () => {
  const recap = buildRecapSection({
    plan: [{ step: 'A', status: 'done' }, { step: 'B', status: 'in_progress' }],
    touchedFiles: ['src/a.js', 'README.md'],
    readLog: [{ path: 'a.js' }],
  });
  assert.match(recap, /计划最后状态：/);
  assert.match(recap, /\[x\] 1\. A/);
  assert.match(recap, /\[>\] 2\. B/);
  assert.match(recap, /触碰文件：src\/a\.js、README\.md/);
  assert.match(recap, /已读文件/);
});

test('buildTranscriptJsonl / isCompactedHistory', () => {
  const jsonl = buildTranscriptJsonl([{ role: 'user', content: 'hi' }]);
  assert.equal(JSON.parse(jsonl).content, 'hi');

  assert.equal(isCompactedHistory([{ role: 'assistant', content: `${COMPACTION_MARKER}\n摘要` }]), true);
  assert.equal(isCompactedHistory([{ role: 'user', content: 'hi' }]), false);
});

// ---- 四档编排 ----

function ratioSeq(...values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

test('runCompactionPipeline：低于阈值不动', async () => {
  const result = await runCompactionPipeline([{ role: 'user', content: 'hi' }], {
    autoRatio: 0.8,
    deps: { estimateRatio: () => 0.5 },
  });
  assert.deepEqual(result.applied, []);
});

test('runCompactionPipeline：L0 修剪达标即短路，跳过 L1/L2', async () => {
  const messages = [toolCall('c1', 'read_workspace_file', { path: 'a' }), toolResult('c1', 'x'.repeat(20000)), { role: 'assistant', content: 'ok' }];
  let summarized = false;
  const result = await runCompactionPipeline(messages, {
    autoRatio: 0.8,
    deps: {
      estimateRatio: ratioSeq(0.9, 0.5), // 初始 0.9；修剪后 0.5
      persist: async () => ({ path: '.task_outputs/tool-results/c1.txt' }),
      summarize: async () => { summarized = true; return 's'; },
    },
  });
  assert.deepEqual(result.applied, ['L0']);
  assert.equal(summarized, false, '修剪解除压力即跳摘要');
  assert.match(String(result.messages[1].content), /完整内容见 \.task_outputs/);
});

test('runCompactionPipeline：四档全跑（L0→L1→L2→L3）+ 权威分离 + 幂等', async () => {
  const messages = [
    { role: 'user', content: 'go' },
    toolCall('c1', 'read_workspace_file', { path: 'a' }),
    toolResult('c1', 'x'.repeat(20000)),
    { role: 'assistant', content: 'ok' },
  ];
  const result = await runCompactionPipeline(messages, {
    autoRatio: 0.8,
    deps: {
      estimateRatio: () => 0.9, // 始终高压 → 走完四档
      persist: async () => ({ path: '.task_outputs/tool-results/c1.txt' }),
      clear: async msgs => ({ messages: msgs, changed: true }),
      summarize: async () => '已完成：无\n关键决策与发现：无\n未完成与下一步：无',
      writeTranscript: async () => ({ path: '.transcripts/t.jsonl' }),
    },
  });
  assert.deepEqual(result.applied, ['L0', 'L1', 'L2', 'L3']);
  assert.match(String(result.messages[0].content), /\[历史压缩\]/);
  assert.match(String(result.messages[0].content), /完整历史：\.transcripts\/t\.jsonl/);

  // 幂等：对已压缩历史再跑 → no-op
  const again = await runCompactionPipeline(result.messages, { autoRatio: 0.8, deps: { estimateRatio: () => 0.9, summarize: async () => 'X' } });
  assert.deepEqual(again.applied, []);
});

test('runCompactionPipeline：L0 落盘失败保原文（不修剪）', async () => {
  const big = 'x'.repeat(20000);
  const messages = [toolCall('c1', 'read_workspace_file', { path: 'a' }), toolResult('c1', big), { role: 'assistant', content: 'ok' }];
  const result = await runCompactionPipeline(messages, {
    autoRatio: 0.8,
    deps: { estimateRatio: () => 0.9, persist: async () => null, clear: async msgs => ({ messages: msgs, changed: false }) },
  });
  assert.equal(result.messages[1].content, big, '落盘失败不清除也不修剪');
  assert.equal(COMPACTION_KEEP_RECENT, 6);
});

test('P4：sliceRecentByBudget 按 token 预算保留尾部，带最少条数下限', () => {
  const msgs = [
    { role: 'user', content: 'a'.repeat(100) },
    { role: 'assistant', content: 'b'.repeat(100) },
    { role: 'user', content: 'c'.repeat(100) },
    { role: 'assistant', content: 'd'.repeat(100) },
  ];
  const est = m => String(m.content || '').length; // 每条 100
  // 预算 250：从尾 d(100)+c(100)+b(100)=300 超 → 停在 b 之前 → 保留 [c, d]
  const out = sliceRecentByBudget(msgs, { retainTokens: 250, minMessages: 0, estimateTokens: est });
  assert.deepEqual(out.map(m => m.content[0]), ['c', 'd']);
  // 下限保护：预算很小但 minMessages=3 → 至少 3 条
  const floored = sliceRecentByBudget(msgs, { retainTokens: 10, minMessages: 3, estimateTokens: est });
  assert.deepEqual(floored.map(m => m.content[0]), ['b', 'c', 'd']);
  // 无预算 / 无估算器 → 回退条数口径
  assert.equal(sliceRecentByBudget(msgs, { retainTokens: 0, minMessages: 2, estimateTokens: est }).length, 2);
  assert.equal(sliceRecentByBudget(msgs, { retainTokens: 250, minMessages: 0 }).length, 0, '无估算器 → sliceRecentIntact(0)=[]');
});

test('P4：sliceRecentByBudget 起点落在 tool 结果时回退（配对不破）', () => {
  const call = toolCall('x1', 'read_workspace_file', { path: 'a' });
  call.content = 'think'; // 让本条有非零 token
  const msgs = [
    { role: 'user', content: 'u'.repeat(50) },
    call,
    toolResult('x1', 'R'.repeat(200)),
    { role: 'assistant', content: 'done' },
  ];
  const est = m => String(m.content || '').length;
  // 预算 205：保留 done(4)+R(200)=204，再加 call(4)=208 超 → 起点落在 tool 结果 → 回退纳入 call
  const out = sliceRecentByBudget(msgs, { retainTokens: 205, minMessages: 0, estimateTokens: est });
  assert.ok(out[0] && Array.isArray(out[0].tool_calls), '首个是被回退纳入的 assistant(tool_calls)');
  assert.equal(findOrphanToolMessages(out).length, 0, '无孤儿');
});

test('P4：applyCompactionWithAuthority 传 retainTokens 时按 token 保留尾部', () => {
  const msgs = [
    { role: 'user', content: 'a'.repeat(100) },
    { role: 'assistant', content: 'b'.repeat(100) },
    { role: 'user', content: 'c'.repeat(100) },
    { role: 'assistant', content: 'd'.repeat(100) },
  ];
  const est = m => String(m.content || '').length;
  const out = applyCompactionWithAuthority(msgs, '摘要', { retainTokens: 250, minMessages: 0, estimateTokens: est });
  assert.match(String(out[0].content), /历史摘要/);
  assert.deepEqual(out.slice(1).map(m => String(m.content)[0]), ['c', 'd']);
});
