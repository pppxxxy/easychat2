// 共享黑板（agent 团队通信）测试。
//
// 覆盖：纯逻辑（归一/发布/读取/有界/格式化/提示词）+ 工具（board_post/board_read 有无黑板）
// + runSubagent 注入（extraTools 放行 board_post、ctx.board 传下去；不注入则被白名单挡下）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLACKBOARD_MAX_TOPICS,
  BLACKBOARD_MAX_ENTRIES,
  BLACKBOARD_TEXT_MAX,
  createBlackboard,
  normalizeTopic,
  formatBoardMessages,
  boardPromptSuffix,
  boardTopics,
} from '../src/agent/blackboard.js';
import {
  BOARD_POST_TOOL_DEFINITION,
  BOARD_READ_TOOL_DEFINITION,
} from '../src/workspace/toolDefs/boardTools.js';
import { runSubagent } from '../src/agent/subagent.js';

test('normalizeTopic：大小写与空白归一、空值、截断', () => {
  assert.equal(normalizeTopic('  用户 列表 '), '用户-列表');
  assert.equal(normalizeTopic('A\tB\nC'), 'a-b-c');
  assert.equal(normalizeTopic(''), '');
  assert.equal(normalizeTopic(null), '');
  assert.equal(normalizeTopic('x'.repeat(200)).length, 64);
});

test('黑板 post/read：序号递增、latest、增量 since、topics 排序', () => {
  const board = createBlackboard();
  const a = board.post({ topic: '结论', from: 'task-1', text: 'A 查完' });
  const b = board.post({ topic: '结论', from: 'task-2', text: 'B 查完' });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  board.post({ topic: '风险', text: 'x' });
  const all = board.read({ topic: '结论' });
  assert.equal(all.messages.length, 2);
  assert.equal(all.latest, 2);
  assert.equal(all.messages[1].from, 'task-2');
  const inc = board.read({ topic: '结论', since: 1 });
  assert.equal(inc.messages.length, 1);
  assert.equal(inc.messages[0].text, 'B 查完');
  assert.deepEqual(board.topics(), ['结论', '风险']);
});

test('黑板有界：空 topic/text 拒绝、每主题条数滚出旧条、单条截断、主题上限', () => {
  const board = createBlackboard();
  assert.equal(board.post({ topic: '', text: 'x' }).ok, false);
  assert.equal(board.post({ topic: 't', text: '   ' }).ok, false);
  const long = board.post({ topic: 't', text: 'y'.repeat(BLACKBOARD_TEXT_MAX + 500) });
  assert.equal(long.ok, true);
  assert.equal(board.read({ topic: 't' }).messages[0].text.length, BLACKBOARD_TEXT_MAX);
  for (let i = 0; i < BLACKBOARD_MAX_ENTRIES + 5; i += 1) board.post({ topic: 't', text: `m${i}` });
  assert.equal(board.read({ topic: 't' }).messages.length, BLACKBOARD_MAX_ENTRIES);
  const fresh = createBlackboard();
  for (let i = 0; i < BLACKBOARD_MAX_TOPICS; i += 1) assert.equal(fresh.post({ topic: `t${i}`, text: 'x' }).ok, true);
  assert.equal(fresh.post({ topic: 'overflow', text: 'x' }).ok, false);
  assert.equal(fresh.post({ topic: 't0', text: 'x' }).ok, true, '已有主题仍可写');
});

test('formatBoardMessages：空主题提示、正常拼接、超长截断', () => {
  assert.ok(formatBoardMessages('t', []).includes('暂无消息'));
  const text = formatBoardMessages('t', [{ seq: 1, from: 'a', text: 'hi' }]);
  assert.ok(text.includes('[1] a：hi'));
  const huge = formatBoardMessages('t', [{ seq: 1, from: 'a', text: 'z'.repeat(20000) }]);
  assert.ok(huge.includes('已截断'));
});

test('boardPromptSuffix：提到两个工具名', () => {
  const suffix = boardPromptSuffix();
  assert.ok(suffix.includes('board_post') && suffix.includes('board_read'));
});

