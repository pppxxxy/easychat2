// E4 会话事件流测试：纯函数（构造 / 序列化 / 解析 / 导出）+ IO（fake store 往返）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendSessionEvent,
  buildSessionEventsExport,
  createSessionEvent,
  parseSessionEvents,
  readSessionEvents,
  SESSION_EVENTS_MAX_BYTES,
  sessionEventsPath,
  serializeSessionEvent,
} from '../src/workspace/sessionEvents.js';

test('E4 createSessionEvent：补 id/ts/parentEventId，保留字段不可被 payload 覆盖', () => {
  const event = createSessionEvent('tool_call', { name: 'read_workspace_file', round: 2 }, { now: 1700000000000, seq: 3 });
  assert.equal(event.type, 'tool_call');
  assert.equal(event.ts, 1700000000000);
  assert.equal(event.name, 'read_workspace_file');
  assert.equal(event.round, 2);
  assert.ok(event.id.startsWith('ev-'), 'id 生成');

  const withParent = createSessionEvent('assistant', { text: 'x' }, { parentEventId: 'ev-1', now: 1 });
  assert.equal(withParent.parentEventId, 'ev-1');

  // 保留字段防覆盖 + undefined 不落盘 + 未知类型前向兼容
  const guarded = createSessionEvent('user', { id: 'hack', type: 'hack', ts: 0, note: undefined, ok: 1 }, { now: 5 });
  assert.notEqual(guarded.id, 'hack');
  assert.notEqual(guarded.type, 'hack');
  assert.equal(guarded.ts, 5);
  assert.equal('note' in guarded, false, 'undefined 不落盘');
  assert.equal(guarded.ok, 1);
  assert.equal(createSessionEvent('未来的类型', {}).type, '未来的类型', '未知 type 照收');
});

test('E4 sessionEventsPath：路径收敛 + 非法字符 slug 化', () => {
  assert.equal(sessionEventsPath('chat-1'), '.easychat/sessions/chat-1.jsonl');
  assert.equal(sessionEventsPath('a/b c'), '.easychat/sessions/a_b_c.jsonl');
  assert.equal(sessionEventsPath(''), '.easychat/sessions/unknown.jsonl');
});

test('E4 serialize/parse：JSONL 往返 + 坏行跳过（导出与审计侧容错）', () => {
  const a = createSessionEvent('user', { text: '你好' }, { now: 1 });
  const b = createSessionEvent('assistant', { text: '在的' }, { now: 2 });
  const text = `${serializeSessionEvent(a)}\n不是 JSON 的一行\n${serializeSessionEvent(b)}\n\n`;
  const events = parseSessionEvents(text);
  assert.equal(events.length, 2, '坏行与空行跳过，正常行全收');
  assert.equal(events[0].text, '你好');
  assert.equal(events[1].text, '在的');
  assert.deepEqual(parseSessionEvents(null), []);
  assert.deepEqual(parseSessionEvents('[]'), [], '顶层非对象跳过');
});

test('E4 appendSessionEvent：首写 → 追加 → 到上限停止（全不抛错）', async () => {
  const files = {};
  const store = {
    async writeWorkspaceFile({ path, content }) { files[path] = content; },
    async readWorkspaceFile({ path }) {
      if (!(path in files)) throw new Error('missing');
      return { content: files[path] };
    },
  };
  const first = await appendSessionEvent(store, 'c1', 'chat-1', 'user', { text: '第一条' });
  assert.ok(first && first.id, '首写返回事件');
  assert.ok(files['.easychat/sessions/chat-1.jsonl'].includes('第一条'));

  const second = await appendSessionEvent(store, 'c1', 'chat-1', 'assistant', { text: '第二条' });
  assert.notEqual(second.id, first.id, '连续追加 id 不同');
  const lines = files['.easychat/sessions/chat-1.jsonl'].trim().split('\n');
  assert.equal(lines.length, 2, '追加不覆盖（读改写）');

  const events = await readSessionEvents(store, 'c1', 'chat-1');
  assert.deepEqual(events.map(item => item.type), ['user', 'assistant']);

  // 到上限停止追加：如实失败（返回 null），已有内容不动
  files['.easychat/sessions/chat-1.jsonl'] = 'x'.repeat(SESSION_EVENTS_MAX_BYTES + 1);
  assert.equal(await appendSessionEvent(store, 'c1', 'chat-1', 'user', {}), null, '到上限 → null');
  assert.equal(files['.easychat/sessions/chat-1.jsonl'].length, SESSION_EVENTS_MAX_BYTES + 1, '不再写入');

  // 旁路机制：缺 store / 读写抛错都不得抛错
  assert.equal(await appendSessionEvent(null, 'c1', 'chat-1', 'user', {}), null);
  const failing = { async writeWorkspaceFile() { throw new Error('no space'); } };
  assert.equal(await appendSessionEvent(failing, 'c1', 'chat-1', 'user', {}), null, '写失败返回 null 不抛');
  assert.deepEqual(await readSessionEvents(null, 'c1', 'chat-1'), []);
});

test('E4 buildSessionEventsExport：注释头 + 每行一事件；空列表也给出头', () => {
  const events = [
    createSessionEvent('user', { text: '你好' }, { now: 1 }),
    createSessionEvent('tool_call', { name: 'run_shell', round: 1 }, { now: 2 }),
  ];
  const text = buildSessionEventsExport(events, { title: 'chat-1' });
  assert.ok(text.startsWith('# 会话事件流导出：chat-1'), '带标题的注释头');
  assert.ok(text.includes('# 事件数：2'));
  assert.equal(text.trim().split('\n').filter(line => !line.startsWith('#')).length, 2, '两行事件');
  const empty = buildSessionEventsExport([], { title: 'x' });
  assert.ok(empty.includes('# 事件数：0'));
  assert.ok(!empty.includes('\n{'), '空列表不产生事件行');
});
