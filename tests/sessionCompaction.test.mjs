import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildReactiveCompactDeps,
  buildSessionCompactionDeps,
  countCompactionMessages,
  resolveCompactionFocus,
  runSessionCompaction,
} from '../src/chat/sessionCompaction.js';
import { COMPACTION_MARKER } from '../src/chat/compaction.js';
import { runReactiveCompact } from '../src/chat/reactiveCompact.js';

// N2 整合（阶段 3）：主聊天页的会话压缩接到 M 的四档管线上。这里钉住接线层的两条纪律：
//   1) 没有工作区后端 → 不注入 persist/clear/writeTranscript（对应档空转，绝不写假指针）；
//   2) 宿主已判定「该压了」→ autoRatio=0，四档全跑（不被 token 口径二次短路）。

function makeStore() {
  const writes = [];
  return {
    writes,
    writeWorkspaceFile: async ({ characterId, path, content }) => { writes.push({ characterId, path, content }); },
    listWorkspaceFiles: async () => [],
    deleteFile: async () => {},
  };
}

const toolCall = id => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'read_workspace_file', arguments: '{}' } }] });

test('buildSessionCompactionDeps：无 store → 不注入 persist/clear/writeTranscript', () => {
  const deps = buildSessionCompactionDeps({ windowSize: 200000, characterId: 'ch' });
  assert.equal(deps.persist, undefined, '没有后端就不落盘');
  assert.equal(deps.clear, undefined, 'L1 自然空转');
  assert.equal(deps.writeTranscript, undefined, 'L3 自然空转');
  assert.equal(deps.summarize, undefined, 'summarize 由宿主给');
  assert.equal(typeof deps.estimateRatio, 'function');
  assert.equal(typeof deps.estimateTokens, 'function');
  assert.equal(deps.retainTokens, Math.floor(200000 * 0.16), 'P4：尾部保留按 token 预算');
  assert.equal(deps.minMessages, 6);
});

