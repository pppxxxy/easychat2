// 写子代理的**确认门**行为测试（回归 2026-10-11 逐行审查 P0-1）。
//
// 为什么单独立一个文件：既有 tests/subagent.test.mjs 里的写工具是**自造的**，而且那个假工具
// 恰好带了 `requiresConfirmation: true`——真实写工具根本没有这个字段，于是「写操作直接执行」
// 这个 bug 在门禁全绿的情况下活了很久。这个文件立的规矩是：
// **确认门必须用真实 WRITE_TOOL_DEFINITIONS 验证**，不许再拿自造工具的形状去证明真实定义的行为。
//
// 走与 subagent.test.mjs 同款的 loadModule 图（subagent.js / writeTools.js 的静态依赖里
// 有 i18n 与 expo-file-system，需要 patch）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

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

const apiMock = {
  __esModule: true,
  streamChatCompletion: async () => { throw new Error('测试必须注入 stream'); },
  createAbortError: () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    error.canceled = true;
    return error;
  },
  isCanceledError: error => Boolean(error && (error.canceled === true || error.name === 'AbortError')),
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  if (request.endsWith('/network/api.js')) return apiMock;
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

const { runSubagent } = loadModule(path.resolve('src/agent/subagent.js'));
const { WRITE_TOOL_DEFINITIONS } = loadModule(path.resolve('src/workspace/toolDefs/writeTools.js'));

const TARGET = 'notes/hello.txt';

// 记录「真正落到目标路径」的写入。file-history 快照写的是 .easychat/file-history/…
// （内部写入者，不受工具确认门约束），所以按目标路径过滤，只看 agent 那笔写入。
function makeStore(targetWrites) {
  return {
    readWorkspaceFile: async () => { throw new Error('not found'); },
    writeWorkspaceFile: async ({ path: filePath, content }) => {
      if (String(filePath) === TARGET) targetWrites.push(String(content));
      return { path: filePath, length: String(content || '').length };
    },
    editWorkspaceFile: async ({ path: filePath }) => {
      if (String(filePath) === TARGET) targetWrites.push('EDIT');
      return { path: filePath, count: 1 };
    },
    createWorkspaceDirectory: async ({ path: dirPath }) => ({ path: dirPath }),
    deleteFile: async () => {},
  };
}

// 一轮调写工具、二轮给结论的假流。
function writeThenConclude(args = { path: TARGET, content: 'hello' }) {
  let round = 0;
  return async () => {
    round += 1;
    if (round === 1) {
      return {
        text: '',
        toolCalls: [{ id: 'w1', name: 'write_workspace_file', arguments: JSON.stringify(args) }],
      };
    }
    return { text: '结论：写完了。', toolCalls: [] };
  };
}

function realWriteTool() {
  return WRITE_TOOL_DEFINITIONS.find(item => item.name === 'write_workspace_file');
}

test('前提：真实写工具只声明 readOnly:false——确认门不能靠 requiresConfirmation 字段', () => {
  const names = WRITE_TOOL_DEFINITIONS.map(item => item.name);
  assert.deepEqual(names, ['create_workspace_dir', 'write_workspace_file', 'edit_workspace_file']);
  for (const tool of WRITE_TOOL_DEFINITIONS) {
    assert.equal(tool.readOnly, false, `${tool.name} 必须声明 readOnly: false（模式门控靠它）`);
  }
  // 这条钉的是**判据来源**：三个真实写工具都没有 requiresConfirmation。
  // 若将来有人给它们加上该字段（并因此改变主循环行为），这条会提醒他先读 subagent.js 的注释。
  const flagged = WRITE_TOOL_DEFINITIONS.filter(tool => tool.requiresConfirmation === true);
  assert.deepEqual(flagged, [], '真实写工具当前不声明 requiresConfirmation（见 paths.js 的写工具裁决）');
});

