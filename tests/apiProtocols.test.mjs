import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRequestBody,
  buildRequestHeaders,
  normalizeProtocol,
  normalizeProtocolUrl,
  parseDataUri,
  parseFinalPayload,
  parseProtocolError,
  parseStreamPayload,
  toAnthropicRequest,
  toResponsesRequest,
} from '../src/apiProtocols.js';

test('normalizeProtocol 归一三协议', () => {
  assert.equal(normalizeProtocol('anthropic'), 'anthropic');
  assert.equal(normalizeProtocol('openai-responses'), 'openai-responses');
  assert.equal(normalizeProtocol('responses'), 'openai-responses');
  assert.equal(normalizeProtocol('openai'), 'openai');
  assert.equal(normalizeProtocol(''), 'openai');
  assert.equal(normalizeProtocol(undefined), 'openai');
});

test('normalizeProtocolUrl 按协议补端点，且尊重已带端点的地址', () => {
  assert.equal(normalizeProtocolUrl('openai', 'https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(normalizeProtocolUrl('openai', 'https://x.test/v1'), 'https://x.test/v1/chat/completions');
  assert.equal(normalizeProtocolUrl('openai', 'https://x.test/v1/chat/completions'), 'https://x.test/v1/chat/completions');

  assert.equal(normalizeProtocolUrl('openai-responses', 'https://api.openai.com/v1'), 'https://api.openai.com/v1/responses');
  assert.equal(normalizeProtocolUrl('openai-responses', 'https://x.test/v1/responses'), 'https://x.test/v1/responses');

  assert.equal(normalizeProtocolUrl('anthropic', 'https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
  assert.equal(normalizeProtocolUrl('anthropic', 'https://x.test/v1/messages'), 'https://x.test/v1/messages');
});

test('buildRequestHeaders 按协议给默认鉴权头', () => {
  const openai = buildRequestHeaders('openai', { apiKey: 'k' });
  assert.equal(openai.Authorization, 'Bearer k');
  assert.equal(openai.Accept, 'text/event-stream');

  const anthropic = buildRequestHeaders('anthropic', { apiKey: 'k' });
  assert.equal(anthropic['x-api-key'], 'k');
  assert.equal(anthropic.Authorization, undefined);
  assert.equal(anthropic['anthropic-version'], '2023-06-01');

  // 显式配置的鉴权头覆盖默认值
  const custom = buildRequestHeaders('anthropic', { apiKey: 'k', authHeader: 'api-key', authScheme: 'Token ' });
  assert.equal(custom['api-key'], 'Token k');
});

test('parseDataUri 解析 base64 / url 两种', () => {
  assert.deepEqual(parseDataUri('data:image/png;base64,AAAA'), { mediaType: 'image/png', isBase64: true, data: 'AAAA' });
  const raw = parseDataUri('data:image/jpeg,%FF');
  assert.equal(raw.isBase64, false);
  assert.equal(parseDataUri('https://x/y.png'), null);
});

test('toAnthropicRequest：system 抽顶层、tool 轮转 tool_result、连续同角色合并', () => {
  const { system, messages } = toAnthropicRequest([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '看图' },
    { role: 'user', content: [{ type: 'text', text: '补充' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
    { role: 'assistant', content: '好的', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } }] },
    { role: 'tool', tool_call_id: 't1', content: '内容' },
  ]);
  assert.equal(system, '你是助手');
  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content.length, 3, '连续两条 user 合并为 3 个块');
  assert.equal(messages[0].content[2].type, 'image');
  assert.equal(messages[0].content[2].source.type, 'base64');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content[1].type, 'tool_use');
  assert.deepEqual(messages[1].content[1].input, { p: 'a' });
  assert.equal(messages[2].role, 'user');
  assert.equal(messages[2].content[0].type, 'tool_result');
  assert.equal(messages[2].content[0].tool_use_id, 't1');
});

test('toAnthropicRequest：开头的 assistant 文本并入 system，保证首轮为 user', () => {
  const { system, messages } = toAnthropicRequest([
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '你好' },
  ]);
  assert.match(system, /开场白/);
  assert.equal(messages[0].role, 'user');
});

test('toResponsesRequest：system→instructions、图片→input_image、函数调用往返正确', () => {
  const { instructions, input } = toResponsesRequest([
    { role: 'system', content: '系统' },
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '结果' },
  ]);
  assert.equal(instructions, '系统');
  assert.equal(input[0].role, 'user');
  assert.equal(input[0].content[0].type, 'input_text');
  assert.equal(input[0].content[1].type, 'input_image');
  assert.equal(input[1].type, 'function_call');
  assert.equal(input[1].call_id, 'c1');
  assert.equal(input[2].type, 'function_call_output');
  assert.equal(input[2].output, '结果');
});

test('buildRequestBody：openai 原样、anthropic 用 max_tokens/system、responses 用 instructions', () => {
  const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }];

  const openai = buildRequestBody({
    protocol: 'openai', model: 'm', messages, stream: true,
    samplingParams: { max_tokens: 100, temperature: 0.5 },
  });
  assert.equal(openai.model, 'm');
  assert.equal(openai.max_tokens, 100);
  assert.equal(openai.messages[0].role, 'system');

  const anthropic = buildRequestBody({
    protocol: 'anthropic', model: 'claude', messages, stream: true,
    samplingParams: { max_tokens: 100 },
  });
  assert.equal(anthropic.system, 'S');
  assert.equal(anthropic.max_tokens, 100);
  assert.equal(anthropic.messages[0].role, 'user');

  const responses = buildRequestBody({
    protocol: 'openai-responses', model: 'gpt', messages, stream: true,
    samplingParams: { max_tokens: 100 },
  });
  assert.equal(responses.instructions, 'S');
  assert.equal(responses.max_output_tokens, 100);
  assert.equal(responses.store, false);
  assert.equal(responses.input[0].role, 'user');
});

