// 供应商 prompt 缓存（Z 系采纳点 #1）：分节 → 缓存断点 → 各协议落地。
// 关键不变量：不支持的协议（OpenAI 兼容）绝不能泄漏内部字段；Anthropic 才打 cache_control；
// 组装文本与分节前逐字节一致。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRequestMessages } from '../src/prompt/chatPipeline.js';
import { toAnthropicRequest, toOpenAiMessages } from '../src/apiProtocols/messages.js';
import { buildRequestBody } from '../src/apiProtocols/body.js';

const character = { name: '测试角色', systemPrompt: '你是测试角色。', regexScripts: [] };

test('系统提示携带缓存计划：前缀 + 其余拼回原文', () => {
  const messages = buildRequestMessages({
    character,
    historyMessages: [],
    userText: '你好',
    summaryText: '一段摘要',
  });
  const system = messages.find(m => m.role === 'system');
  assert.ok(system.systemCache, '应带 systemCache');
  const { prefixText, restText } = system.systemCache;
  assert.ok(prefixText.startsWith('你的名字是测试角色。'), '稳定前缀从 base 起');
  // 摘要（动态）之后才是其余段，且拼回与原文一致
  assert.ok(restText.includes('[记忆摘要]'));
  assert.equal(`${prefixText}\n\n${restText}`, system.content);
});

test('首段是动态内容（时间感知）时不打缓存计划', () => {
  const messages = buildRequestMessages({
    character,
    historyMessages: [],
    userText: '你好',
    currentTimeText: '[当前时间] 2026-10-10 12:00',
  });
  const system = messages.find(m => m.role === 'system');
  assert.equal(system.systemCache, undefined, '无可缓存前缀时零标记');
  assert.ok(system.content.startsWith('[当前时间]'), '时间行仍在最前（顺序未变）');
});

test('无缓存计划时 Anthropic system 仍是字符串（零行为变化）', () => {
  const { system } = toAnthropicRequest([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(system, 'SYS');
});

test('带缓存计划时 Anthropic system 用 block 数组，前缀块带 ephemeral', () => {
  const { system } = toAnthropicRequest([
    { role: 'system', content: 'P\n\nR', systemCache: { prefixText: 'P', restText: 'R' } },
    { role: 'user', content: 'hi' },
  ]);
  assert.ok(Array.isArray(system));
  assert.equal(system.length, 2);
  assert.deepEqual(system[0], { type: 'text', text: 'P', cache_control: { type: 'ephemeral' } });
  assert.deepEqual(system[1], { type: 'text', text: 'R' });
});

test('toOpenAiMessages 剥掉内部 systemCache（不泄漏给端点）', () => {
  const out = toOpenAiMessages([
    { role: 'system', content: 'S', systemCache: { prefixText: 'P', restText: 'R' } },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal('systemCache' in out[0], false);
  assert.equal(out[0].content, 'S');
  assert.equal(out[1].content, 'hi');
});

test('buildRequestBody：anthropic 出 block 数组，openai 无内部字段', () => {
  const messages = [
    { role: 'system', content: 'P\n\nR', systemCache: { prefixText: 'P', restText: 'R' } },
    { role: 'user', content: 'hi' },
  ];
  const anthropic = buildRequestBody({ protocol: 'anthropic', model: 'm', messages });
  assert.ok(Array.isArray(anthropic.system));
  assert.equal(anthropic.system[0].cache_control.type, 'ephemeral');

  const openai = buildRequestBody({ protocol: 'openai', model: 'm', messages });
  assert.equal('systemCache' in openai.messages[0], false);
});

test('端到端：真实分节结果经 Anthropic 转换后带缓存断点', () => {
  const messages = buildRequestMessages({
    character,
    historyMessages: [],
    userText: '你好',
    summaryText: '摘要',
  });
  const body = buildRequestBody({ protocol: 'anthropic', model: 'm', messages });
  assert.ok(Array.isArray(body.system));
  assert.equal(body.system[0].cache_control.type, 'ephemeral');
  assert.ok(body.system[0].text.startsWith('你的名字是测试角色。'));
});

test('缓存合并（Z 稳定前缀 + D 骨架）：off 不打标；默认时 system 与 tools 断点共存', () => {
  const messages = [
    { role: 'system', content: 'P\n\nR', systemCache: { prefixText: 'P', restText: 'R' } },
    { role: 'user', content: 'hi' },
  ];
  const tools = [{ type: 'function', function: { name: 't', description: '', parameters: {} } }];
  // off：TTL 开关生效——system 前缀块不打标（网关不认这字段时的逃生舱）。
  const off = buildRequestBody({
    protocol: 'anthropic', model: 'm', messages, tools, config: { promptCacheTtl: 'off' },
  });
  assert.ok(Array.isArray(off.system));
  assert.equal('cache_control' in off.system[0], false, 'off 时系统块不打标');
  assert.equal('cache_control' in off.tools[off.tools.length - 1], false, 'off 时 tools 也不打标');
  // 默认（5m）：system 稳定前缀块带 ephemeral，且 tools 尾也有断点（两套合并后共存）。
  const on = buildRequestBody({ protocol: 'anthropic', model: 'm', messages, tools, config: {} });
  assert.equal(on.system[0].cache_control.type, 'ephemeral', 'system 前缀断点（Z 稳定前缀）');
  assert.equal(on.tools[on.tools.length - 1].cache_control.type, 'ephemeral', 'tools 尾断点（D 骨架）');
});
