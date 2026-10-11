// 团队协作加深（差距 #4）：直连消息（board_send/board_inbox）+ 任务看板（board_task）。
// 纯逻辑 + 工具层行为测试。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBlackboard,
  normalizeAgent,
  formatInboxMessages,
  formatTaskBoard,
  boardTasks,
  BLACKBOARD_VERSION,
  TEAM_TASK_MAX,
  BLACKBOARD_MAX_MESSAGES,
} from '../src/agent/blackboard.js';
import {
  BOARD_SEND_TOOL_DEFINITION,
  BOARD_INBOX_TOOL_DEFINITION,
  BOARD_TASK_TOOL_DEFINITION,
  BOARD_TOOL_NAMES,
} from '../src/workspace/toolDefs/boardTools.js';

test('normalizeAgent：裁剪与去空白', () => {
  assert.equal(normalizeAgent('  A '), 'a');
  assert.equal(normalizeAgent(null), '');
});

test('直连消息：send 投递到收件箱、inbox 按 since 增量读', () => {
  const board = createBlackboard();
  board.send({ to: 'B', from: 'A', text: '第一条' });
  board.send({ to: 'B', from: 'A', text: '第二条' });
  board.send({ to: 'C', from: 'A', text: '给 C 的' });
  const inboxB = board.inbox({ for: 'b' });
  assert.equal(inboxB.messages.length, 2);
  assert.equal(inboxB.for, 'b');
  const first = inboxB.messages[0].seq;
  const inc = board.inbox({ for: 'B', since: first });
  assert.equal(inc.messages.length, 1);
  assert.equal(board.inbox({ for: 'C' }).messages.length, 1);
  assert.equal(board.inbox({ for: 'D' }).messages.length, 0);
  assert.equal(board.send({ to: '', text: 'x' }).ok, false);
});

test('直连消息：单收件箱有条数上限（环形淘汰）', () => {
  const board = createBlackboard();
  for (let i = 0; i < BLACKBOARD_MAX_MESSAGES + 5; i += 1) board.send({ to: 'B', text: `m${i}` });
  assert.equal(board.inbox({ for: 'B' }).messages.length, BLACKBOARD_MAX_MESSAGES);
});

test('任务看板：add / claim / complete / list 生命周期', () => {
  const board = createBlackboard();
  const a = board.addTask({ title: '调研 A' });
  const b = board.addTask({ title: '调研 B', owner: 'B' });
  assert.equal(a.task.id, 1);
  assert.equal(b.task.owner, 'b');
  assert.equal(board.listTasks().length, 2);
  const claimed = board.claimTask({ id: 1, by: 'A' });
  assert.equal(claimed.task.status, 'claimed');
  assert.equal(claimed.task.owner, 'a');
  const done = board.completeTask({ id: 1, by: 'A', note: '完成' });
  assert.equal(done.task.status, 'done');
  assert.equal(done.task.note, '完成');
  assert.equal(board.completeTask({ id: 1 }).ok, true, '重复完成幂等');
  assert.equal(board.claimTask({ id: 1 }).ok, false, '已完成不可认领');
  assert.equal(board.addTask({ title: '' }).ok, false);
  assert.equal(board.claimTask({ id: 999 }).ok, false);
});

test('任务看板：数量上限', () => {
  const board = createBlackboard();
  for (let i = 0; i < TEAM_TASK_MAX; i += 1) board.addTask({ title: `t${i}` });
  assert.equal(board.addTask({ title: 'overflow' }).ok, false);
});

test('serialize/seed：消息与任务往返，版本为 2', () => {
  const board = createBlackboard();
  board.send({ to: 'B', from: 'A', text: 'hi' });
  board.addTask({ title: 'T', owner: 'A' });
  const data = board.serialize();
  assert.equal(data.version, BLACKBOARD_VERSION);
  assert.equal(data.version, 2);
  const revived = createBlackboard({ initial: data });
  assert.equal(revived.inbox({ for: 'B' }).messages.length, 1);
  assert.equal(revived.listTasks().length, 1);
  assert.equal(revived.listTasks()[0].title, 'T');
  // 坏数据不崩
  assert.equal(createBlackboard({ initial: { messages: 'oops', tasks: 'oops' } }).listTasks().length, 0);
});

test('hasContent：只有消息/任务时也为真', () => {
  const board = createBlackboard();
  assert.equal(board.hasContent(), false);
  board.addTask({ title: 'x' });
  assert.equal(board.hasContent(), true);
});

test('格式化：收件箱与任务看板', () => {
  assert.match(formatInboxMessages('B', []), /暂无新消息/);
  assert.match(formatInboxMessages('B', [{ seq: 1, from: 'A', text: 'hi' }]), /\[1\] A：hi/);
  assert.match(formatTaskBoard([]), /为空/);
  assert.match(formatTaskBoard([{ id: 2, status: 'claimed', title: 'T', owner: 'A' }]), /#2 \[claimed\] T（@A）/);
});

test('boardTasks：无黑板/有任务时的快照', () => {
  assert.deepEqual(boardTasks(null), []);
  const board = createBlackboard();
  board.addTask({ title: 'T' });
  assert.equal(boardTasks(board)[0].title, 'T');
});

test('工具层：board_send / board_inbox / board_task', () => {
  const board = createBlackboard();
  const ctx = { board, agentName: 'A' };
  const sent = BOARD_SEND_TOOL_DEFINITION.execute({}, { to: 'B', text: 'hello' }, ctx);
  assert.match(sent.content, /已发送给「b」/);
  const inbox = BOARD_INBOX_TOOL_DEFINITION.execute({}, {}, { board, agentName: 'B' });
  assert.match(inbox.content, /hello/);
  const added = BOARD_TASK_TOOL_DEFINITION.execute({}, { action: 'add', title: '做 X' }, ctx);
  assert.match(added.content, /已新增任务 #1/);
  const claimed = BOARD_TASK_TOOL_DEFINITION.execute({}, { action: 'claim', id: 1 }, ctx);
  assert.match(claimed.content, /已认领/);
  const listed = BOARD_TASK_TOOL_DEFINITION.execute({}, { action: 'list' }, ctx);
  assert.match(listed.content, /#1 \[claimed\] 做 X/);
  const bad = BOARD_TASK_TOOL_DEFINITION.execute({}, { action: 'nope' }, ctx);
  assert.equal(bad.isError, true);
  // 无黑板 → 报「不在团队协作中」
  assert.equal(BOARD_SEND_TOOL_DEFINITION.execute({}, { to: 'B', text: 'x' }, {}).isError, true);
  assert.equal(BOARD_INBOX_TOOL_DEFINITION.execute({}, {}, {}).isError, true);
  assert.equal(BOARD_TASK_TOOL_DEFINITION.execute({}, { action: 'list' }, {}).isError, true);
});

test('工具清单包含 5 个 board 工具', () => {
  assert.deepEqual([...BOARD_TOOL_NAMES], ['board_post', 'board_read', 'board_send', 'board_inbox', 'board_task']);
});
