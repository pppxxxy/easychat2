// 工作区工具卡片模型（chat/toolCardView.js）——纯函数行为测试。
// 背景：工作区此前只有一行会闪过的 toolStatus，用户看不到「哪一步读了什么、失败在哪」。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_CARD_STATUS,
  applyToolEvent,
  summarizeToolArgs,
  summarizeToolCards,
  toolCardLabelKey,
} from '../src/chat/toolCardView.js';

test('toolCardLabelKey：登记的给 key，未登记/空值返回空串（界面回退显示原始工具名）', () => {
  assert.equal(toolCardLabelKey('read_workspace_file'), 'workspace.toolCard.name.read');
  assert.equal(toolCardLabelKey('run_shell'), 'workspace.toolCard.name.shell');
  assert.equal(toolCardLabelKey('  run_python  '), 'workspace.toolCard.name.python');
  // 未登记：宁可显示 run_shell 这样的原始名，也不要吞掉信息或编一个不存在的中文名
  assert.equal(toolCardLabelKey('mcp_github_create_issue'), '');
  assert.equal(toolCardLabelKey(''), '');
  assert.equal(toolCardLabelKey(null), '');
});

test('summarizeToolArgs：挑「最能说明动了什么」的字段，拿不到就给空串（不退化成一坨 JSON）', () => {
  assert.equal(summarizeToolArgs('read_workspace_file', { path: 'src/a.js' }), 'src/a.js');
  assert.equal(summarizeToolArgs('run_shell', { command: 'npm test' }), 'npm test');
  assert.equal(summarizeToolArgs('search_workspace', { pattern: 'TODO' }), 'TODO');
  // path 优先于 name（name 只说明「叫什么」，path 说明「动哪个」）
  assert.equal(summarizeToolArgs('write_workspace_file', { name: 'x', path: 'a/b.txt' }), 'a/b.txt');
  // 计划说「几步」比列步骤名有用（正文在进度条里）
  assert.equal(summarizeToolArgs('update_plan', { plan: [{ step: 'a' }, { step: 'b' }] }), '2');
  assert.equal(summarizeToolArgs('run_subagent', { tasks: ['t1', 't2', 't3'] }), '3');
  assert.equal(summarizeToolArgs('run_subagent', { task: '查一下' }), '1');
  // 数组字段用逗号连（materialize 的 paths 之类）
  assert.equal(summarizeToolArgs('materialize_repo', { paths: ['a', 'b'] }), 'a, b');
  // 没有任何有用字段 → 空串，界面就不显示这一行
  assert.equal(summarizeToolArgs('run_shell', { timeoutMs: 30000 }), '');
  assert.equal(summarizeToolArgs('run_shell', null), '');
  assert.equal(summarizeToolArgs('run_shell', 'not-an-object'), '');
  // 折叠空白 + 超长截断（卡片不能被撑爆）
  assert.equal(summarizeToolArgs('run_shell', { command: 'a\n\n  b' }), 'a b');
  const long = summarizeToolArgs('run_shell', { command: 'x'.repeat(200) }, { max: 20 });
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('…'));
});

test('applyToolEvent：start 追加、end 更新最近一张同轮同名的 running 卡', () => {
  let cards = [];
  cards = applyToolEvent(cards, { phase: 'start', name: 'read_workspace_file', round: 1, args: { path: 'a.js' } });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, TOOL_CARD_STATUS.RUNNING);
  assert.equal(cards[0].summary, 'a.js');
  assert.equal(cards[0].round, 1);

  cards = applyToolEvent(cards, { phase: 'end', name: 'read_workspace_file', round: 1, ok: true });
  assert.equal(cards.length, 1, 'end 不新增卡片');
  assert.equal(cards[0].status, TOOL_CARD_STATUS.DONE);
  assert.equal(cards[0].error, '');
});