test('buildSessionCompactionDeps：有 store → L1 走 K1（先落盘再占位；未超预算不动）', async () => {
  const store = makeStore();
  const deps = buildSessionCompactionDeps({ windowSize: 1000, store, characterId: 'ch' });
  assert.equal(typeof deps.clear, 'function');
  const big = 2 * 1024 * 1024 + 100;
  const messages = [
    toolCall('c1'),
    { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(big) },
    { role: 'assistant', content: '读完了' },
    toolCall('c2'), { role: 'tool', tool_call_id: 'c2', content: 'y'.repeat(300) },
    toolCall('c3'), { role: 'tool', tool_call_id: 'c3', content: 'z'.repeat(300) },
    toolCall('c4'), { role: 'tool', tool_call_id: 'c4', content: 'w'.repeat(300) },
  ];
  const cleared = await deps.clear(messages);
  assert.equal(cleared.changed, true);
  assert.match(String(cleared.messages[1].content), /此前工具结果已存至 \.task_outputs\//);
  assert.equal(store.writes.length >= 1, true, '占位前先落盘');
  assert.equal(store.writes[0].content.length, big, '原文只移不丢：落盘逐字一致');
  const untouched = await deps.clear([{ role: 'user', content: 'hi' }]);
  assert.equal(untouched.changed, false, '未超预算 → 不驱逐');
});

test('runSessionCompaction：宿主已判定 → autoRatio=0 四档全跑（L0 修剪 + L2 摘要 + L3 归档）', async () => {
  const store = makeStore();
  const requests = [];
  const list = [
    { role: 'user', text: '把工具结果修一下' },
    toolCall('c1'),
    { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(20000) },
    { role: 'assistant', content: '读完了' },
  ];
  const result = await runSessionCompaction({
    list,
    focus: '保留报错原文',
    windowSize: 200000,
    store,
    characterId: 'ch',
    summarize: async request => { requests.push(request); return '三段式摘要'; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.applied, ['L0', 'L2', 'L3']);
  assert.equal(store.writes.some(item => item.path.startsWith('.transcripts/')), true, 'L3 归档完整历史');
  const head = String(result.messages[0].content);
  assert.match(head, /\[历史压缩\]/);
  assert.match(head, /完整历史：\.transcripts\//);
  assert.match(head, /（权威）/, '权威分离：当前用户请求');
  assert.match(String(requests[0][0].content), /保留报错原文/, 'focus 进 L2 提示词（只影响 system）');
});

test('runSessionCompaction：摘要为空 → 不动会话，如实报 noop', async () => {
  const list = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }];
  const result = await runSessionCompaction({ list, windowSize: 200000, summarize: async () => '   ' });
  assert.deepEqual(result, { ok: false, reason: 'noop' });
});

test('runSessionCompaction：历史已是压缩产物 → 幂等短路，连摘要请求都不发', async () => {
  const list = [
    { role: 'assistant', content: `${COMPACTION_MARKER} 之前的摘要`, at: 1 },
    { role: 'user', content: 'hi' },
  ];
  let called = 0;
  const result = await runSessionCompaction({
    list,
    windowSize: 200000,
    summarize: async () => { called += 1; return 'x'; },
  });
  assert.deepEqual(result, { ok: false, reason: 'noop' });
  assert.equal(called, 0, '幂等：不再压「摘要的摘要」');
});

test('countCompactionMessages：只数有正文的 user/assistant（与 COMPACTION_MIN_MESSAGES 同口径）', () => {
  assert.equal(countCompactionMessages([
    { role: 'user', content: 'hi' },
    { role: 'assistant', text: 'ok' },
    { role: 'tool', content: 'x'.repeat(100) },
    { role: 'assistant', content: '   ' },
    { role: 'system', content: '规则' },
    null,
  ]), 2);
  assert.equal(countCompactionMessages(null), 0);
  assert.equal(countCompactionMessages([]), 0);
});

test('runSessionCompaction：端点的「空回复占位文案」不算摘要（不写进历史）', async () => {
  const list = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }];
  const result = await runSessionCompaction({
    list,
    windowSize: 200000,
    emptyReplyText: '没有收到回复。',
    summarize: async () => '没有收到回复。',
  });
  assert.deepEqual(result, { ok: false, reason: 'noop' });
});

