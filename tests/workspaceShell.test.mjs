// 工作区命令执行 JS 桥（shell.js，注入假的 NativeModules）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createShellRequestId,
  createShellRunner,
  execShellCommand,
  formatShellResult,
  isShellAvailable,
  sandboxDirectoryPath,
  sandboxPathFromUri,
  SHELL_OUTPUT_LIMIT,
  truncateShellOutput,
} from '../src/workspace/shell.js';

test('测试环境没有原生模块：能力如实报不可用', () => {
  assert.equal(isShellAvailable(), false);
  // NativeModules 都拿不到时，exec 必须明确拒绝而不是静默成功
});

test('sandboxPathFromUri：file:// 转绝对路径并解码，非 file:// 明确拒绝', () => {
  assert.equal(sandboxPathFromUri('file:///data/user/0/app/files/workspace/'), '/data/user/0/app/files/workspace/');
  assert.equal(sandboxPathFromUri('file:///data/a%20b/'), '/data/a b/');
  // 非法百分号编码不抛错（退回原串），仍能当路径用
  assert.equal(sandboxPathFromUri('file:///data/%E4%B8/'), '/data/%E4%B8/');
  // content:// 是 SAF：shell 根本碰不到，这里直接拒绝
  assert.throws(() => sandboxPathFromUri('content://tree/primary%3ADocs'), /只能作用于应用私有工作区/);
  assert.throws(() => sandboxPathFromUri(''), /只能作用于应用私有工作区/);
  assert.throws(() => sandboxPathFromUri('file://relative/path'), /不是绝对路径/);
});

test('truncateShellOutput：超限截断并明确标注', () => {
  const small = truncateShellOutput('abc', 10);
  assert.deepEqual(small, { text: 'abc', truncated: false });
  const big = truncateShellOutput('x'.repeat(20), 10);
  assert.equal(big.truncated, true);
  assert.ok(big.text.startsWith('x'.repeat(10)));
  assert.match(big.text, /输出已截断/);
  assert.deepEqual(truncateShellOutput(null).text, '');
  assert.equal(SHELL_OUTPUT_LIMIT, 64 * 1024);
});

test('formatShellResult：退出码非 0 / 超时都标成 isError，让模型别当成功', () => {
  const ok = formatShellResult({ stdout: 'a\n', stderr: '', exitCode: 0 });
  assert.equal(ok.isError, false);
  assert.match(ok.content, /退出码：0/);
  assert.match(ok.content, /标准输出：\na/);

  const failed = formatShellResult({ stdout: '', stderr: 'ls: not found', exitCode: 127 });
  assert.equal(failed.isError, true, '命令失败必须让模型知道');
  assert.match(failed.content, /退出码：127/);
  assert.match(failed.content, /标准错误：\nls: not found/);

  const timedOut = formatShellResult({ stdout: '', stderr: '', exitCode: -1, timedOut: true, timeoutMs: 30000 });
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.content, /命令超时（已终止）/);

  assert.match(formatShellResult({}).content, /（无输出）/);
});

test('createShellRequestId：每次调用都不同（用于精确 kill 自己那条）', () => {
  const a = createShellRequestId(1000, () => 0.5);
  const b = createShellRequestId(1000, () => 0.25);
  assert.notEqual(a, b);
  assert.match(a, /^shell-1000-/);
});

test('execShellCommand：空命令与缺原生模块都明确报错', async () => {
  await assert.rejects(execShellCommand({ command: '   ', cwdPath: '/tmp', native: {} }), /命令不能为空/);
  await assert.rejects(execShellCommand({ command: 'ls', cwdPath: '/tmp', native: null }), /不支持执行命令/);
});

test('execShellCommand：透传命令/工作目录/超时/请求 id 给原生', async () => {
  const calls = [];
  const native = {
    async exec(command, cwdPath, timeoutMs, requestId) {
      calls.push({ command, cwdPath, timeoutMs, requestId });
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
    kill() {},
  };
  const result = await execShellCommand({
    command: ' ls -al ',
    cwdPath: '/sandbox/c1',
    timeoutMs: 5000,
    requestId: 'r1',
    native,
  });
  assert.equal(result.stdout, 'ok');
  assert.deepEqual(calls, [{ command: 'ls -al', cwdPath: '/sandbox/c1', timeoutMs: 5000, requestId: 'r1' }]);
});

test('signal 中止时先 kill 再抛 AbortError（命令不能在后台继续跑）', async () => {
  const killed = [];
  const native = {
    exec: () => new Promise(() => {}),
    kill: requestId => killed.push(requestId),
  };
  const controller = new AbortController();
  const pending = execShellCommand({ command: 'sleep 999', cwdPath: '/sandbox', requestId: 'r2', signal: controller.signal, native });
  controller.abort();
  await assert.rejects(pending, error => error && error.name === 'AbortError');
  assert.deepEqual(killed, ['r2'], '必须先 kill 原生进程');
});

test('已中止的信号：进都不进原生', async () => {
  let called = 0;
  const native = { exec: async () => { called += 1; }, kill() {} };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    execShellCommand({ command: 'ls', cwdPath: '/sandbox', signal: controller.signal, native }),
    error => error && error.name === 'AbortError',
  );
  assert.equal(called, 0);
});

test('createShellRunner：按角色拼子目录，输出经截断后回给模型', async () => {
  const calls = [];
  const native = {
    async exec(command, cwdPath) {
      calls.push(cwdPath);
      return { stdout: 'y'.repeat(SHELL_OUTPUT_LIMIT + 10), stderr: 'warn', exitCode: 0 };
    },
    kill() {},
  };
  const run = createShellRunner({ native, sandboxRoot: '/data/files/workspace' });
  const result = await run({ command: 'ls', characterId: 'char 1!' });
  // 角色 id 走 sanitizeSandboxId：非法字符换成下划线 —— 与文件工具同一沙盒
  assert.deepEqual(calls, ['/data/files/workspace/char_1_']);
  assert.equal(result.isError, false);
  assert.match(result.content, /输出已截断/);
  assert.match(result.content, /标准错误：\nwarn/);
});

test('sandboxDirectoryPath：去尾斜杠、按默认 id 兜底、缺根报错', () => {
  assert.equal(sandboxDirectoryPath('/a/b/', 'c1'), '/a/b/c1');
  assert.equal(sandboxDirectoryPath('/a/b', ''), '/a/b/default');
  assert.throws(() => sandboxDirectoryPath('', 'c1'), /缺少沙盒根路径/);
  assert.throws(() => sandboxDirectoryPath(null, 'c1'), /缺少沙盒根路径/);
});
