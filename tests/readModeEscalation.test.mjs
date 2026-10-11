// READ 模式越权写（回归 2026-10-11 逐行审查 P0-2）。
//
// 缺陷：run_subagent（subagentTool.js，readOnly: true）与 run_workflow（workflowTool.js，
// readOnly: true）在 READ 模式**可以被模型调用**——它们只读是就自身副作用而言的。
// 但两者内部都直接调 tool.execute / runSubagent，**绕过了 registry.canRunTool 的模式闸门**
//（该函数只在 registry.js 内部被调用）。于是「READ 模式 + run_subagent{mode:'write'}」
// 能真的落盘，而且按 P0-1 之前连确认都不会问。
//
// 这个文件的断言方式：**不**只看返回值，而是看真实写工具的落盘记录——
// 「拒绝了」和「没写成」是两件事，只有 store 的写入记录能证明后者。
// 同时必须有一个「可改模式下确实写得成」的对照，否则「门拦住了」和「别的东西坏了」
// 分不开（这正是本仓既有测试的通病）。
//
// 走 loadModule 图：需要把 network/api.js 换成可控的假流（run_subagent 的工具定义
// 内部调 runSubagent 时不传 stream，只能从默认取配置路径拿）。

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

// 可控假流：工具定义内部调 runSubagent 时不传 stream，只能经默认取配置路径拿到它。
const streamHolder = { fn: null, calls: 0 };
const apiMock = {
  __esModule: true,
  streamChatCompletion: (...args) => {
    streamHolder.calls += 1;
    if (typeof streamHolder.fn !== 'function') throw new Error('测试必须先设置 streamHolder.fn');
    return streamHolder.fn(...args);
  },
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

const { SUBAGENT_TOOL_DEFINITION } = loadModule(path.resolve('src/workspace/toolDefs/subagentTool.js'));
const { WORKFLOW_TOOL_DEFINITION } = loadModule(path.resolve('src/workspace/toolDefs/workflowTool.js'));
const { runSubagent } = loadModule(path.resolve('src/agent/subagent.js'));

const TARGET = 'notes/hello.txt';

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
    listWorkspaceFiles: async () => [],
  };
}

// 「若模式门没拦住，就一定会落盘」的假流：第一轮调真实写工具，第二轮给结论。
function installWriteStream() {
  let round = 0;
  streamHolder.calls = 0;
  streamHolder.fn = async () => {
    round += 1;
    if (round === 1) {
      return {
        text: '',
        toolCalls: [{
          id: 'w1',
          name: 'write_workspace_file',
          arguments: JSON.stringify({ path: TARGET, content: 'hello' }),
        }],
      };
    }
    return { text: '结论：写完了。', toolCalls: [] };
  };
}

test('回归 P0-2：READ 模式 + run_subagent{mode:"write"} 明确拒绝，且一次都不落盘', async () => {
  const writes = [];
  installWriteStream();
  const result = await SUBAGENT_TOOL_DEFINITION.execute(
    { store: makeStore(writes) },
    { task: '把 hello 写进 notes/hello.txt', mode: 'write' },
    { workspaceMode: 'read', characterId: 'ch', confirm: async () => true },
  );
  assert.equal(result.isError, true, 'READ 模式下的写子代理必须被拒绝');
  assert.match(result.content, /只读模式/, '拒绝理由要如实说清是模式问题');
  assert.deepEqual(writes, [], '被拒后目标文件一次都不许写');
  assert.equal(streamHolder.calls, 0, '必须在发模型请求之前就拒绝（不浪费一次 LLM 调用）');
});

test('回归 P0-2：对照——可改模式下同一个调用真的写得成（证明是模式门在拦）', async () => {
  const writes = [];
  installWriteStream();
  const result = await SUBAGENT_TOOL_DEFINITION.execute(
    { store: makeStore(writes) },
    { task: '把 hello 写进 notes/hello.txt', mode: 'write' },
    { workspaceMode: 'write', characterId: 'ch', confirm: async () => true },
  );
  assert.deepEqual(writes, ['hello'], '可改模式 + 批准 → 落盘一次');
  assert.equal(result.isError, undefined);
  assert.ok(String(result).includes('结论'));
  assert.ok(streamHolder.calls > 0, '确实走到了子代理循环');
});

test('回归 P0-2：ctx 没带 workspaceMode（新调用点忘传）→ 一样拒绝（fail-closed）', async () => {
  const writes = [];
  installWriteStream();
  const result = await SUBAGENT_TOOL_DEFINITION.execute(
    { store: makeStore(writes) },
    { task: '把 hello 写进 notes/hello.txt', mode: 'write' },
    { characterId: 'ch', confirm: async () => true },
  );
  assert.equal(result.isError, true, '拿不到模式信息时按「不可写」处理，而不是放行');
  assert.deepEqual(writes, []);
});

test('回归 P0-2：READ 模式 + run_workflow 含 write 步骤 → 整条拒绝并点名步骤', async () => {
  const writes = [];
  installWriteStream();
  const result = await WORKFLOW_TOOL_DEFINITION.execute(
    { store: makeStore(writes) },
    { steps: [{ id: 'write-step', task: '把 hello 写进文件', mode: 'write' }] },
    { workspaceMode: 'read', characterId: 'ch', confirm: async () => true },
  );
  assert.equal(result.isError, true, 'READ 模式下的写步骤必须被拒绝');
  assert.match(result.content, /write-step/, '要点名是哪一步越权（否则用户不知道改哪步）');
  assert.match(result.content, /只读模式/);
  assert.deepEqual(writes, [], '被拒后目标文件一次都不许写');
  assert.equal(streamHolder.calls, 0, '整条工作流在发模型请求之前就被拒绝');
});

test('回归 P0-2：对照——READ 模式的纯只读工作流照常可跑（门不是把工作流一律拒了）', async () => {
  streamHolder.calls = 0;
  streamHolder.fn = async () => ({ text: '结论：读完了。', toolCalls: [] });
  const result = await WORKFLOW_TOOL_DEFINITION.execute(
    { store: makeStore([]) },
    { steps: [{ id: 'r1', task: '读一下工作区' }] },
    { workspaceMode: 'read', characterId: 'ch', confirm: async () => true },
  );
  assert.ok(String(result).includes('读完了'), '只读工作流在 READ 模式必须仍然可用');
  assert.ok(streamHolder.calls > 0);
});

test('回归 P0-2：纵深防御第二层——runSubagent 自己再断言一次，不信调用方', async () => {
  // 就算有人绕过两个工具定义、直接调 runSubagent（或将来新增调用点忘了加闸门），
  // 没有 workspaceMode:'write' 也必须拒绝。
  installWriteStream();
  const writes = [];
  const refused = await runSubagent({
    task: '把 hello 写进文件',
    tools: [],
    store: makeStore(writes),
    mode: 'write',
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content, /可改/);
  assert.deepEqual(writes, []);
  assert.equal(streamHolder.calls, 0, '拒绝发生在任何模型请求之前');
});