test('applyToolEvent：同一轮同名工具调两次 = 两张卡（读了三遍同一个文件本身是信息）', () => {
  let cards = [];
  cards = applyToolEvent(cards, { phase: 'start', name: 'read_workspace_file', round: 1, args: { path: 'a.js' } });
  cards = applyToolEvent(cards, { phase: 'end', name: 'read_workspace_file', round: 1, ok: true });
  cards = applyToolEvent(cards, { phase: 'start', name: 'read_workspace_file', round: 1, args: { path: 'b.js' } });
  cards = applyToolEvent(cards, { phase: 'end', name: 'read_workspace_file', round: 1, ok: true });
  assert.equal(cards.length, 2);
  assert.notEqual(cards[0].id, cards[1].id, 'id 必须唯一（React key）');
  assert.equal(cards[0].summary, 'a.js');
  assert.equal(cards[1].summary, 'b.js');
  // end 只吃掉最近一张 running，不会把已完成的卡改回去
  assert.deepEqual(cards.map(c => c.status), [TOOL_CARD_STATUS.DONE, TOOL_CARD_STATUS.DONE]);
});

test('applyToolEvent：失败带错误摘要；不同轮次不串台', () => {
  let cards = [];
  cards = applyToolEvent(cards, { phase: 'start', name: 'run_shell', round: 1, args: { command: 'ls' } });
  cards = applyToolEvent(cards, { phase: 'start', name: 'run_shell', round: 2, args: { command: 'pwd' } });
  assert.equal(cards.length, 2);
  // 第 2 轮的 end 只能改第 2 轮那张
  cards = applyToolEvent(cards, { phase: 'end', name: 'run_shell', round: 2, ok: false, error: '权限不足' });
  assert.equal(cards[0].status, TOOL_CARD_STATUS.RUNNING, '第 1 轮不受影响');
  assert.equal(cards[1].status, TOOL_CARD_STATUS.ERROR);
  assert.equal(cards[1].error, '权限不足');
});

test('applyToolEvent：没有配对 start 的 end 一律忽略（不凭空补卡，否则「哪一步真跑了」不可信）', () => {
  const cards = [{ id: '1-x-0', name: 'x', round: 1, status: TOOL_CARD_STATUS.DONE, summary: '', error: '' }];
  assert.deepEqual(applyToolEvent(cards, { phase: 'end', name: 'x', round: 1, ok: true }), cards);
  assert.deepEqual(applyToolEvent(cards, { phase: 'end', name: 'never-started', round: 9, ok: true }), cards);
});

test('applyToolEvent：坏输入不抛，且不就地改入参（React 依赖不可变更新）', () => {
  const cards = [];
  assert.deepEqual(applyToolEvent(cards, null), cards);
  assert.deepEqual(applyToolEvent(cards, { phase: 'start' }), cards, '没有工具名 = 不建卡');
  assert.deepEqual(applyToolEvent(cards, { phase: 'weird', name: 'run_shell' }), cards);
  // 入参不是数组：当作空列表处理，合法事件照常建卡
  assert.equal(applyToolEvent(null, { phase: 'start', name: 'run_shell' }).length, 1);
  assert.deepEqual(applyToolEvent(null, { phase: 'end', name: 'run_shell' }), []);

  const before = [{ id: 'a', name: 'run_shell', round: 1, status: TOOL_CARD_STATUS.RUNNING, summary: '', error: '' }];
  const snapshot = JSON.parse(JSON.stringify(before));
  const after = applyToolEvent(before, { phase: 'end', name: 'run_shell', round: 1, ok: true });
  assert.deepEqual(before, snapshot, '入参数组未被就地修改');
  assert.notEqual(after, before, '返回新数组');
  assert.notEqual(after[0], before[0], '被改的那张是新对象');
});

test('summarizeToolCards：统计运行中/失败/完成（界面据此决定折叠与文案）', () => {
  const cards = [
    { status: TOOL_CARD_STATUS.DONE },
    { status: TOOL_CARD_STATUS.ERROR },
    { status: TOOL_CARD_STATUS.RUNNING },
    { status: TOOL_CARD_STATUS.RUNNING },
  ];
  assert.deepEqual(summarizeToolCards(cards), { total: 4, running: 2, failed: 1, done: 1 });
  assert.deepEqual(summarizeToolCards(null), { total: 0, running: 0, failed: 0, done: 0 });
  assert.deepEqual(summarizeToolCards([null, undefined]), { total: 0, running: 0, failed: 0, done: 0 });
});