test('回归 P0-1：用真实写工具定义——拒绝时目标文件绝不落盘', async () => {
  const writes = [];
  const store = makeStore(writes);
  const asked = [];
  const result = await runSubagent({
    task: '把 hello 写进 notes/hello.txt',
    tools: WRITE_TOOL_DEFINITIONS,
    store,
    stream: writeThenConclude(),
    mode: 'write',
    confirm: async call => { asked.push(call); return false; },
  });
  assert.equal(asked.length, 1, '写工具必须先问用户一次');
  assert.equal(asked[0].name, 'write_workspace_file');
  assert.equal(asked[0].args.path, TARGET);
  assert.deepEqual(writes, [], '用户拒绝 → 目标文件一次都不许写');
  assert.ok(result.content.includes('结论'), '拒绝后循环继续，模型拿到「未执行」');
});

test('回归 P0-1：用真实写工具定义——批准时恰好写一次', async () => {
  const writes = [];
  const result = await runSubagent({
    task: '把 hello 写进 notes/hello.txt',
    tools: WRITE_TOOL_DEFINITIONS,
    store: makeStore(writes),
    stream: writeThenConclude(),
    mode: 'write',
    confirm: async () => true,
  });
  assert.deepEqual(writes, ['hello'], '批准后按原文写入一次（不重复副作用）');
  assert.ok(result.content.includes('结论'));
});

test('回归 P0-1：真实写工具 + 没有审批钩子 → 按「不可询问 = 拒绝」处理，不落盘', async () => {
  const writes = [];
  await runSubagent({
    task: '把 hello 写进 notes/hello.txt',
    tools: WRITE_TOOL_DEFINITIONS,
    store: makeStore(writes),
    stream: writeThenConclude(),
    mode: 'write',
    // 不传 confirm：无人值守环境绝不能变成「不用问就写」
  });
  assert.deepEqual(writes, [], '没有审批钩子时必须拒绝执行，而不是静默放行');
});

test('回归 P0-1：三个真实写工具逐个过确认门（不是只修了 write 一个）', async () => {
  const cases = [
    { name: 'write_workspace_file', args: { path: TARGET, content: 'x' } },
    { name: 'edit_workspace_file', args: { path: TARGET, find: 'a', replace: 'b' } },
    { name: 'create_workspace_dir', args: { path: 'notes' } },
  ];
  for (const item of cases) {
    const writes = [];
    const asked = [];
    let round = 0;
    const stream = async () => {
      round += 1;
      if (round === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: item.name, arguments: JSON.stringify(item.args) }] };
      }
      return { text: '结论：未执行。', toolCalls: [] };
    };
    await runSubagent({
      task: 't',
      tools: WRITE_TOOL_DEFINITIONS,
      store: makeStore(writes),
      stream,
      mode: 'write',
      confirm: async call => { asked.push(call.name); return false; },
    });
    assert.deepEqual(asked, [item.name], `${item.name} 必须先过确认门`);
    assert.deepEqual(writes, [], `${item.name} 被拒后不得落盘`);
  }
});

test('回归 P0-1：执行写工具时 signal 与 confirm 传进了 ctx（与主循环同形）', async () => {
  const real = realWriteTool();
  const seen = [];
  // 包一层只观察 ctx，形状（readOnly:false、无 requiresConfirmation）仍是真实定义。
  const observed = {
    ...real,
    execute: (options, args, ctx) => {
      seen.push(ctx);
      return real.execute(options, args, ctx);
    },
  };
  const controller = { aborted: false, addEventListener() {}, removeEventListener() {} };
  const confirmFn = async () => true;
  const writes = [];
  await runSubagent({
    task: 't',
    tools: [observed],
    store: makeStore(writes),
    stream: writeThenConclude(),
    mode: 'write',
    signal: controller,
    confirm: confirmFn,
  });
  assert.equal(seen.length, 1, '工具执行了一次');
  assert.equal(seen[0].confirm, confirmFn, 'confirm 必须传进 ctx（工具内部可能还要再问）');
  assert.equal(seen[0].signal, controller, 'signal 必须传进 ctx（长操作要能被停止）');
  assert.equal(seen[0].characterId, undefined, 'characterId 原样透传（未给就是 undefined）');
});
