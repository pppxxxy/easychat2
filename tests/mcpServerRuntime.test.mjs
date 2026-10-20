// 内置 MCP Server 的生产装配（serverRuntime.js）——**安全核心**。
//
// 这个文件拖着重依赖（工作区/AsyncStorage），测试用 Module._load 打桩把依赖换成替身，
// 只验证装配本身：档位 → 模式的映射、工作区钩子规则照旧喂给 runTool、confirm 只对
// 「工具自己声明要确认」的工具放行、启停按访问范围选绑定地址并回写生成的 token。
//
// 为什么值得单独钉：这一段是「外部 agent 能不能改我的东西」的唯一开关，
// 而它本身没有分支复杂的算法——错了就是错了，只能靠断言钉住。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const RUNTIME_PATH = path.resolve('src/mcp/serverRuntime.js');
const REGISTRY_PATH = path.resolve('src/agent/tools/registry.js');
const SETTINGS_PATH = path.resolve('src/storage/settings.js');
const WORKSPACE_PATH = path.resolve('src/storage/workspace.js');
const ASSISTANT_PATH = path.resolve('src/workspace/assistant.js');
const HOOKS_PATH = path.resolve('src/workspace/hooks.js');
const NATIVE_PATH = path.resolve('src/workspace/native.js');
const BRIDGE_PATH = path.resolve('src/mcp/serverBridge.js');

const calls = {
  register: [],
  runTool: [],
  permissionRules: [],
  start: [],
  stop: 0,
  patch: [],
  createStore: 0,
  describeRoot: 0,
};

const state = {
  settings: { enabled: false, scope: 'loopback', port: 8737, mcpToken: '', tiers: { read: true, write: false, exec: false } },
  workspaceSettings: { mode: 'read', allowShell: true },
  assistant: { character: { id: 'char-1', name: '助手' } },
  tools: { run_shell: { name: 'run_shell', requiresConfirmation: true }, read_workspace_file: { name: 'read_workspace_file' } },
  toolResult: { content: 'ok', isError: false },
  startResult: { running: true, host: '127.0.0.1', port: 8737, mcpToken: 'generated-token' },
};

const registryStub = {
  getTool: name => state.tools[name] || null,
  listRegisteredTools: () => Object.values(state.tools),
  // 与真实 registry.requiresConfirmationFor 同口径（含函数形态与 fail-closed）：
  // 这条桩是**测试替身**，必须跟着被测契约走，否则会掩盖生产里的 fail-open 回归
  //（本桩原先缺这个导出 → 合并后 runtime 调用它直接 undefined 报错，正是被这条测试抓到）。
  requiresConfirmationFor: (tool, args = {}) => {
    const value = tool && tool.requiresConfirmation;
    if (typeof value === 'function') {
      try {
        return value(args) === true;
      } catch (error) {
        return true;
      }
    }
    return value === true;
  },
  runTool: async (call, ctx) => {
    calls.runTool.push({ call, ctx });
    return state.toolResult;
  },
};
const settingsStub = {
  getMcpServerSettings: async () => state.settings,
  patchMcpServerSettings: async patch => {
    calls.patch.push(patch);
    state.settings = { ...state.settings, ...patch };
    return state.settings;
  },
};
const workspaceStub = { getWorkspaceSettings: async () => state.workspaceSettings };
const assistantStub = { resolveWorkspaceAssistant: async () => state.assistant };
const hooksStub = {
  readHookPermissionRules: async (store, characterId) => {
    calls.permissionRules.push({ store, characterId });
    return [{ event: 'before_tool', matcher: 'run_shell', effect: 'deny' }];
  },
};
const nativeStub = {
  createWorkspaceStore: settings => { calls.createStore += 1; return { store: settings }; },
  describeWorkspaceRoot: () => { calls.describeRoot += 1; return { kind: 'app', uri: 'file:///ws', name: '' }; },
  registerDefaultWorkspaceTools: (settings, extras) => { calls.register.push({ settings, extras }); return []; },
};
const bridgeStub = {
  createMcpBridge: options => ({ options }),
  attachMcpServer: options => { calls.attach = options; return () => {}; },
  getMcpServerStatus: async () => ({ running: true, host: '127.0.0.1', port: state.settings.port, lanIp: '192.168.1.9', available: true }),
  startMcpServer: async args => {
    calls.start.push(args);
    if (state.startFails) throw new Error('MCP_SERVER_START_FAILED: Address already in use');
    return state.startResult;
  },
  stopMcpServer: async () => { calls.stop += 1; return true; },
};

