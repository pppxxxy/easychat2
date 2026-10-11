// 会话事件流只读回看（workspace/sessionEventView.js）——纯函数行为测试。
// 背景：事件早就落盘了，但界面上只有「导出」，没有「看这一轮发生了什么」。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  eventPreview,
  summarizeSessionEvent,
  summarizeSessionEvents,
} from '../src/workspace/sessionEventView.js';

test('eventPreview：取首行、折叠空白、超长截断', () => {
  assert.equal(eventPreview('第一行\n第二行'), '第一行');
  assert.equal(eventPreview('  a   b  '), 'a b');
  assert.equal(eventPreview(null), '');
  const long = eventPreview('x'.repeat(200), { max: 20 });
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('…'));
});

test('summarizeSessionEvent：三种真实写入的类型各有专属文案', () => {
  const user = summarizeSessionEvent({ id: 'e1', type: 'user', ts: 1700000000000, text: '帮我看看登录' });
  assert.equal(user.key, 'workspace.events.user');
  assert.deepEqual(user.params, { text: '帮我看看登录' });
  assert.equal(user.at, 1700000000000);

  const call = summarizeSessionEvent({ type: 'tool_call', ts: 1, name: 'read_workspace_file', round: 3 });
  assert.equal(call.key, 'workspace.events.toolCall');
  assert.deepEqual(call.params, { name: 'read_workspace_file', round: 3 });

  const ok = summarizeSessionEvent({ type: 'assistant', ts: 1, text: '读完了' });
  assert.equal(ok.key, 'workspace.events.assistant');
  // 出错的终稿要能一眼看出来，否则回看时「没回话」和「报错了」长得一样
  const bad = summarizeSessionEvent({ type: 'assistant', ts: 1, text: '失败了', isError: true });
  assert.equal(bad.key, 'workspace.events.assistantError');
});

test('summarizeSessionEvent：声明了但当前无写入点的类型也有文案（真写入了就能显示）', () => {
  const cases = [
    ['tool_result', { name: 'run_shell' }, 'workspace.events.toolResult'],
    ['plan_update', { plan: [{ step: 'a' }, { step: 'b' }] }, 'workspace.events.planUpdate'],
    ['mode_change', { mode: 'write' }, 'workspace.events.modeChange'],
    ['compaction', { applied: 'memory' }, 'workspace.events.compaction'],
    ['branch_fork', { from: 'chat-1' }, 'workspace.events.branchFork'],
  ];
  for (const [type, payload, key] of cases) {
    const row = summarizeSessionEvent({ type, ts: 1, ...payload });
    assert.equal(row.key, key, type);
  }
  assert.deepEqual(summarizeSessionEvent({ type: 'plan_update', ts: 1 }).params, { count: 0 });
});

test('summarizeSessionEvent：未知类型走通用兜底，显示原始 type 而不是编一个名字', () => {
  const row = summarizeSessionEvent({ type: 'some_future_event', ts: 1 });
  assert.equal(row.key, 'workspace.events.unknown');
  assert.deepEqual(row.params, { type: 'some_future_event' });
  // 坏输入
  assert.equal(summarizeSessionEvent(null), null);
  assert.equal(summarizeSessionEvent({ ts: 1 }), null, '没有 type 的行不显示');
  assert.equal(summarizeSessionEvent({ type: '   ' }), null);
});

test('summarizeSessionEvents：倒序（最近的在最上面）——回看的第一诉求是「刚刚发生了什么」', () => {
  const events = [
    { id: 'a', type: 'user', ts: 1, text: '一' },
    { id: 'b', type: 'tool_call', ts: 2, name: 'x', round: 1 },
    { id: 'c', type: 'assistant', ts: 3, text: '二' },
  ];
  const { rows, total, truncated } = summarizeSessionEvents(events);
  assert.deepEqual(rows.map(r => r.id), ['c', 'b', 'a']);
  assert.equal(total, 3);
  assert.equal(truncated, false);
});

test('summarizeSessionEvents：limit 只截显示，total 如实报全量（界面要能说「还有 N 条」）', () => {
  const events = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, type: 'user', ts: i + 1, text: `第${i}条` }));
  const result = summarizeSessionEvents(events, { limit: 10 });
  assert.equal(result.rows.length, 10);
  assert.equal(result.total, 30);
  assert.equal(result.truncated, true);
  // 截的是**最旧**的，最近 10 条必须还在
  assert.equal(result.rows[0].id, 'e29');
  assert.equal(result.rows[9].id, 'e20');
  // 坏 limit 退化为默认 50，不返回空列表
  assert.equal(summarizeSessionEvents(events, { limit: 0 }).rows.length, 30);
});

test('summarizeSessionEvents：坏行被跳过，坏输入不抛', () => {
  const events = [null, undefined, {}, { type: '' }, { id: 'ok', type: 'user', ts: 1, text: 'hi' }, 'nope'];
  const result = summarizeSessionEvents(events);
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].id, 'ok');
  assert.deepEqual(summarizeSessionEvents(null), { rows: [], total: 0, truncated: false });
  assert.deepEqual(summarizeSessionEvents('not-an-array'), { rows: [], total: 0, truncated: false });
});
