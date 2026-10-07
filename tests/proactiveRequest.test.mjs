import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProactiveTask,
  buildProactiveExtraPrompt,
  buildProactiveRequestMessages,
  isFormatDirectiveEntry,
  stripFormatDirectiveEntries,
  PROACTIVE_HISTORY_LIMIT,
  PROACTIVE_TIME_TOKEN,
  PROACTIVE_MAX_TOKENS,
  PROACTIVE_TEMPERATURE,
  buildProactiveRequestBody,
  buildProactiveAuthSettings,
  buildProactiveEndpoint,
} from '../src/proactive/proactiveRequest.js';

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

test('buildProactiveTask：问好类型不固化时段，交给触发时刻判断', () => {
  const task = buildProactiveTask({ messageType: 'GREETING' });
  // 快照在保存后数天触发：不得出现保存时段（曾把保存时段烘进快照导致早上说"夜里的问好"）
  assert.ok(task.includes('贴合发送时刻'));
  assert.ok(task.includes('当前时间'));
  for (const stale of ['早上', '中午', '晚上', '夜里']) {
    assert.ok(!task.includes(`${stale}的问好`), `不得固化时段：${stale}`);
  }
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

test('主动消息请求：时间感知写占位符，不固化保存时刻', () => {
  const now = new Date(2026, 8, 30, 15, 4);
  const on = buildProactiveRequestMessages({ character, timeAware: true, now });
  const onSystem = on.find(item => item.role === 'system');
  // 占位符由原生在触发时替换；保存时刻不得出现在快照里
  assert.ok(onSystem.content.includes(PROACTIVE_TIME_TOKEN));
  assert.ok(!onSystem.content.includes('2026-09-30'));
  assert.ok(onSystem.content.startsWith(PROACTIVE_TIME_TOKEN), '占位符应位于系统提示开头，与聊天时间行同位');
  const off = buildProactiveRequestMessages({ character, timeAware: false, now });
  const offSystem = off.find(item => item.role === 'system');
  assert.ok(!offSystem.content.includes(PROACTIVE_TIME_TOKEN));
  assert.ok(!offSystem.content.includes('2026-09-30'));
});

test('主动消息请求：作息规则静态写入快照，不含具体时间戳', () => {
  const messages = buildProactiveRequestMessages({
    character,
    timeAware: true,
    scheduleText: '[角色作息] 起床 07:00 · 上班 09:00 · 下班 18:00 · 睡觉 23:00。\n- 睡眠时段：像「我也还没睡」。',
  });
  const system = messages.find(item => item.role === 'system');
  assert.ok(system.content.includes('起床 07:00'), '作息写入系统提示');
  assert.ok(system.content.includes('我也还没睡'));
  // 静态文本：不含具体日期（主动消息快照会在未来任意时刻触发）
  assert.equal(/20\d\d-\d\d-\d\d/.test(system.content.replace(PROACTIVE_TIME_TOKEN, '')), false);
  // 未传 scheduleText 时不注入
  const plain = buildProactiveRequestMessages({ character });
  assert.equal(plain.find(item => item.role === 'system').content.includes('角色作息'), false);
});

test('主动消息请求：历史只取最近 N 条且过滤占位/系统错误', () => {  const history = [];
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

test('buildProactiveRequestBody：openai 形态带 model 与生成参数', () => {
  const messages = [{ role: 'system', content: '你是小雨。' }, { role: 'user', content: '（请现在主动开口）' }];
  const body = buildProactiveRequestBody({ protocol: 'openai', model: 'deepseek-chat', messages });
  assert.equal(body.model, 'deepseek-chat');
  assert.deepEqual(body.messages, messages);
  assert.equal(body.max_tokens, PROACTIVE_MAX_TOKENS);
  assert.equal(body.temperature, PROACTIVE_TEMPERATURE);
});

test('buildProactiveRequestBody：anthropic 抽顶层 system 且必带 max_tokens', () => {
  const messages = [
    { role: 'system', content: `你是小雨。${PROACTIVE_TIME_TOKEN}` },
    { role: 'user', content: '（请现在主动开口）' },
  ];
  const body = buildProactiveRequestBody({ protocol: 'anthropic', model: 'claude-x', messages });
  assert.equal(body.model, 'claude-x');
  assert.ok(body.system.includes(PROACTIVE_TIME_TOKEN), 'system 顶层必须保留时间占位符（原生整串替换的前提）');
  assert.equal(body.max_tokens, PROACTIVE_MAX_TOKENS, 'anthropic 的 max_tokens 必填');
  assert.equal(body.temperature, PROACTIVE_TEMPERATURE);
  assert.ok(Array.isArray(body.messages) && body.messages.every(m => m.role !== 'system'), 'system 不得残留在 messages');
  assert.equal(body.stream, undefined, '后台主动消息不走流式');
});

test('buildProactiveRequestBody：responses 走 instructions/input 且 store=false', () => {
  const messages = [
    { role: 'system', content: `你是小雨。${PROACTIVE_TIME_TOKEN}` },
    { role: 'user', content: '（请现在主动开口）' },
  ];
  const body = buildProactiveRequestBody({ protocol: 'openai-responses', model: 'gpt-5', messages });
  assert.equal(body.model, 'gpt-5');
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, PROACTIVE_MAX_TOKENS);
  assert.ok(body.instructions.includes(PROACTIVE_TIME_TOKEN), 'instructions 必须保留时间占位符');
  assert.ok(Array.isArray(body.input) && body.input.length >= 1);
  assert.equal(body.messages, undefined, 'responses 没有 messages 字段');
});

test('buildProactiveAuthSettings：按协议给默认鉴权头并尊重配置覆盖', () => {
  const openai = buildProactiveAuthSettings({ protocol: 'openai', config: { authHeader: '', authScheme: null } });
  assert.equal(openai.protocol, 'openai');
  assert.equal(openai.authHeader, 'Authorization');
  assert.equal(openai.authScheme, 'Bearer ');
  assert.deepEqual(openai.extraHeaders, {});

  const anthropic = buildProactiveAuthSettings({ protocol: 'anthropic', config: { authScheme: null } });
  assert.equal(anthropic.protocol, 'anthropic');
  assert.equal(anthropic.authHeader, 'x-api-key');
  assert.equal(anthropic.authScheme, '');
  assert.equal(anthropic.extraHeaders['anthropic-version'], '2023-06-01', 'anthropic 必须带版本头');

  const custom = buildProactiveAuthSettings({
    protocol: 'anthropic',
    config: { authHeader: 'api-key', authScheme: '', anthropicVersion: '2040-01-01' },
  });
  assert.equal(custom.authHeader, 'api-key', '用户自定义头优先');
  assert.equal(custom.extraHeaders['anthropic-version'], '2040-01-01', '版本可覆盖');

  // 非法协议归一为 openai，不会抛错
  assert.equal(buildProactiveAuthSettings({ protocol: 'unknown', config: null }).protocol, 'openai');
});

test('buildProactiveEndpoint：按协议补端点', () => {
  assert.equal(buildProactiveEndpoint('openai', 'https://api.x.com'), 'https://api.x.com/v1/chat/completions');
  assert.equal(buildProactiveEndpoint('anthropic', 'https://api.x.com'), 'https://api.x.com/v1/messages');
  assert.equal(buildProactiveEndpoint('openai-responses', 'https://api.x.com'), 'https://api.x.com/v1/responses');
});