const STUBS = new Map([
  [REGISTRY_PATH, registryStub],
  [SETTINGS_PATH, settingsStub],
  [WORKSPACE_PATH, workspaceStub],
  [ASSISTANT_PATH, assistantStub],
  [HOOKS_PATH, hooksStub],
  [NATIVE_PATH, nativeStub],
  [BRIDGE_PATH, bridgeStub],
]);

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (parent && parent.filename && request.startsWith('.')) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if (STUBS.has(resolved)) return STUBS.get(resolved);
  }
  return originalLoad.call(this, request, parent, isMain);
};
const transformed = babel.transformSync(fs.readFileSync(RUNTIME_PATH, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: RUNTIME_PATH,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;
const runtimeModule = new Module(RUNTIME_PATH);
runtimeModule.filename = RUNTIME_PATH;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(RUNTIME_PATH));
runtimeModule._compile(transformed, RUNTIME_PATH);
Module._load = originalLoad;
const runtime = runtimeModule.exports;

function reset() {
  calls.register = [];
  calls.runTool = [];
  calls.permissionRules = [];
  calls.start = [];
  calls.stop = 0;
  calls.patch = [];
  calls.createStore = 0;
  calls.describeRoot = 0;
  state.settings = { enabled: false, scope: 'loopback', port: 8737, mcpToken: '', tiers: { read: true, write: false, exec: false } };
  state.assistant = { character: { id: 'char-1', name: '助手' } };
  state.startResult = { running: true, host: '127.0.0.1', port: 8737, mcpToken: 'generated-token' };
  state.startFails = false;
}

test('executeMcpTool：档位 → 工作区模式（只读档 read，写入/执行档 write）', async () => {
  reset();
  await runtime.executeMcpTool({ name: 'read_workspace_file', args: { path: 'a' }, tier: 'read' });
  await runtime.executeMcpTool({ name: 'write_workspace_file', args: { path: 'a' }, tier: 'write' });
  await runtime.executeMcpTool({ name: 'run_shell', args: { command: 'ls' }, tier: 'exec' });
  assert.deepEqual(calls.runTool.map(item => item.ctx.mode), ['read', 'write', 'write']);
  assert.equal(calls.register.length, 3, '每次调用都重新注册工作区工具（幂等）');
  assert.deepEqual(calls.register[0].settings, state.workspaceSettings);
  assert.deepEqual(calls.register[0].extras, {}, '不注入 onPlan（与无头端点一致：不落盘）');
  assert.equal(calls.createStore, 3);
  assert.deepEqual(calls.runTool[0].call, { name: 'read_workspace_file', arguments: { path: 'a' } });
  assert.deepEqual(calls.runTool[0].ctx.characterId, 'char-1', '默认用工作助手沙盒');
  assert.equal(state.toolResult.content, 'ok');
});

test('executeMcpTool：工作区钩子规则照旧喂给 runTool（deny 不能被外部 agent 绕过）', async () => {
  reset();
  await runtime.executeMcpTool({ name: 'run_shell', args: { command: 'rm -rf /' }, tier: 'exec' });
  const ctx = calls.runTool[0].ctx;
  assert.equal(typeof ctx.permissionRules, 'function', 'permissionRules 必须是函数（每次现读 hooks.json）');
  const rules = await ctx.permissionRules();
  assert.equal(rules[0].effect, 'deny');
  assert.equal(calls.permissionRules[0].characterId, 'char-1');
  assert.deepEqual(calls.permissionRules[0].store, { store: state.workspaceSettings });
});

test('executeMcpTool：confirm 只放行「工具自己声明要确认」的工具', async () => {
  reset();
  await runtime.executeMcpTool({ name: 'run_shell', args: { command: 'ls' }, tier: 'exec' });
  const { confirm } = calls.runTool[0].ctx;
  assert.equal(await confirm({ name: 'run_shell', args: {} }), true, '声明了 requiresConfirmation → 档位+预览已经替用户回答了');
  assert.equal(await confirm({ name: 'read_workspace_file', args: {} }), false, '没声明 → 只可能是 hooks 的 ask 规则，问不到用户就拒绝');
  assert.equal(await confirm({ name: 'nonexistent', args: {} }), false, '未知工具一律拒绝');
});

test('executeMcpTool：confirm 必须认得出**函数形态** requiresConfirmation（fail-open 回归）', async () => {
  // 合并 m1015m1 时核实出的真缺陷：该批给 requiresConfirmation 加了函数形态
  //（control_music 按 action 分级），而 MCP 的 confirm 原先写
  // `definition.requiresConfirmation === true` —— 对函数形态恒为 false ⇒
  // 在 MCP 写档下 **control_music 不经确认就执行**（放行方向，fail-open）。
  // 这条用函数形态工具钉住修复：play 认得出（true），pause 不打扰（false）。
  reset();
  state.tools.control_music = {
    name: 'control_music',
    requiresConfirmation: args => (args && args.action === 'play') === true,
  };
  try {
    await runtime.executeMcpTool({ name: 'control_music', args: { action: 'play' }, tier: 'write' });
    const { confirm } = calls.runTool[0].ctx;
    assert.equal(await confirm({ name: 'control_music', args: { action: 'play' } }), true,
      '函数形态求值为 true 时必须放行（档位+预览已替用户回答）');
    assert.equal(await confirm({ name: 'control_music', args: { action: 'pause' } }), false,
      '函数形态求值为 false 时不打扰用户');
    // 分级函数坏掉 → fail-closed（宁可多问，不可静默放行）
    state.tools.broken_tool = { name: 'broken_tool', requiresConfirmation: () => { throw new Error('boom'); } };
    assert.equal(await confirm({ name: 'broken_tool', args: {} }), true,
      '判定函数抛错必须按「需要确认」处理');
  } finally {
    delete state.tools.control_music;
    delete state.tools.broken_tool;
  }
});

test('executeMcpTool：character_id 覆盖沙盒；解析不到时回落到传入的 id', async () => {
  reset();
  await runtime.executeMcpTool({ name: 'read_workspace_file', args: {}, tier: 'read', characterId: 'char-9' });
  assert.equal(calls.runTool[0].ctx.characterId, 'char-1', '工作助手解析得到时优先用解析结果');
  reset();
  state.assistant = null;
  await runtime.executeMcpTool({ name: 'read_workspace_file', args: {}, tier: 'read', characterId: 'char-9' });
  assert.equal(calls.runTool[0].ctx.characterId, 'char-9', '解析不到就用调用方给的');
});

test('syncMcpServer：关着就停服，开着按范围选绑定地址', async () => {
  reset();
  const off = await runtime.syncMcpServer();
  assert.equal(calls.stop, 1);
  assert.equal(calls.start.length, 0);
  assert.equal(off.settings.enabled, false);

  reset();
  state.settings = { ...state.settings, enabled: true, scope: 'loopback', port: 9000, mcpToken: 'user-token' };
  state.startResult = { running: true, host: '127.0.0.1', port: 9000, mcpToken: 'user-token' };
  await runtime.syncMcpServer();
  assert.deepEqual(calls.start[0], { host: '127.0.0.1', port: 9000, token: 'user-token' });
  assert.equal(calls.patch.length, 0, 'token 没变就不回写');

  reset();
  state.settings = { ...state.settings, enabled: true, scope: 'lan', port: 9000, mcpToken: 'user-token' };
  await runtime.syncMcpServer();
  assert.equal(calls.start[0].host, '0.0.0.0', '局域网绑通配地址');
});

test('syncMcpServer：原生生成的 token 必须回写（否则用户复制给 agent 的配置下次就失效）', async () => {
  reset();
  state.settings = { ...state.settings, enabled: true, mcpToken: '' };
  state.startResult = { running: true, host: '127.0.0.1', port: 8737, mcpToken: 'generated-token' };
  const applied = await runtime.syncMcpServer();
  assert.deepEqual(calls.patch, [{ mcpToken: 'generated-token' }]);
  assert.equal(applied.settings.mcpToken, 'generated-token');
  assert.equal(applied.status.available, true);
  assert.equal(applied.status.lanIp, '192.168.1.9', '状态里带上局域网地址，UI 才能拼连接配置');
});

test('syncMcpServer：起不来就回滚开关，不假装开着', async () => {
  reset();
  state.settings = { ...state.settings, enabled: true, port: 8737, mcpToken: 'tok' };
  state.startFails = true;
  const applied = await runtime.syncMcpServer();
  assert.deepEqual(calls.patch, [{ enabled: false }], '启动失败必须把开关回滚');
  assert.equal(applied.settings.enabled, false);
  assert.match(applied.error, /Address already in use/, '原因要如实带出来给界面');
});

test('describeMcpWorkspace / listToolDefinitions / createRuntimeMcpBridge 接线', async () => {
  reset();
  const info = await runtime.describeMcpWorkspace();
  assert.deepEqual(info, { kind: 'app', root: 'file:///ws', uri: 'file:///ws' });
  assert.equal(calls.describeRoot, 1);

  // listToolDefinitions 现在是 async：它必须先「确保工作区工具已注册」再读表
  // （同步版本会在注册之前读空表，真机上表现为 toolCount = 0）。
  assert.deepEqual((await runtime.listToolDefinitions()).map(t => t.name), ['run_shell', 'read_workspace_file']);

  const bridge = runtime.createRuntimeMcpBridge();
  assert.equal(typeof bridge.options.readSettings, 'function');
  assert.equal(typeof bridge.options.executeTool, 'function');
  const settings = await bridge.options.readSettings();
  assert.equal(settings.port, 8737);
  const list = await bridge.options.listDefinitions();
  assert.equal(list.length, 2);

  const detach = runtime.attachRuntimeMcpServer();
  assert.equal(typeof detach, 'function');
  // createMcpBridge 在本文件里也是替身，所以桥的「能力」看 options：
  // 真实能力（读设置 + 跑工具 + 工作区描述）必须一路传到 attach。
  assert.equal(typeof calls.attach.bridge.options.executeTool, 'function', 'attach 时把带真实能力的桥交出去');
  assert.equal(typeof calls.attach.bridge.options.readSettings, 'function');
});

// ── 真机实测的死锁（2026-10-21）：toolCount = 0 ──────────────────────────
//
// 现场：握手成功、Bearer 通过、只读档已开，但 tools/list 返回 0 个工具，
// 连 `list_workspace_files` 都被判「不在暴露清单里」。
//
// 根因：listToolDefinitions 只读注册表、不注册；而 registerDefaultWorkspaceTools
// 只在 executeMcpTool（执行时）里调用。于是：
//   tools/list 读空表 → agent 不知道有工具 → 不发起调用 → execute 不跑 → 表永远空。
//
// 这条测试钉住「读表之前必须已注册」，且注册**发生在读表那一刻**（不是靠别处副作用）。
test('listToolDefinitions 必须先注册再读表（否则 tools/list 永远返回空）', async () => {
  reset();
  // 前提：注册表此刻是空的（没有别的地方注册过）。
  state.tools = {};
  calls.register = [];
  assert.deepEqual(registryStub.listRegisteredTools(), [], '前提：注册表为空');

  // 桩模拟「注册会填充注册表」——真实 registerDefaultWorkspaceTools 就是这个效果。
  const originalRegister = nativeStub.registerDefaultWorkspaceTools;
  nativeStub.registerDefaultWorkspaceTools = (settings, extras) => {
    calls.register.push({ settings, extras });
    state.tools = {
      read_workspace_file: { name: 'read_workspace_file' },
      list_workspace_files: { name: 'list_workspace_files' },
    };
    return [];
  };
  try {
    const list = await runtime.listToolDefinitions();
    assert.equal(calls.register.length, 1, '读表前必须注册一次（且只一次）');
    assert.deepEqual(
      list.map(t => t.name).sort(),
      ['list_workspace_files', 'read_workspace_file'],
      '注册后必须能读到工具——这正是真机上缺失的那一步',
    );
  } finally {
    nativeStub.registerDefaultWorkspaceTools = originalRegister;
  }
});

test('工作区设置读不出时：listToolDefinitions 不抛，退回现有注册表', async () => {
  reset();
  const originalGet = workspaceStub.getWorkspaceSettings;
  workspaceStub.getWorkspaceSettings = async () => { throw new Error('storage broken'); };
  try {
    const list = await runtime.listToolDefinitions();
    // 不抛就算过：tools/list 失败会让整个 MCP 会话不可用，比「少几个工具」糟得多。
    assert.ok(Array.isArray(list), '必须返回数组而不是抛错');
  } finally {
    workspaceStub.getWorkspaceSettings = originalGet;
  }
});