test('buildReactiveCompactDeps：超限重试路径也先归档（有 store 才注入 writeTranscript）', async () => {
  const bare = buildReactiveCompactDeps({ summarize: async () => 'x' });
  assert.equal(bare.writeTranscript, undefined, '没有后端就不归档');
  assert.equal(typeof bare.summarize, 'function');
  const store = makeStore();
  const deps = buildReactiveCompactDeps({ store, characterId: 'ch', summarize: async () => '三段式摘要' });
  const result = await runReactiveCompact({
    messages: [{ role: 'user', content: 'hi' }],
    error: { code: 'context_length_exceeded' },
    deps,
  });
  assert.equal(result.compacted, true);
  assert.match(result.transcriptPath, /^\.transcripts\//, 'L3：破坏性替换前归档');
  assert.equal(store.writes.some(item => item.path === result.transcriptPath), true);
});

test('resolveCompactionFocus：钩子读不到一律当没有钩子，focus 原样带回（不因扩展失败而中断）', async () => {
  const noStore = { loadStore: async () => null };
  const result = await resolveCompactionFocus({ characterId: 'ch', focus: '', ...noStore });
  assert.deepEqual(result.blocked, []);
  assert.equal(result.focus, '');
  assert.equal(result.store, null);
  const withFocus = await resolveCompactionFocus({ characterId: 'ch', focus: '  保留报错原文  ', ...noStore });
  assert.deepEqual(withFocus.blocked, []);
  assert.equal(withFocus.focus, '保留报错原文', '过 normalizeCompactionFocus');
  // 加载 store 本身抛错（无工作区后端 / 原生模块缺失）→ 一样当没有钩子，不中断压缩。
  const thrown = await resolveCompactionFocus({
    characterId: 'ch',
    focus: 'x',
    loadStore: async () => { throw new Error('no backend'); },
  });
  assert.deepEqual(thrown, { blocked: [], store: null, focus: 'x' });
});

// 回归 2026-10-11 审查 P1-7：ChatPanel 原先**内联**了一份与 buildSessionCompactionDeps
// 逐字相同的五项装配（estimateRatio / summarize / writeTranscript / retainTokens /
// estimateTokens）。两份近似代码的下场必然是「只改一处」——本次合并里 estimateTokens 的正文
// 口径与 minMessages 的键名就都踩过。这里两头都钉：行为（共用函数确实覆盖那五项）与结构
// （ChatPanel 不再留副本）。
test('回归 P1-7：buildSessionCompactionDeps 覆盖宿主原先内联的五项，换用后语义不变', async () => {
  const store = makeStore();
  const seen = [];
  const deps = buildSessionCompactionDeps({
    windowSize: 200000,
    store,
    characterId: 'ch',
    summarize: async request => { seen.push(request); return '摘要'; },
  });
  // 五项逐条对照（原内联版本就是这五项）
  assert.equal(typeof deps.estimateRatio, 'function');
  assert.equal(typeof deps.summarize, 'function');
  assert.equal(typeof deps.writeTranscript, 'function');
  assert.equal(deps.retainTokens, Math.floor(200000 * 0.16), '保留量按窗口的 16%');
  assert.equal(typeof deps.estimateTokens, 'function');
  // estimateRatio：与 computeContextUsage 同口径（空历史 0，非空落在 (0,1)）
  assert.equal(deps.estimateRatio([]), 0);
  const ratio = deps.estimateRatio([{ role: 'user', text: '你好世界' }]);
  assert.ok(ratio > 0 && ratio < 1, `ratio 应落在 (0,1)，实际 ${ratio}`);
  // estimateTokens：两种消息形状同口径（正文在 text 的聊天消息 / 在 content 的工作区消息）
  const emptyTokens = deps.estimateTokens({ role: 'user', text: '' });
  const textTokens = deps.estimateTokens({ role: 'user', text: '一段中文内容' });
  const contentTokens = deps.estimateTokens({ role: 'assistant', content: '一段中文内容' });
  assert.ok(textTokens > emptyTokens, '有正文必须比空正文多算');
  assert.equal(contentTokens, textTokens, 'text 与 content 两种形状必须同口径');
  assert.ok(contentTokens > emptyTokens, '工作区消息（正文在 content）也必须被算进去');
  // writeTranscript：落到 .transcripts/（与 ChatPanel 原来那行同源）
  const stored = await deps.writeTranscript('{"role":"user"}');
  assert.match(String(stored && stored.path), /^\.transcripts\//);
  // summarize：原样透传（宿主给什么就用什么）
  await deps.summarize([{ role: 'user', content: 'x' }]);
  assert.equal(seen.length, 1);
});

test('回归 P1-7：ChatPanel 不再内联压缩 deps 装配（宿主侧只留一处）', () => {
  // FEAT-AC12：压缩的**执行逻辑**已从 ChatPanel 外提到 chatPanelCompaction.js
  //（行数棘轮）。判据不变——「必须换用共用装配函数、不得内联 deps 副本」——
  // 但要看**真正执行压缩的那个文件**。两文件都查，防有人把内联副本搬回去。
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8')
    + fs.readFileSync(path.resolve('src/workspace/screen/chatPanelCompaction.js'), 'utf8');
  assert.ok(panel.includes('buildSessionCompactionDeps('), 'ChatPanel 必须换用共用装配函数');
  // 内联的痕迹：在宿主里再写这些 deps 键（那正是会漂移的副本）。
  assert.equal(/retainTokens:\s*Math\.max\(0, Math\.floor\(windowSize/.test(panel), false, '不得再内联 retainTokens');
  assert.equal(/estimateTokens:\s*msg\s*=>/.test(panel), false, '不得再内联 estimateTokens');
  assert.equal(/writeTranscript:\s*jsonl\s*=>/.test(panel), false, '不得再内联 writeTranscript');
  assert.equal(panel.includes("from '../transcripts.js'"), false, 'writeTranscript 直连也随之移除（改由共用函数提供）');
});

