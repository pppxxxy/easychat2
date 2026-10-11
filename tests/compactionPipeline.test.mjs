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
  // 回归 P0-5：摘要正文里的归档路径必须与返回值一致——见下面的专项测试。
  assert.equal(result.transcriptPath, '.transcripts/t.jsonl');

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

// 回归 P2：摘要消息 id 原先就是 `compaction-${Date.now()}`——同一毫秒内的两次压缩会生成
// **完全相同的 id**。React 把重复 key 当成同一条消息（渲染错位/丢消息），分支 fork 点按 id
// 引用也会指向错的那条。这里把时钟钉死在同一毫秒，确定性地复现原 bug（不靠"跑得够快"）。
test('回归 P2：同一毫秒内的两次压缩必须拿到不同的摘要消息 id', () => {
  const msgs = [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'ok' }];
  const realNow = Date.now;
  const frozen = 1700000000000;
  Date.now = () => frozen;
  try {
    const first = applyCompactionWithAuthority(msgs, '摘要一')[0];
    const second = applyCompactionWithAuthority(msgs, '摘要二')[0];
    assert.notEqual(first.id, second.id, '同一毫秒内的两次压缩不得撞 id');
    assert.equal(first.at, frozen, 'at 用被钉住的时钟');
    assert.equal(first.at, second.at, '（前提成立）两次确实落在同一毫秒');
    assert.match(first.id, /^compaction-\d+-\d+$/, 'id 形状：时间戳 + 自增序号');
    // 序号单调：连续多次调用全都不重复（这也是「渲染 key 唯一」的保证）。
    const ids = Array.from({ length: 50 }, (_, index) => applyCompactionWithAuthority(msgs, `s${index}`)[0].id);
    assert.equal(new Set(ids).size, ids.length, '50 次调用不得出现重复 id');
  } finally {
    Date.now = realNow;
  }
});

// 回归 2026-10-11 审查 P0-5：runCompactionPipeline 的**所有** return 原先都硬编码
// `transcriptPath: ''`——L3 明明已经写盘、路径也拼进了摘要正文，调用方（ChatPanel）
// 却永远拿到空串：归档了，但没人知道在哪。对照组 chat/reactiveCompact.js 的写法是对的。
test('回归 P0-5：L3 写盘后 transcriptPath 必须原样带出，且与摘要正文里的指针一致', async () => {
  const messages = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'ok' },
  ];
  const result = await runCompactionPipeline(messages, {
    autoRatio: 0,
    deps: {
      estimateRatio: () => 0.9,
      summarize: async () => '三段式摘要',
      writeTranscript: async jsonl => {
        assert.match(jsonl, /"role":"user"/, '归档的是完整历史的 jsonl');
        return { path: '.transcripts/2026-10-11.jsonl' };
      },
    },
  });
  assert.deepEqual(result.applied, ['L2', 'L3']);
  assert.equal(result.transcriptPath, '.transcripts/2026-10-11.jsonl', '归档路径必须带出（此前恒为空串）');
  // 「摘要里写着路径、返回值却是空」正是原 bug 的自相矛盾之处，这里把两者钉在一起。
  assert.ok(
    String(result.messages[0].text).includes(`完整历史：${result.transcriptPath}`),
    '摘要正文里的归档指针必须与返回的 transcriptPath 是同一个值',
  );

  // 没走 L3 的路径（没注入 writeTranscript）必须如实给空串，而不是 undefined
  // ——调用方会直接把它当字符串用。
  const noArchive = await runCompactionPipeline(messages, {
    autoRatio: 0,
    deps: { estimateRatio: () => 0.9, summarize: async () => '三段式摘要' },
  });
  assert.deepEqual(noArchive.applied, ['L2']);
  assert.equal(noArchive.transcriptPath, '', '没归档就是空串（不是 undefined）');
  assert.equal(String(noArchive.messages[0].text).includes('完整历史：'), false);

  // 早期短路 return 也要带上该字段（形状一致，调用方不必判 undefined）
  const tooSmall = await runCompactionPipeline(messages, { autoRatio: 0.9, deps: { estimateRatio: () => 0.1 } });
  assert.deepEqual(tooSmall.applied, []);
  assert.equal(tooSmall.transcriptPath, '');
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

// 回归 2026-10-11 审查 P0-4：管线的 L2 原先读 `d.retainMinMessages`，而宿主
// （chat/sessionCompaction.js 的 buildSessionCompactionDeps）写的是 `minMessages`——
// 全仓没有第二处定义 retainMinMessages，于是下限永远退化到默认 6 条。
// 既有测试只断言「deps 里有 minMessages 这个键」，从没断言**管线真的用了它**，所以漏过了。
// 这条测试必须走完整管线（不是直接调 applyCompactionWithAuthority），否则测不到键名。
test('回归 P0-4：管线真的用了 deps.minMessages——传 0 就一条都不保留', async () => {
  const messages = [
    { role: 'user', content: 'a'.repeat(100) },
    { role: 'assistant', content: 'b'.repeat(100) },
    { role: 'user', content: 'c'.repeat(100) },
    { role: 'assistant', content: 'd'.repeat(100) },
  ];
  const est = m => String(m.content || '').length; // 每条 100 token
  const base = {
    estimateRatio: () => 0.9, // 始终高压 → 走到 L2
    summarize: async () => '已完成：无\n关键决策与发现：无\n未完成与下一步：无',
    estimateTokens: est,
    // 预算 1 < 单条 100：**预算本身一条都装不下**，所以「保留几条」完全由下限决定——
    // 这正是能把 minMessages 单独拎出来验证的形状（预算够宽时下限不参与判定）。
    retainTokens: 1,
  };
  const zero = await runCompactionPipeline(messages, { autoRatio: 0, deps: { ...base, minMessages: 0 } });
  assert.deepEqual(zero.applied, ['L2']);
  assert.equal(zero.messages.length, 1, 'minMessages: 0 → 只留摘要消息，0 条原文');

  // 下限真的是「下限」：同一个预算下 minMessages: 2 → 至少留 2 条。
  const two = await runCompactionPipeline(messages, { autoRatio: 0, deps: { ...base, minMessages: 2 } });
  assert.equal(two.messages.length, 3, 'minMessages: 2 → 摘要 + 2 条原文');

  // 键名写错（旧 bug 的形状：管线读的键和宿主写的键不是同一个）→ 下限退回默认 6 条，
  // 于是「一条都装不下」的预算反而全保留。这条钉住「键名必须与宿主一致」：
  // 写错的后果不是报错，而是**静默变成默认值**，所以测试必须盯真实键名。
  const typo = await runCompactionPipeline(messages, { autoRatio: 0, deps: { ...base, retainMinMessages: 0 } });
  assert.equal(typo.messages.length, 5, '键名写错 → 下限退回默认 6，4 条原文全部保留（= 旧 bug 的现象）');
});
