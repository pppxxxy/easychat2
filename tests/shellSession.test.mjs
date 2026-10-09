// 持久 shell 会话（方案 B）测试（spec: 2026-10-09-agent-extensibility T7）。
//
// 覆盖：① cwd 归一与逃逸防护；② env.json 解析容错（非法键名/上限/截断）；
// ③ export 前缀转义；④ 命令包装（重放目录、捕获写绝对路径、退出码保留）；
// ⑤ 捕获目录解析（沙盒外不记）；⑥ runner 集成（读回放/写回写/无 store 原样）；
// ⑦ 接线契约（native 传 store、终端面板读写共享、能力说明、i18n）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import {
  SHELL_CWD_FILE,
  SHELL_ENV_FILE,
  SHELL_ENV_MAX_KEYS,
  SHELL_ENV_VALUE_MAX,
  parseShellEnv,
  readShellSession,
  resolveCapturedCwd,
  sanitizeShellCwd,
  shellEnvExports,
  wrapShellCommand,
  writeShellSession,
} from '../src/workspace/shellSession.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const SRC_DIR = path.resolve('src');

function loadModule(absPath) {
  const cached = Module._cache[absPath];
  if (cached) return cached.exports;
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: absPath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const mod = new Module(absPath);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  Module._cache[absPath] = mod;
  try {
    mod._compile(code, absPath);
  } catch (error) {
    delete Module._cache[absPath];
    throw error;
  }
  return mod.exports;
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolvedBase = path.resolve(path.dirname(parent.filename), request);
    if (resolvedBase.startsWith(`${SRC_DIR}${path.sep}`)) {
      for (const candidate of [resolvedBase, `${resolvedBase}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return loadModule(candidate);
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

function makeStore(files = {}) {
  return {
    files,
    async readWorkspaceFile({ path: file }) {
      if (!(file in files)) throw new Error('fileNotFound');
      return { content: files[file] };
    },
    async writeWorkspaceFile({ path: file, content }) {
      files[file] = content;
      return { path: file };
    },
  };
}

test('sanitizeShellCwd：相对路径归一；绝对路径与含 .. 一律丢弃（逃逸不记）', () => {
  assert.equal(sanitizeShellCwd(''), '');
  assert.equal(sanitizeShellCwd('.'), '');
  assert.equal(sanitizeShellCwd('src'), 'src');
  assert.equal(sanitizeShellCwd('./src/'), 'src');
  assert.equal(sanitizeShellCwd('a//b/./c'), 'a/b/c');
  assert.equal(sanitizeShellCwd('/etc'), '', '绝对路径不是沙盒内相对路径');
  assert.equal(sanitizeShellCwd('../etc'), '', '含 .. 直接不记');
  assert.equal(sanitizeShellCwd('a/../../b'), '');
  assert.equal(sanitizeShellCwd('x'.repeat(300)), '', '超长丢弃');
  assert.equal(sanitizeShellCwd(null), '');
});

test('parseShellEnv：坏格式安全降级；非法键名剔除；上限与截断生效', () => {
  assert.deepEqual(parseShellEnv('不是 json'), { cwd: '', env: {} });
  assert.deepEqual(parseShellEnv('[]'), { cwd: '', env: {} });
  assert.deepEqual(parseShellEnv(null), { cwd: '', env: {} });

  const parsed = parseShellEnv({
    cwd: '../escape',
    env: { GOOD: 'v', '1BAD': 'x', 'BAD-NAME': 'x', EMPTY: '', LONG: 'y'.repeat(SHELL_ENV_VALUE_MAX + 50) },
  });
  assert.equal(parsed.cwd, '', '脏 cwd 被洗掉');
  assert.deepEqual(Object.keys(parsed.env), ['GOOD', 'LONG']);
  assert.equal(parsed.env.LONG.length, SHELL_ENV_VALUE_MAX);

  const many = {};
  for (let index = 0; index < SHELL_ENV_MAX_KEYS + 5; index += 1) many[`K${index}`] = 'v';
  assert.equal(Object.keys(parseShellEnv({ env: many }).env).length, SHELL_ENV_MAX_KEYS);
});

test('shellEnvExports：单引号转义、空 env 不产生前缀', () => {
  assert.equal(shellEnvExports({}), '');
  assert.equal(shellEnvExports(null), '');
  const text = shellEnvExports({ A: "it's", B: 'plain value' });
  assert.ok(text.includes(`export A='it'\\''s'`), '单引号必须转义，不能破坏脚本');
  assert.ok(text.includes(`export B='plain value'`));
  assert.equal(shellEnvExports({ '1BAD': 'x' }), '', '非法变量名不进脚本');
});

test('wrapShellCommand：重放目录 → 原样命令 → 捕获绝对路径 → 保留退出码', () => {
  const wrapped = wrapShellCommand({
    command: 'echo hi && ls',
    rootPath: '/data/ws/char/',
    cwd: 'src/lib',
    env: { FOO: 'bar' },
  });
  const lines = wrapped.split('\n');
  assert.ok(lines[0].startsWith('export FOO='), '环境变量在最前');
  assert.ok(wrapped.includes(`mkdir -p '/data/ws/char/.easychat'`), '先保证捕获目录存在');
  assert.ok(wrapped.includes(`cd '/data/ws/char/src/lib' 2>/dev/null || cd '/data/ws/char'`), '重放上次目录、失效回落根');
  assert.ok(wrapped.includes('echo hi && ls'), '用户命令原样保留');
  assert.equal(/echo hi \&\& ls[\s\S]*__easyec=\$\?/.test(wrapped), true, '退出码在命令后立刻抓');
  assert.ok(wrapped.includes(`pwd > '/data/ws/char/${SHELL_CWD_FILE}'`), '捕获写绝对路径（cwd 已可能改变）');
  assert.ok(wrapped.trim().endsWith('exit $__easyec'), '退出码原样传出');

  // 无 cwd：直接 cd 根；无 env：无 export 行
  const bare = wrapShellCommand({ command: 'pwd', rootPath: '/r/', cwd: '', env: {} });
  assert.equal(bare.includes('export '), false);
  assert.ok(bare.includes(`cd '/r' 2>/dev/null\npwd`), 'root 尾斜杠归一后 cd');
});

test('resolveCapturedCwd：沙盒内 → 相对；根 → 空；沙盒外 → null（不记住）', () => {
  assert.equal(resolveCapturedCwd('/r/src\n', '/r'), 'src');
  assert.equal(resolveCapturedCwd('/r/src/deep/\n', '/r'), 'src/deep');
  assert.equal(resolveCapturedCwd('/r', '/r'), '', '在根');
  assert.equal(resolveCapturedCwd('/r/\n', '/r'), '');
  assert.equal(resolveCapturedCwd('/\n', '/r'), null, 'cd / 之后不记住（否则后续命令全在 / 下跑）');
  assert.equal(resolveCapturedCwd('/other/place', '/r'), null);
  assert.equal(resolveCapturedCwd('', '/r'), null);
  assert.equal(resolveCapturedCwd('/r/x', ''), null);
});

test('readShellSession / writeShellSession：三态与写入前洗值', async () => {
  const store = makeStore({ [SHELL_ENV_FILE]: JSON.stringify({ cwd: 'src', env: { A: '1' } }) });
  assert.deepEqual(await readShellSession(store, 'c1'), { cwd: 'src', env: { A: '1' } });
  assert.deepEqual(await readShellSession(makeStore({}), 'c1'), { cwd: '', env: {} });
  assert.deepEqual(await readShellSession(null, 'c1'), { cwd: '', env: {} });

  assert.equal(await writeShellSession(store, 'c1', { cwd: '../bad', env: { '0X': 'v', OK: 'v' } }), true);
  const written = JSON.parse(store.files[SHELL_ENV_FILE]);
  assert.equal(written.cwd, '', '脏 cwd 写不进去');
  assert.deepEqual(written.env, { OK: 'v' });
});

test('runner 集成：读 env.json 重放、执行后捕获写回、输出附当前目录', async () => {
  const files = { [SHELL_ENV_FILE]: JSON.stringify({ cwd: 'src', env: { FOO: 'bar' } }) };
  const store = makeStore(files);
  const calls = [];
  const native = {
    exec: async (command, cwdPath) => {
      calls.push({ command, cwdPath });
      // 模拟：命令把目录切到了 src/deep —— 捕获文件里写绝对路径
      files[SHELL_CWD_FILE] = '/root/char1/src/deep\n';
      return { stdout: 'ok\n', stderr: '', exitCode: 0 };
    },
    kill: () => {},
  };
  const shell = loadModule(path.resolve('src/workspace/shell.js'));
  const runner = shell.createShellRunner({ sandboxRoot: '/root', native, store });
  const result = await runner({ command: 'cd deep', characterId: 'char1' });

  assert.equal(calls.length, 1);
  assert.ok(calls[0].command.includes(`cd '/root/char1/src'`), '重放上次目录');
  assert.ok(calls[0].command.includes('export FOO='), '注入环境变量');
  assert.equal(calls[0].cwdPath, '/root/char1');
  assert.deepEqual(JSON.parse(files[SHELL_ENV_FILE]).cwd, 'src/deep', '捕获的新目录已写回');
  assert.ok(result.content.startsWith('当前目录：src/deep\n'), '输出附当前目录（模型要知道自己在哪）');
  assert.equal(result.isError, false);
});

test('runner 集成：沙盒外目录不回写；无 store 时原样执行（行为与改动前一致）', async () => {
  const files = { [SHELL_ENV_FILE]: JSON.stringify({ cwd: 'src', env: {} }) };
  const store = makeStore(files);
  const native = {
    exec: async () => {
      files[SHELL_CWD_FILE] = '/\n'; // cd / —— 逃出沙盒
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    kill: () => {},
  };
  const shell = loadModule(path.resolve('src/workspace/shell.js'));
  const runner = shell.createShellRunner({ sandboxRoot: '/root', native, store });
  const result = await runner({ command: 'cd /', characterId: 'char1' });
  assert.equal(JSON.parse(files[SHELL_ENV_FILE]).cwd, 'src', '逃出沙盒的目录不记住，保持原值');
  assert.ok(result.content.includes('当前目录：src'));

  // 无 store：命令不被包装（不重放、不捕获），也不附目录行
  const rawCalls = [];
  const rawRunner = shell.createShellRunner({
    sandboxRoot: '/root',
    native: { exec: async command => { rawCalls.push(command); return { stdout: 'x', stderr: '', exitCode: 0 }; }, kill: () => {} },
  });
  const rawResult = await rawRunner({ command: 'ls -al', characterId: 'char1' });
  assert.equal(rawCalls[0], 'ls -al', '无 store = 原样执行');
  assert.equal(rawResult.content.includes('当前目录'), false);
});

test('接线契约：native 传 store；终端面板读写同一份会话文件；能力说明与 i18n 齐', () => {
  const native = fs.readFileSync(path.resolve('src/workspace/native.js'), 'utf8');
  assert.ok(/createShellRunner\(\{[^}]*store/.test(native), 'resolveShellRunner 要传 store（否则持久会话不生效）');

  const terminal = fs.readFileSync(path.resolve('src/workspace/screen/TerminalPanel.js'), 'utf8');
  assert.ok(terminal.includes('readShellSession(storeRef.current, characterId)'), '终端打开时恢复目录与环境变量');
  assert.ok(terminal.includes('writeShellSession(storeRef.current, characterId'), '终端 cd 写回共享文件');
  assert.ok(terminal.includes('shellEnvExports(shellEnvRef.current)'), '终端执行注入环境变量');

  const caps = fs.readFileSync(path.resolve('src/workspace/capabilities.js'), 'utf8');
  assert.ok(caps.includes("'shellSession'"), '能力说明如实写持久会话边界');
  const zh = fs.readFileSync(path.resolve('src/i18n/locales/zh-CN/workspace.js'), 'utf8');
  const en = fs.readFileSync(path.resolve('src/i18n/locales/en/workspace.js'), 'utf8');
  assert.ok(zh.includes("'workspace.capability.limit.shellSession'"));
  assert.ok(en.includes("'workspace.capability.limit.shellSession'"));
});