test('boardTopics：归纳成 [{ topic, messages }]（查看器用）；空/坏输入安全', () => {
  const board = createBlackboard();
  board.post({ topic: '结论', from: 'task-1', text: 'A' });
  board.post({ topic: '风险', from: 'task-2', text: 'B' });
  const topics = boardTopics(board);
  assert.equal(topics.length, 2);
  const conclusion = topics.find(item => item.topic === '结论');
  assert.equal(conclusion.messages[0].text, 'A');
  assert.equal(conclusion.messages[0].from, 'task-1');
  assert.deepEqual(boardTopics(null), []);
  assert.deepEqual(boardTopics({}), []);
});

test('黑板播种与序列化：serialize → createBlackboard({ initial }) 往返、序号续接、坏数据不崩', () => {
  const first = createBlackboard();
  first.post({ topic: '结论', from: 'task-1', text: 'A' });
  first.post({ topic: '结论', from: 'task-2', text: 'B' });
  first.post({ topic: '风险', text: 'C' });
  const data = first.serialize();
  assert.equal(data.version, 1);
  const second = createBlackboard({ initial: data });
  assert.deepEqual(second.topics(), ['结论', '风险']);
  assert.equal(second.read({ topic: '结论' }).messages.length, 2);
  assert.equal(second.read({ topic: '风险' }).messages[0].text, 'C');
  // 序号续接：播种后新发布从更大的 seq 继续（不覆盖历史）
  assert.equal(second.post({ topic: '结论', text: 'D' }).seq, 4);
  // 坏 initial 不崩、空文本条目被丢弃
  assert.equal(createBlackboard({ initial: 'nonsense' }).size(), 0);
  assert.equal(createBlackboard({ initial: { topics: { t: [{ text: '   ' }] } } }).size(), 0);
  assert.equal(createBlackboard({ initial: { topics: null } }).size(), 0);
});

test('board 工具：无黑板时报错；有黑板时发布/读取（署名 agentName）', () => {
  const noBoard = BOARD_POST_TOOL_DEFINITION.execute({}, { topic: 't', text: 'x' }, {});
  assert.equal(noBoard.isError, true);
  assert.equal(BOARD_READ_TOOL_DEFINITION.execute({}, { topic: 't' }, {}).isError, true);

  const board = createBlackboard();
  const posted = BOARD_POST_TOOL_DEFINITION.execute({}, { topic: '结论', text: 'hi' }, { board, agentName: 'task-1' });
  assert.equal(posted.isError, undefined);
  assert.equal(board.read({ topic: '结论' }).messages[0].from, 'task-1');
  const read = BOARD_READ_TOOL_DEFINITION.execute({}, { topic: '结论' }, { board });
  assert.ok(read.content.includes('hi'));
});

function fakeStreamFor(rounds) {
  let round = 0;
  return async () => {
    const next = rounds[round] || { text: '结论：完成', toolCalls: [] };
    round += 1;
    return next;
  };
}

test('runSubagent 注入黑板：extraTools 放行 board_post、ctx.board 传下去', async () => {
  const board = createBlackboard();
  const stream = fakeStreamFor([
    { text: '', toolCalls: [{ id: 'c1', name: 'board_post', arguments: JSON.stringify({ topic: '结论', text: 'A 查完' }) }] },
  ]);
  const result = await runSubagent({
    task: '查 A',
    tools: [BOARD_POST_TOOL_DEFINITION],
    store: {},
    stream,
    board,
    extraTools: [BOARD_POST_TOOL_DEFINITION],
    agentName: 'task-1',
  });
  assert.ok(result.content.includes('完成'));
  const read = board.read({ topic: '结论' });
  assert.equal(read.messages.length, 1);
  assert.equal(read.messages[0].from, 'task-1');
  assert.equal(read.messages[0].text, 'A 查完');
});

test('runSubagent 未注入 extraTools：board_post 被名字白名单挡下（黑板不被污染）', async () => {
  const board = createBlackboard();
  const readTool = {
    name: 'read_workspace_file', description: 'read', parameters: { type: 'object', properties: {} },
    readOnly: true, execute: async () => 'x',
  };
  const stream = fakeStreamFor([
    { text: '', toolCalls: [{ id: 'c1', name: 'board_post', arguments: JSON.stringify({ topic: 't', text: 'hi' }) }] },
  ]);
  const result = await runSubagent({
    task: 'x',
    tools: [readTool, BOARD_POST_TOOL_DEFINITION],
    store: {},
    stream,
    board,
  });
  assert.ok(result.content.includes('完成'), '被挡下后仍能出结论');
  assert.equal(board.read({ topic: 't' }).messages.length, 0, '白名单外的 board_post 不得写入黑板');
});