test('buildRequestBody：anthropic 开思考时提高 max_tokens 并禁 temperature', () => {
  const body = buildRequestBody({
    protocol: 'anthropic', model: 'claude', messages: [{ role: 'user', content: 'hi' }], stream: true,
    samplingParams: { max_tokens: 500, temperature: 0.7 },
    thinkingSettings: { enabled: true, level: 'high' },
    config: { supportsThinking: true },
  });
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 8192 });
  assert.ok(body.max_tokens > 8192, 'max_tokens 必须大于 budget_tokens');
  assert.equal(body.temperature, undefined);
});

test('buildRequestBody：工具定义按协议转换', () => {
  const tool = { type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object' } } };
  const anthropic = buildRequestBody({
    protocol: 'anthropic', model: 'c', messages: [{ role: 'user', content: 'x' }], tools: [tool], toolChoice: 'auto',
  });
  assert.equal(anthropic.tools[0].name, 'read');
  assert.equal(anthropic.tools[0].input_schema.type, 'object');
  assert.deepEqual(anthropic.tool_choice, { type: 'auto' });

  const responses = buildRequestBody({
    protocol: 'openai-responses', model: 'g', messages: [{ role: 'user', content: 'x' }], tools: [tool], toolChoice: 'required',
  });
  assert.equal(responses.tools[0].type, 'function');
  assert.equal(responses.tools[0].name, 'read');
  assert.equal(responses.tool_choice, 'required');
});

test('parseStreamPayload：三种协议的文本/思考/工具/结束原因', () => {
  // OpenAI chat
  const oa = parseStreamPayload('openai', { choices: [{ delta: { content: '嗨', reasoning_content: '想' }, finish_reason: 'stop' }] });
  assert.equal(oa.text, '嗨');
  assert.equal(oa.reasoning, '想');
  assert.equal(oa.finishReason, 'stop');

  // Responses：文本增量 + 函数调用参数增量 + 完成
  assert.deepEqual(parseStreamPayload('openai-responses', { type: 'response.output_text.delta', delta: '世' }), { text: '世' });
  const fn = parseStreamPayload('openai-responses', { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"a"' });
  assert.equal(fn.toolCalls[0].index, 1);
  assert.equal(fn.toolCalls[0].arguments, '{"a"');
  assert.deepEqual(parseStreamPayload('openai-responses', { type: 'response.completed', response: { status: 'completed' } }), { finishReason: 'stop' });

  // Anthropic：text_delta / thinking_delta / input_json_delta / message_delta
  assert.deepEqual(parseStreamPayload('anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } }), { text: '好' });
  assert.deepEqual(parseStreamPayload('anthropic', { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '思' } }), { reasoning: '思' });
  const anthFn = parseStreamPayload('anthropic', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"x"' } });
  assert.equal(anthFn.toolCalls[0].index, 2);
  assert.equal(anthFn.toolCalls[0].arguments, '{"x"');
  assert.deepEqual(parseStreamPayload('anthropic', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }), { finishReason: 'tool_calls' });
  assert.deepEqual(parseStreamPayload('anthropic', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'read' } }).toolCalls[0], { index: 0, id: 't1', name: 'read', arguments: '' });
});

test('parseFinalPayload：三种协议非流式结果', () => {
  const oa = parseFinalPayload('openai', { choices: [{ message: { content: '嗨', reasoning_content: '想', tool_calls: [{ id: 't', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
  assert.equal(oa.text, '嗨');
  assert.equal(oa.reasoning, '想');
  assert.equal(oa.toolCalls[0].name, 'read');

  const responses = parseFinalPayload('openai-responses', {
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [{ text: '想' }] },
      { type: 'message', content: [{ type: 'output_text', text: '世' }] },
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"a":1}' },
    ],
  });
  assert.equal(responses.text, '世');
  assert.equal(responses.reasoning, '想');
  assert.equal(responses.toolCalls[0].id, 'c1');
  assert.equal(responses.toolCalls[0].arguments, '{"a":1}');

  const anthropic = parseFinalPayload('anthropic', {
    stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: '想' },
      { type: 'text', text: '好' },
      { type: 'tool_use', id: 't1', name: 'read', input: { x: 1 } },
    ],
  });
  assert.equal(anthropic.text, '好');
  assert.equal(anthropic.reasoning, '想');
  assert.equal(anthropic.finishReason, 'tool_calls');
  assert.equal(anthropic.toolCalls[0].arguments, '{"x":1}');
});

test('parseProtocolError 覆盖各协议错误体', () => {
  assert.equal(parseProtocolError('openai', { error: { message: 'bad' } }), 'bad');
  assert.equal(parseProtocolError('anthropic', { type: 'error', error: { type: 'x', message: 'over' } }), 'over');
  assert.equal(parseProtocolError('openai-responses', { error: 'plain' }), 'plain');
  assert.equal(parseProtocolError('openai', {}), '');
});
