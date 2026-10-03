import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_MODES,
  canRunTool,
  clearTools,
  getTool,
  listRegisteredTools,
  listToolsForMode,
  registerTool,
  runTool,
  unregisterTool,
} from '../src/agent/tools/registry.js';

test.beforeEach(() => {
  clearTools();
});

test('registerTool 校验工具名与 execute', () => {
  assert.throws(() => registerTool({ name: 'bad name!', execute: () => {} }), /工具名非法/);
  assert.throws(() => registerTool({ name: 'ok', }), /缺少 execute/);
  const tool = registerTool({
    name: 'read_file',
    description: '读文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    readOnly: true,
    execute: async () => 'x',
  });
  assert.equal(tool.readOnly, true);
  assert.equal(tool.timeoutMs, 15000);
  assert.equal(getTool('read_file').name, 'read_file');
  assert.equal(unregisterTool('read_file'), true);
  assert.equal(getTool('read_file'), null);
});

test('listToolsForMode 按 ask/read/write 门控', () => {
  registerTool({ name: 'read_a', readOnly: true, parameters: {}, execute: async () => 'a' });
  registerTool({ name: 'write_b', readOnly: false, parameters: {}, execute: async () => 'b' });

  assert.deepEqual(listToolsForMode(AGENT_MODES.ASK), []);
  assert.deepEqual(
    listToolsForMode(AGENT_MODES.READ).map(t => t.function.name),
    ['read_a'],
  );
  assert.deepEqual(
    listToolsForMode(AGENT_MODES.WRITE).map(t => t.function.name),
    ['read_a', 'write_b'],
  );
  assert.equal(canRunTool(getTool('write_b'), AGENT_MODES.READ), false);
  assert.equal(canRunTool(getTool('write_b'), AGENT_MODES.WRITE), true);
});

test('runTool 对未知工具/非法参数/模式越权返回错误结果而非抛错', async () => {
  registerTool({ name: 'read_a', readOnly: true, parameters: {}, execute: async () => 'a' });

  const unknown = await runTool({ name: 'nope', arguments: '{}' }, { mode: AGENT_MODES.WRITE });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /未知工具/);

  const badJson = await runTool({ name: 'read_a', arguments: '{not json' }, { mode: AGENT_MODES.READ });
  assert.equal(badJson.isError, true);
  assert.match(badJson.content, /不是合法 JSON/);

  const denied = await runTool({ name: 'read_a', arguments: '{}' }, { mode: AGENT_MODES.ASK });
  assert.equal(denied.isError, true);
  assert.match(denied.content, /当前模式不允许/);
});

test('runTool 成功返回文本或结构化结果', async () => {
  registerTool({
    name: 'read_a',
    readOnly: true,
    parameters: {},
    execute: async args => `path=${args.path}`,
  });
  const ok = await runTool({ name: 'read_a', arguments: '{"path":"a.txt"}' }, { mode: AGENT_MODES.READ });
  assert.deepEqual(ok, { content: 'path=a.txt', isError: false });

  registerTool({
    name: 'read_b',
    readOnly: true,
    parameters: {},
    execute: async () => ({ content: '结构化', isError: true }),
  });
  const structured = await runTool({ name: 'read_b', arguments: '' }, { mode: AGENT_MODES.READ });
  assert.deepEqual(structured, { content: '结构化', isError: true });
});

test('runTool 超时按 timeoutMs 返回错误结果', async () => {
  registerTool({
    name: 'slow',
    readOnly: true,
    parameters: {},
    timeoutMs: 20,
    execute: () => new Promise(() => {}),
  });
  const result = await runTool({ name: 'slow', arguments: '{}' }, { mode: AGENT_MODES.READ });
  assert.equal(result.isError, true);
  assert.match(result.content, /工具执行超时/);
});

test('runTool 执行中中止时抛出 AbortError 供循环停止', async () => {
  registerTool({
    name: 'slow',
    readOnly: true,
    parameters: {},
    execute: () => new Promise(() => {}),
  });
  const controller = new AbortController();
  const pending = runTool({ name: 'slow', arguments: '{}' }, { mode: AGENT_MODES.READ, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error && error.name === 'AbortError');
});

test('runTool execute 抛错转成错误结果，不向上抛', async () => {
  registerTool({
    name: 'boom',
    readOnly: true,
    parameters: {},
    execute: async () => { throw new Error('磁盘错误'); },
  });
  const result = await runTool({ name: 'boom', arguments: '{}' }, { mode: AGENT_MODES.READ });
  assert.deepEqual(result, { content: '磁盘错误', isError: true });
});

test('listRegisteredTools 返回全部注册项', () => {
  registerTool({ name: 'a', readOnly: true, parameters: {}, execute: async () => '' });
  registerTool({ name: 'b', readOnly: false, parameters: {}, execute: async () => '' });
  assert.deepEqual(listRegisteredTools().map(t => t.name).sort(), ['a', 'b']);
});