// 供应商 prompt 缓存（Z 系采纳点 #1）：分节 → 缓存断点 → 各协议落地。
// 关键不变量：不支持的协议（OpenAI 兼容）绝不能泄漏内部字段；Anthropic 才打 cache_control；
// 组装文本与分节前逐字节一致。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRequestMessages } from '../src/prompt/chatPipeline.js';
import { toAnthropicRequest, toOpenAiMessages } from '../src/apiProtocols/messages.js';
import { buildRequestBody } from '../src/apiProtocols/body.js';

const character = { name: '测试角色', systemPrompt: '你是测试角色。', regexScripts: [] };

// prefix/rest 是**两块文本**，拼接规则与 chunk 一致：rest 非空时空一行相接
//（与 buildSystemChunks 的 join('\n\n') 同一口径；rest 为空时不应再补分隔符）。
const rejoin = cache => (cache.restText ? `${cache.prefixText}\n\n${cache.restText}` : cache.prefixText);

test('系统提示携带缓存计划：前缀 + 其余拼回原文', () => {
  const messages = buildRequestMessages({
    character,
    historyMessages: [],
    userText: '你好',
    summaryText: '一段摘要',
  });
  const system = messages.find(m => m.role === 'system');
  assert.ok(system.systemCache, '应带 systemCache');
  const { prefixText } = system.systemCache;
  // P1（2026-10-11）：断点落在**最后一个 stable 块**上（SECTION_ORDER 里 format 恒 stable
  // 且恒在最后），所以它之前的动态段（记忆摘要）也一并进缓存前缀——这正是本用例钉住的行为。
  // （早期注释写作「最长 stable 连续段」是措辞不准：真实分节里 summary 夹在 base 与 format
  //  之间，按「最长连续段」切只会缓存 base 那一小段，与本用例的期望相反。）
  assert.ok(prefixText.includes('你的名字是测试角色。'), '稳定段在缓存前缀里');
  assert.ok(prefixText.includes('[记忆摘要]'), '断点之前的动态段也进前缀（按块打标）');
  assert.equal(rejoin(system.systemCache), system.content, '拼回与原文一致');
});

test('首段是动态内容（时间感知）时，断点落在后面的稳定段上（P1：不再放弃缓存）', () => {
  const messages = buildRequestMessages({
    character,
    historyMessages: [],
    userText: '你好',
    currentTimeText: '[当前时间] 2026-10-10 12:00',
  });
  const system = messages.find(m => m.role === 'system');
  assert.ok(system.content.startsWith('[当前时间]'), '时间行仍在最前（顺序未变）');
  // 旧行为：首段动态 → breakIndex 0 → 一个断点都不打（base/persona/format 永远进不了缓存）。
  // 现在取最长 stable 连续段（base+persona+format），断点落在它末尾。
  assert.ok(system.systemCache, '有稳定段就必须带缓存计划');
  assert.ok(system.systemCache.prefixText.includes('你的名字是测试角色。'), '稳定段进了可缓存前缀');
  assert.ok(system.systemCache.prefixText.startsWith('[当前时间]'), '断点之前的动态段一并进前缀（按块打标）');
  assert.equal(rejoin(system.systemCache), system.content, '切分后拼回原文逐字节一致');
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

test('toOpenAiMessages 剥掉内部字段（systemCache / isError 都不泄漏给端点）', () => {
  const out = toOpenAiMessages([
    { role: 'system', content: 'S', systemCache: { prefixText: 'P', restText: 'R' } },
    { role: 'user', content: 'hi' },
    // agent 工具结果的权威错误标记：只服务展示层判状态，协议里没有这个字段。
    { role: 'tool', tool_call_id: 'c1', content: '文件不存在：x', isError: true },
  ]);
  assert.equal('systemCache' in out[0], false);
  assert.equal(out[0].content, 'S');
  assert.equal(out[1].content, 'hi');
  assert.equal('isError' in out[2], false, 'isError 是内部字段，不得进请求体');
  assert.equal(out[2].content, '文件不存在：x', '正文原样保留');
  assert.equal(out[2].tool_call_id, 'c1');
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

test('端到端：真实分节结果经 Anthropic 转换后带缓存断点（断点在稳定块上）', () => {
  const messages = buildRequestMessages({
    character,
    historyMessages: [],
    userText: '你好',
    summaryText: '摘要',
  });
  const body = buildRequestBody({ protocol: 'anthropic', model: 'm', messages });
  assert.ok(Array.isArray(body.system));
  // P1（2026-10-11）：断点落在**稳定块**上（base+persona+format），它之前的动态段
  // （摘要等）也一并进缓存前缀——这正是「有世界书/有摘要时也吃得到缓存」的关键。
  const marked = body.system.filter(block => block.cache_control);
  assert.equal(marked.length, 1, '只打一个 system 断点');
  assert.equal(marked[0].cache_control.type, 'ephemeral');
  // 断点落在**最长 stable 连续段**的末尾：这里是 format（[输出格式]）。base/persona
  // 单独一段（长度 1）比不上 format 那段（含标题更长），所以标记块是 format。
  assert.ok(marked[0].text.includes('[输出格式]'), `断点块应是稳定段（format），实际：${marked[0].text.slice(0, 40)}`);
  // 断点之前的内容（base/persona/摘要）都进缓存前缀 —— 它们本来就在 marked 块之前。
  const markedIndex = body.system.indexOf(marked[0]);
  assert.ok(markedIndex > 0, '断点块不是第一块（前面还有 base/persona/摘要）');
  assert.equal(
    body.system.map(block => block.text).join('\n\n'),
    messages.find(m => m.role === 'system').content,
    '块拼接逐字节等于原系统提示'
  );
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
