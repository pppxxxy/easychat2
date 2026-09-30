import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProactiveTask,
  buildProactiveExtraPrompt,
  buildProactiveRequestMessages,
  isFormatDirectiveEntry,
  stripFormatDirectiveEntries,
  PROACTIVE_HISTORY_LIMIT,
} from '../src/proactiveRequest.js';

const character = { name: '小雨', systemPrompt: '你是小雨。', regexScripts: [{ id: 'r1' }] };

test('buildProactiveTask：默认给自然问候', () => {
  const task = buildProactiveTask({ messageType: 'DEFAULT' });
  assert.ok(task.includes('问候'));
});

test('buildProactiveTask：关心心情按类型措辞', () => {
  const task = buildProactiveTask({ messageType: 'CARE' });
  assert.ok(task.includes('关心'));
  assert.ok(task.includes('心情'));
});

test('buildProactiveTask：问好按触发时段选早/中/晚/夜', () => {
  const at = h => buildProactiveTask({ messageType: 'GREETING', now: new Date(2026, 8, 30, h, 0) });
  assert.ok(at(8).includes('早上'));
  assert.ok(at(14).includes('中午'));
  assert.ok(at(20).includes('晚上'));
  assert.ok(at(2).includes('夜里'));
});

test('buildProactiveTask：自定义为空时回退自然问候', () => {
  assert.ok(buildProactiveTask({ messageType: 'CUSTOM', customPrompt: '  ' }).includes('问候'));
  assert.equal(
    buildProactiveTask({ messageType: 'CUSTOM', customPrompt: '问我吃了吗' }),
    '问我吃了吗'
  );
});

test('buildProactiveExtraPrompt：说明是主动发消息并带字数约束', () => {
  const extra = buildProactiveExtraPrompt({ messageType: 'DEFAULT' });
  assert.ok(extra.includes('主动'));
  assert.ok(extra.includes('80 字'));
});

test('主动消息请求：去掉正则脚本，保留角色设定', () => {
  const messages = buildProactiveRequestMessages({ character, historyMessages: [] });
  const system = messages.find(item => item.role === 'system');
  assert.ok(system.content.includes('你是小雨'));
  // 主动消息只要纯文字：不应携带正则脚本产生的替换
  assert.ok(!system.content.includes('[[regex'));
});

test('主动消息请求：带上当前时间（时间感知开启时）', () => {
  const now = new Date(2026, 8, 30, 15, 4);
  const on = buildProactiveRequestMessages({ character, timeAware: true, now });
  const onSystem = on.find(item => item.role === 'system');
  assert.ok(onSystem.content.includes('2026-09-30'));
  const off = buildProactiveRequestMessages({ character, timeAware: false, now });
  const offSystem = off.find(item => item.role === 'system');
  assert.ok(!offSystem.content.includes('2026-09-30'));
});

test('主动消息请求：历史只取最近 N 条且过滤占位/系统错误', () => {
  const history = [];
  for (let i = 0; i < 40; i += 1) {
    history.push({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `第${i}条` });
  }
  history.push({ id: 'pending', role: 'assistant', text: '占位', pending: true });
  history.push({ id: 'err', role: 'system_error', text: '错误' });
  const messages = buildProactiveRequestMessages({ character, historyMessages: history });
  const convo = messages.filter(item => item.role === 'user' || item.role === 'assistant');
  // 最后一条是「（请现在主动开口）」，故对话历史最多 LIMIT + 1
  assert.ok(convo.length <= PROACTIVE_HISTORY_LIMIT + 1);
  assert.ok(!JSON.stringify(messages).includes('占位'));
  assert.ok(!JSON.stringify(messages).includes('错误'));
  // 最近一条历史仍在
  assert.ok(JSON.stringify(messages).includes('第39条'));
});

test('主动消息请求：包含「主动开话题」的补充指令', () => {
  const messages = buildProactiveRequestMessages({ character, messageType: 'CARE' });
  const system = messages.find(item => item.role === 'system');
  assert.ok(system.content.includes('主动'));
});

test('补充指令明确要求忽略格式/状态栏类要求', () => {
  const extra = buildProactiveExtraPrompt({ messageType: 'DEFAULT' });
  assert.ok(extra.includes('忽略'));
  assert.ok(extra.includes('状态栏') || extra.includes('格式'));
});

test('格式模板世界书被识别并从主动消息中剔除', () => {
  // 典型：某角色卡要求「每轮正文末尾必须稳定输出【时间】字段…模板…|分隔」
  const formatEntry = {
    content: '每轮正文末尾必须稳定输出【时间】字段。格式严格按以下模板：\n【时间】日期=2024-09-01|月日=09-01|月份=09|季节=秋',
  };
  const normalEntry = { content: '沈梦凌是班上的学习委员，性格冷静。' };
  assert.equal(isFormatDirectiveEntry(formatEntry), true);
  assert.equal(isFormatDirectiveEntry(normalEntry), false);
  const kept = stripFormatDirectiveEntries([formatEntry, normalEntry]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].content, normalEntry.content);
});

test('主动消息组装时剔除格式模板世界书，保留普通世界书', () => {
  const character2 = {
    name: '小雨',
    systemPrompt: '你是小雨。',
    worldInfo: [
      { constant: true, content: '每轮正文末尾必须附加状态栏。格式严格按以下模板：\n【数值状态栏】好感度：35/200' },
      { constant: true, content: '小雨住在海边小镇。' },
    ],
  };
  const messages = buildProactiveRequestMessages({ character: character2, historyMessages: [] });
  const system = messages.find(item => item.role === 'system');
  assert.ok(system.content.includes('小雨住在海边小镇'));
  assert.ok(!system.content.includes('数值状态栏'));
  assert.ok(!system.content.includes('35/200'));
});
