// /v1/agent 端点契约（agentEndpoint）测试。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_ENDPOINT_PATH,
  AGENT_ENDPOINT_OBJECT,
  AGENT_MODES,
  parseAgentEndpointRequest,
  buildAgentEndpointResponse,
} from '../src/agent/agentEndpoint.js';

test('parseAgentEndpointRequest：prompt 便捷字段 / messages 回退最后一条 user / mode 归一', () => {
  const a = parseAgentEndpointRequest({ prompt: '  你好  ', mode: 'write' });
  assert.equal(a.prompt, '你好');
  assert.equal(a.mode, 'write');

  const b = parseAgentEndpointRequest({
    messages: [
      { role: 'user', content: '第一个' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '最后一个' },
    ],
  });
  assert.equal(b.prompt, '最后一个');
  assert.equal(b.mode, 'read', '缺省 read');
  assert.equal(b.messages.length, 3);

  assert.equal(parseAgentEndpointRequest({ input: 'in' }).prompt, 'in');
});

test('parseAgentEndpointRequest：多模态 content / 非法输入 / max_rounds / character', () => {
  const multimodal = parseAgentEndpointRequest({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'image_url' }] }],
  });
  assert.equal(multimodal.prompt, 'A');
  assert.equal(parseAgentEndpointRequest(null).prompt, '');
  assert.equal(parseAgentEndpointRequest({ mode: 'bogus' }).mode, 'read');
  assert.equal(parseAgentEndpointRequest({ prompt: 'x', max_rounds: 3 }).maxRounds, 3);
  assert.equal(parseAgentEndpointRequest({ prompt: 'x', max_rounds: -1 }).maxRounds, 0);
  assert.equal(parseAgentEndpointRequest({ prompt: 'x', character_id: 'c1' }).characterId, 'c1');
});

test('buildAgentEndpointResponse：契约、steps 过滤、usage 可选', () => {
  const response = buildAgentEndpointResponse({
    text: 'done',
    model: 'm',
    steps: [{ name: 'read_workspace_file' }, { name: '' }, { name: 'run_shell', ok: false }],
    usage: { total_tokens: 5 },
  });
  assert.equal(response.object, AGENT_ENDPOINT_OBJECT);
  assert.equal(response.text, 'done');
  assert.equal(response.model, 'm');
  assert.deepEqual(response.steps, [{ name: 'read_workspace_file' }, { name: 'run_shell', ok: false }]);
  assert.deepEqual(response.usage, { total_tokens: 5 });

  const bare = buildAgentEndpointResponse({});
  assert.equal(bare.object, AGENT_ENDPOINT_OBJECT);
  assert.equal(bare.text, '');
  assert.deepEqual(bare.steps, []);
  assert.equal('usage' in bare, false);
  assert.equal(AGENT_ENDPOINT_PATH, '/v1/agent');
  assert.deepEqual([...AGENT_MODES], ['ask', 'read', 'write']);
});
