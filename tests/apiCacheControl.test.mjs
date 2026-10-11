// P1-1：Anthropic 显式缓存断点（cache_control）——纯函数 + 请求体集成。
//
// 断点策略是「省钱的承诺」：打在哪、打几个、TTL 多长都要能被测试钉住，否则一次
// 顺手改动（比如把断点挪到最新一条消息上）会让缓存永远 miss 而没人发现。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CACHE_BREAKPOINT_MAX,
  DEFAULT_PROMPT_CACHE_TTL,
  PROMPT_CACHE_TTLS,
  applyAnthropicCacheControl,
  cacheControlFor,
  isPromptCacheEnabled,
  normalizePromptCacheTtl,
} from '../src/apiProtocols/cacheControl.js';
import { buildRequestBody } from '../src/apiProtocols.js';

test('normalizePromptCacheTtl：off / 1h / 5m 三态，非法与缺失回落默认', () => {
  assert.deepEqual([...PROMPT_CACHE_TTLS], ['off', '5m', '1h']);
  assert.equal(DEFAULT_PROMPT_CACHE_TTL, '5m');
  for (const value of ['off', 'OFF', ' none ', 'false', '0']) {
    assert.equal(normalizePromptCacheTtl(value), 'off', `${value} → 关闭`);
  }
  for (const value of ['1h', '1H', 'hour', '60m']) {
    assert.equal(normalizePromptCacheTtl(value), '1h', `${value} → 1 小时`);
  }
  for (const value of ['5m', '', undefined, null, '随便什么', 42]) {
    assert.equal(normalizePromptCacheTtl(value), '5m', `${String(value)} → 默认 5 分钟`);
  }
  assert.equal(isPromptCacheEnabled('off'), false);
  assert.equal(isPromptCacheEnabled('1h'), true);
  assert.equal(isPromptCacheEnabled(undefined), true, '默认开启：不配置也该吃到缓存收益');
});

test('cacheControlFor：5m 不带 ttl 字段（服务端默认），1h 显式带；关闭返回 null', () => {
  assert.deepEqual(cacheControlFor('5m'), { type: 'ephemeral' });
  assert.deepEqual(cacheControlFor('1h'), { type: 'ephemeral', ttl: '1h' });
  assert.equal(cacheControlFor('off'), null);
});

test('applyAnthropicCacheControl：system 尾 / tools 尾 / 历史稳定前缀三处断点，且不改入参', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
    { role: 'assistant', content: [{ type: 'text', text: '第一轮回复' }] },
    { role: 'user', content: [{ type: 'text', text: '本轮提问' }] },
  ];
  const tools = [{ name: 'a' }, { name: 'b' }];
  const snapshot = JSON.parse(JSON.stringify({ messages, tools }));
  const result = applyAnthropicCacheControl({ system: '你是助手', messages, tools, ttl: '5m' });

  assert.deepEqual(result.system, [{ type: 'text', text: '你是助手', cache_control: { type: 'ephemeral' } }]);
  assert.equal('cache_control' in result.tools[0], false, '只标最后一个工具');
  assert.deepEqual(result.tools[1].cache_control, { type: 'ephemeral' });
  assert.deepEqual(
    result.messages[1].content[0].cache_control,
    { type: 'ephemeral' },
    '断点在倒数第二条（历史稳定前缀）上'
  );
  assert.equal('cache_control' in result.messages[2].content[0], false, '最新一条不打断点：它每轮都变');
  assert.equal(result.breakpoints, 3);
  assert.ok(result.breakpoints <= CACHE_BREAKPOINT_MAX, '不超过 Anthropic 上限');
  assert.deepEqual({ messages, tools }, snapshot, '纯函数：入参未被就地修改');
});

test('applyAnthropicCacheControl：没有历史 / 没有工具 / 没有 system 时如实少打断点', () => {
  const single = applyAnthropicCacheControl({
    system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: '只有一条' }] }],
    tools: null,
    ttl: '5m',
  });
  assert.equal(single.breakpoints, 1, '只有 system 一个断点');
  assert.equal('cache_control' in single.messages[0].content[0], false);

  const noSystem = applyAnthropicCacheControl({
    system: '   ',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }],
    tools: [],
    ttl: '1h',
  });
  assert.equal(noSystem.system, '   ', '空 system 原样返回');
  assert.equal(noSystem.breakpoints, 1);
  assert.deepEqual(noSystem.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });

  const off = applyAnthropicCacheControl({ system: 's', messages: [], tools: [], ttl: 'off' });
  assert.equal(off.breakpoints, 0);
  assert.equal(off.system, 's', '关闭时逐字原样返回');
});

test('buildRequestBody：anthropic 打断点、off 时不打、OpenAI 系一律不打', () => {
  const messages = [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: '第一轮回复' },
    { role: 'user', content: '本轮提问' },
  ];
  const tools = [{ type: 'function', function: { name: 'run_shell', description: 'x', parameters: { type: 'object', properties: {} } } }];
  const build = config => buildRequestBody({
    protocol: 'anthropic',
    model: 'claude-x',
    messages,
    stream: false,
    tools,
    samplingParams: {},
    config,
  });

  const cached = build({ promptCacheTtl: '5m' });
  assert.ok(Array.isArray(cached.system), 'system 转成块数组才能挂断点');
  assert.deepEqual(cached.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(cached.tools[cached.tools.length - 1].cache_control, { type: 'ephemeral' });
  const history = cached.messages[cached.messages.length - 2];
  assert.deepEqual(history.content[history.content.length - 1].cache_control, { type: 'ephemeral' });
  assert.equal('cache_control' in cached.messages[cached.messages.length - 1].content[0], false);

  const off = build({ promptCacheTtl: 'off' });
  assert.equal(typeof off.system, 'string', '关闭时保持字符串形态（与加这个特性之前逐字一致）');
  assert.equal(JSON.stringify(off).includes('cache_control'), false);

  const ttl1h = build({ promptCacheTtl: '1h' });
  assert.deepEqual(ttl1h.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });

  // 缺 config（老调用方）：默认 5m——不配置也该吃到缓存收益。
  assert.deepEqual(build(undefined).system[0].cache_control, { type: 'ephemeral' });

  const openai = buildRequestBody({
    protocol: 'openai',
    model: 'gpt-x',
    messages,
    tools,
    samplingParams: {},
    config: { promptCacheTtl: '1h' },
  });
  assert.equal(JSON.stringify(openai).includes('cache_control'), false, 'OpenAI 系自动缓存，不打断点');
});
