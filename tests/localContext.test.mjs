// 本地模型上下文预算纯函数测试。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTextTokens,
  repairToolPairing,
  trimMessagesToContext,
} from '../src/localModel/localContext.js';
import { findOrphanToolMessages } from '../src/agent/resultClearing.js';

test('estimateTextTokens：CJK 计 1/字，其余按 4 字符/token', () => {
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens('你好世界'), 4);
  assert.equal(estimateTextTokens('abcd'), 1);
  assert.equal(estimateTextTokens('abcdefgh'), 2);
});

test('estimateMessageTokens：数组内容含图片/音频模态占用', () => {
  assert.ok(estimateMessageTokens({ role: 'user', content: 'hi' }) >= 4);
  const withImage = estimateMessageTokens({
    role: 'user',
    content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:...' } }],
  });
  assert.ok(withImage >= 256, '图片按固定 token 计入');
});

test('trimMessagesToContext：未超预算原样返回', () => {
  const messages = [
    { role: 'system', content: '人设' },
    { role: 'user', content: '你好' },
  ];
  const result = trimMessagesToContext(messages, { contextSize: 2048 });
  assert.equal(result.removedCount, 0);
  assert.equal(result.messages.length, 2);
});

test('trimMessagesToContext：超预算时保留 system + 最近轮，丢最旧', () => {
  const system = { role: 'system', content: 'system-prompt' };
  const history = [];
  for (let index = 0; index < 40; index += 1) {
    history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: '这是一段较长的历史消息内容'.repeat(3) });
  }
  const messages = [system, ...history];
  const result = trimMessagesToContext(messages, { contextSize: 512, reserveOutputTokens: 128, minKeep: 2 });
  assert.ok(result.removedCount > 0, '必须发生裁剪');
  assert.equal(result.messages[0], system, 'system 恒保留在首位');
  assert.ok(result.messages.includes(history[history.length - 1]), '最新一条保留');
  assert.ok(result.messages.includes(history[history.length - 2]), '至少保留 minKeep 条最近的');
  assert.ok(result.messages.length < messages.length);
});

test('trimMessagesToContext：contextSize<=0 不裁剪', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(10000) }];
  const result = trimMessagesToContext(messages, { contextSize: 0 });
  assert.equal(result.removedCount, 0);
  assert.equal(result.messages.length, 1);
});

test('trimMessagesToContext：即便系统提示超预算也至少保留最后一条 user', () => {
  const messages = [
    { role: 'system', content: '巨大的系统提示'.repeat(100) },
    { role: 'user', content: '第一个问题' },
    { role: 'assistant', content: '答' },
    { role: 'user', content: '最后的问题' },
  ];
  const result = trimMessagesToContext(messages, { contextSize: 128, minKeep: 1 });
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[result.messages.length - 1].content, '最后的问题');
});

test('estimateMessagesTokens：聚合所有消息', () => {
  const total = estimateMessagesTokens([
    { role: 'system', content: 'aaa' },
    { role: 'user', content: '你好' },
  ]);
  assert.ok(total >= 8);
});

// P1 回归（2026-10-11）：裁剪不得拆散 toolUse↔toolResult 配对。
//
// 事故形态：trimMessagesToContext 只按预算丢最旧的**非 system** 消息，完全不看配对。
// 一组 assistant(tool_calls) + tool 结果被切在中间时，留下的孤儿 tool 结果会让
// OpenAI 兼容端点直接 400。在线路径（network/api.js 的 trimOnlineMessages）与本地
// 路径（localModel/adapter.js）共用这条裁剪，所以两边都会炸。
test('P1 回归：超窗裁剪后没有孤儿 tool 消息（配对完整）', () => {
  const system = { role: 'system', content: '人设' };
  // 关键在**逆序收集的边界正好落在一组配对中间**：让 tool 结果足够大（进预算），
  // 而它上面那条 assistant(tool_calls) 恰好放不下 —— 于是 tool 结果被留下、call 被丢掉。
  // （assistant(tool_calls) 自身很便宜：估算只看 content，空的 tool_calls 消息只算开销，
  //   所以必须靠 tool 结果的大小来卡边界。）
  const history = [];
  for (let index = 0; index < 8; index += 1) {
    history.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: '很长的历史内容'.repeat(10) });
  }
  const toolResult = { role: 'tool', tool_call_id: 'call-old', content: '读到的内容'.repeat(20) };
  const lastUser = { role: 'user', content: '最后的问题' };
  history.push({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call-old', function: { name: 'read_workspace_file', arguments: '{}' } }],
  });
  history.push(toolResult);
  history.push(lastUser);

  // 预算取「刚好容纳 system + tool 结果 + 最后一条 user，但容纳不下那条 assistant(tool_calls)」。
  const needed = estimateMessagesTokens([system, toolResult, lastUser]);
  const result = trimMessagesToContext([system, ...history], {
    contextSize: needed,
    reserveOutputTokens: 0,
    minKeep: 1,
  });

  assert.ok(result.removedCount > 0, '前置条件：必须真的发生了裁剪');
  // 前置条件：预算正好卡在这组配对的**中间**——容得下 tool 结果，容不下它上面的
  // assistant(tool_calls)。没有这条，用例可能只是因为整组都被丢而「碰巧」没有孤儿。
  const toolOnly = estimateMessagesTokens([system, toolResult, lastUser]);
  const withCall = toolOnly + estimateMessageTokens({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call-old', function: { name: 'read_workspace_file', arguments: '{}' } }],
  });
  assert.ok(result.budget >= toolOnly, `预算要容得下 tool 结果（budget=${result.budget}，需要 ${toolOnly}）`);
  assert.ok(result.budget < withCall, `预算要容不下那条 assistant(tool_calls)（budget=${result.budget}，含它需要 ${withCall}）`);
  assert.deepEqual(findOrphanToolMessages(result.messages), [],
    `裁剪后不得有孤儿 tool 消息：${JSON.stringify(findOrphanToolMessages(result.messages))}`);
  assert.equal(result.messages[0], system, 'system 仍恒保留');
  assert.equal(result.messages[result.messages.length - 1].content, '最后的问题', '最新一条仍保留');
  // 保留下来的每一对仍然完整
  const callIds = new Set(result.messages
    .filter(item => item.role === 'assistant' && Array.isArray(item.tool_calls))
    .flatMap(item => item.tool_calls.map(call => call.id)));
  for (const item of result.messages) {
    if (item.role === 'tool') assert.ok(callIds.has(item.tool_call_id), 'tool 结果必须有对应的 call');
  }
});

test('P1 回归：repairToolPairing 丢掉孤儿 tool 结果与缺结果的 tool_calls（两个方向）', () => {
  const orphanResult = [
    { role: 'system', content: 's' },
    { role: 'tool', tool_call_id: 'gone', content: 'x' },
    { role: 'user', content: 'u' },
  ];
  assert.deepEqual(repairToolPairing(orphanResult), [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
  ], '没有对应 call 的 tool 结果要被丢掉');

  const missingResult = [
    { role: 'system', content: 's' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'a', function: { name: 'x', arguments: '{}' } }, { id: 'b', function: { name: 'y', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
    { role: 'user', content: 'u' },
  ];
  assert.deepEqual(repairToolPairing(missingResult), [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
  ], '缺结果的 tool_calls 整条丢掉（不留下半组配对）');

  // 配对完整时原样返回（不误伤）
  const intact = [
    { role: 'system', content: 's' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
  ];
  assert.deepEqual(repairToolPairing(intact), intact);
  assert.deepEqual(repairToolPairing([]), []);
  assert.deepEqual(repairToolPairing(null), []);
});
