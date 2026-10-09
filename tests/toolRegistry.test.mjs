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

test('D4-1 结果钩子：成功可增强；错误结果不增强；钩子抛错按原结果；不注入无变化', async () => {
  registerTool({ name: 'echo', readOnly: true, parameters: {}, execute: async () => '原始内容' });

  // 成功增强：钩子拿到 { name, args } 与归一后的结果，返回值替换结果
  const seen = [];
  const patched = await runTool(
    { name: 'echo', arguments: '{}' },
    {
      mode: 'read',
      onToolResult: async (call, result) => {
        seen.push({ name: call.name, content: result.content });
        return { content: `${result.content}\n[钩子] 提醒` };
      },
    }
  );
  assert.equal(patched.content, '原始内容\n[钩子] 提醒');
  assert.deepEqual(seen, [{ name: 'echo', content: '原始内容' }]);

  // 错误结果不增强（不该被「增强」成看起来成功的样子）
  registerTool({
    name: 'boom',
    readOnly: true,
    parameters: {},
    execute: async () => { throw new Error('炸了'); },
  });
  let called = 0;
  const errored = await runTool(
    { name: 'boom', arguments: '{}' },
    { mode: 'read', onToolResult: async () => { called += 1; return { content: 'x' }; } }
  );
  assert.equal(errored.isError, true);
  assert.equal(called, 0, '错误路径不调用结果钩子');

  // 钩子自身抛错：按原结果返回（增强是增值步骤，不能毁掉工具执行）
  const safe = await runTool(
    { name: 'echo', arguments: '{}' },
    { mode: 'read', onToolResult: async () => { throw new Error('hook down'); } }
  );
  assert.equal(safe.content, '原始内容');

  // 不注入 = 行为与旧版一致
  assert.equal((await runTool({ name: 'echo', arguments: '{}' }, { mode: 'read' })).content, '原始内容');
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
// ---- 审批钩子（requiresConfirmation）----
//
// 这一组盯住三件事，每件都对应一个真实会出事的写法：
// 1. 拒绝后**绝不执行**（execute 一次都不能被调到）；
// 2. 没有审批钩子时是**拒绝**而不是放行（漏传 confirm 的循环不能变成免确认）；
// 3. 审批在超时竞速**之外**（用户多想几秒不能被判成工具超时）。

test('registerTool 归一化 requiresConfirmation（缺省 false，既有工具行为不变）', () => {
  const plain = registerTool({ name: 'plain', parameters: {}, execute: async () => '' });
  assert.equal(plain.requiresConfirmation, false);
  const guarded = registerTool({ name: 'guarded', parameters: {}, requiresConfirmation: true, execute: async () => '' });
  assert.equal(guarded.requiresConfirmation, true);
  // 非 true 的取值一律当 false（'yes' / 1 之类不能被当成开启）
  assert.equal(registerTool({ name: 'g2', parameters: {}, requiresConfirmation: 'yes', execute: async () => '' }).requiresConfirmation, false);
});

test('拒绝时返回错误结果，且 execute 绝不被调用', async () => {
  let executed = 0;
  registerTool({
    name: 'shell',
    parameters: {},
    requiresConfirmation: true,
    execute: async () => { executed += 1; return 'ran'; },
  });
  const result = await runTool(
    { name: 'shell', arguments: '{"command":"rm -rf /"}' },
    { mode: AGENT_MODES.WRITE, confirm: async () => false },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /用户拒绝了此操作（未执行）/);
  assert.equal(executed, 0, '拒绝后绝不能执行');
});

test('允许时正常执行，且 confirm 收到工具名与原参数', async () => {
  const seen = [];
  registerTool({
    name: 'shell',
    parameters: {},
    requiresConfirmation: true,
    execute: async args => `ran:${args.command}`,
  });
  const result = await runTool(
    { name: 'shell', arguments: '{"command":"ls -al"}' },
    { mode: AGENT_MODES.WRITE, confirm: async call => { seen.push(call); return true; } },
  );
  assert.deepEqual(result, { content: 'ran:ls -al', isError: false });
  assert.deepEqual(seen, [{ name: 'shell', args: { command: 'ls -al' } }]);
});

test('没接审批钩子 = 拒绝，绝不是放行', async () => {
  let executed = 0;
  registerTool({
    name: 'shell',
    parameters: {},
    requiresConfirmation: true,
    execute: async () => { executed += 1; return 'ran'; },
  });
  const result = await runTool({ name: 'shell', arguments: '{"command":"ls"}' }, { mode: AGENT_MODES.WRITE });
  assert.equal(result.isError, true);
  assert.match(result.content, /无法询问用户（未执行）/);
  assert.equal(executed, 0);
});

test('不需要确认的工具完全不问用户（不能顺手拦下普通工具）', async () => {
  let asked = 0;
  registerTool({ name: 'plain', parameters: {}, readOnly: true, execute: async () => 'ok' });
  const result = await runTool(
    { name: 'plain', arguments: '{}' },
    { mode: AGENT_MODES.READ, confirm: async () => { asked += 1; return true; } },
  );
  assert.equal(result.content, 'ok');
  assert.equal(asked, 0);
});

test('审批钩子抛错按中止处理，绝不默认放行', async () => {
  let executed = 0;
  registerTool({
    name: 'shell',
    parameters: {},
    requiresConfirmation: true,
    execute: async () => { executed += 1; return 'ran'; },
  });
  const result = await runTool(
    { name: 'shell', arguments: '{"command":"ls"}' },
    { mode: AGENT_MODES.WRITE, confirm: async () => { throw new Error('UI 已卸载'); } },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /工具确认失败（未执行）/);
  assert.equal(executed, 0);
});

test('审批耗时不计入工具的 timeoutMs（用户慢慢想不算超时）', async () => {
  // 工具的 timeoutMs 给 1ms，而 confirm 等 30ms：若审批在竞速之内，必然误判超时。
  registerTool({
    name: 'shell',
    parameters: {},
    requiresConfirmation: true,
    timeoutMs: 1,
    execute: async () => 'ran',
  });
  const result = await runTool(
    { name: 'shell', arguments: '{"command":"ls"}' },
    { mode: AGENT_MODES.WRITE, confirm: () => new Promise(resolve => setTimeout(() => resolve(true), 30)) },
  );
  assert.deepEqual(result, { content: 'ran', isError: false });
});

test('审批期间中止：抛 AbortError 供循环停止（不执行也不留悬挂）', async () => {
  let executed = 0;
  registerTool({
    name: 'shell',
    parameters: {},
    requiresConfirmation: true,
    execute: async () => { executed += 1; return 'ran'; },
  });
  const controller = new AbortController();
  // confirm 永不结算：模拟弹框还开着
  const pending = runTool(
    { name: 'shell', arguments: '{"command":"ls"}' },
    { mode: AGENT_MODES.WRITE, signal: controller.signal, confirm: () => new Promise(() => {}) },
  );
  controller.abort();
  await assert.rejects(pending, error => error && error.name === 'AbortError');
  assert.equal(executed, 0);
});
