// 权限规则引擎测试（spec 2026-10-09-agent-extensibility T3）。
//
// ① 纯函数（agent/permissions.js）直接 ESM import——零依赖模块；
// ② 存储（workspacePermissions.js）与审批流转（toolApprovalFlow.js）走
//    mock AsyncStorage + loadModule（babel CJS 图，同 securityStorage 的范式）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import {
  commandPrefixMatches,
  evaluatePermissionRules,
  makePermissionRule,
  normalizePermissionRules,
  pathMatchesGlob,
  permissionMatchValue,
} from '../src/agent/permissions.js';
// P0-6 第二个入口：hooks.json 的 before_shell 也能产出 ask 规则（纯 ESM，直连即可）。
import { parseWorkspaceHooks, shellHookRules } from '../src/workspace/hooks.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');

const SRC_DIR = path.resolve('src');
const PERMISSIONS_KEY = '@easychat2_workspace_permissions';
const store = new Map();

const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
  multiRemove: async keys => { keys.forEach(key => store.delete(key)); },
  getAllKeys: async () => [...store.keys()],
};

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
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
    return { documentDirectory: 'file:///documents/', cacheDirectory: 'file:///cache/', EncodingType: {}, getInfoAsync: async () => ({ exists: false }) };
  }
  if (request === 'expo-sqlite') return { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  // **只接管 src/ 内的相对导入**（chat / storage / agent 一起进 babel 图，
  // 保证同一测试里多个入口共享同一份模块实例——会话规则要能互相看到）。
  // 不限定目录会把 babel 自己的相对 require 也卷进来：reentrant preset 死循环。
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

function clearCache() {
  Object.keys(Module._cache).forEach(key => {
    if (key.startsWith(`${SRC_DIR}${path.sep}`)) delete Module._cache[key];
  });
}

// 每个用例一套干净的存储与模块图；返回同一图里的存储模块与流转模块。
function loadStack() {
  store.clear();
  clearCache();
  const permissions = loadModule(path.resolve('src/storage/settings/workspacePermissions.js'));
  const flow = loadModule(path.resolve('src/chat/toolApprovalFlow.js'));
  return { permissions, flow };
}

// ---------- ① 纯函数 ----------

test('pathMatchesGlob：* 不跨层、** 跨任意层（含零层）、大小写敏感、归一 ./ 与尾斜杠', () => {
  assert.equal(pathMatchesGlob('*.md', 'README.md'), true);
  assert.equal(pathMatchesGlob('*.md', 'docs/README.md'), false, '* 不跨目录');
  assert.equal(pathMatchesGlob('src/*.js', 'src/app.js'), true);
  assert.equal(pathMatchesGlob('src/*.js', 'src/lib/app.js'), false);
  assert.equal(pathMatchesGlob('src/**/*.js', 'src/lib/app.js'), true);
  assert.equal(pathMatchesGlob('src/**/*.js', 'src/app.js'), true, '**/ 也能匹配零层');
  assert.equal(pathMatchesGlob('src/**', 'src/lib/app.js'), true);
  assert.equal(pathMatchesGlob('./src/*.js', 'src/a.js'), true, '开头的 ./ 归一掉');
  assert.equal(pathMatchesGlob('src/', 'src'), true, '尾斜杠不影响匹配');
  assert.equal(pathMatchesGlob('*.MD', 'a.md'), false, '大小写敏感：规则语义不随平台漂移');
  assert.equal(pathMatchesGlob('', 'a.md'), false, '空 pattern 不匹配任何路径');
  assert.equal(pathMatchesGlob('**', 'anything/at/all.js'), true);
});

test('commandPrefixMatches：词边界——绝不静默放行「前缀相同但其实是另一条命令」', () => {
  assert.equal(commandPrefixMatches('npm install', 'npm install'), true);
  assert.equal(commandPrefixMatches('npm install', 'npm install express'), true);
  assert.equal(commandPrefixMatches('npm install', '  npm install express  '), true, '两侧空白先归一');
  assert.equal(commandPrefixMatches('npm install', 'npm installx'), false, '纯 startsWith 会在这里放行一条没审过的命令');
  assert.equal(commandPrefixMatches('npm install', 'npm install-a'), false, '连字符是词的一部分（install-a ≠ install）');
  assert.equal(commandPrefixMatches('npm install', 'npm install && rm -rf /'), true, 'shell 分隔符算边界');
  assert.equal(commandPrefixMatches('npm install', 'npm install | tee log'), true);
  assert.equal(commandPrefixMatches('', 'anything'), false, '空前缀不匹配（空规则不是全放行）');
  assert.equal(commandPrefixMatches(null, 'x'), false);
});

test('permissionMatchValue：command/code 优先、其次 path、都没有才是 any', () => {
  assert.deepEqual(permissionMatchValue({ command: 'ls', path: 'a.txt' }), { kind: 'command', value: 'ls' });
  assert.deepEqual(permissionMatchValue({ code: 'print(1)' }), { kind: 'command', value: 'print(1)' });
  assert.deepEqual(permissionMatchValue({ path: 'src/a.js' }), { kind: 'path', value: 'src/a.js' });
  assert.deepEqual(permissionMatchValue({}), { kind: 'any', value: '' });
  assert.deepEqual(permissionMatchValue(null), { kind: 'any', value: '' });
});

test('evaluatePermissionRules：deny 最高优先（与顺序无关）；无命中返回 null（此时才弹框）', () => {
  const allowNpm = { effect: 'allow', tool: 'run_shell', match: 'npm install', scope: 'always' };
  assert.equal(
    evaluatePermissionRules([allowNpm], { tool: 'run_shell', args: { command: 'npm install express' } }),
    'allow'
  );
  assert.equal(
    evaluatePermissionRules([allowNpm], { tool: 'run_shell', args: { command: 'rm -rf /' } }),
    null,
    '没命中就是没命中——只有 null 才允许弹框'
  );
  const denyNpm = { effect: 'deny', tool: 'run_shell', match: 'npm install', scope: 'always' };
  assert.equal(
    evaluatePermissionRules([allowNpm, denyNpm], { tool: 'run_shell', args: { command: 'npm install express' } }),
    'deny'
  );
  assert.equal(
    evaluatePermissionRules([denyNpm, allowNpm], { tool: 'run_shell', args: { command: 'npm install express' } }),
    'deny',
    'deny 优先与规则顺序无关'
  );
  // ask 档（2026-10-10）：从宽规则里挖例外——ask 压过 allow，但压不过 deny。
  const askNpm = { effect: 'ask', tool: 'run_shell', match: 'npm install', scope: 'always' };
  assert.equal(
    evaluatePermissionRules([allowNpm, askNpm], { tool: 'run_shell', args: { command: 'npm install express' } }),
    'ask',
    'ask 必须压过 allow（否则「放行 git 但 push 要先问」这类例外形同虚设）'
  );
  assert.equal(
    evaluatePermissionRules([askNpm, allowNpm], { tool: 'run_shell', args: { command: 'npm install express' } }),
    'ask',
    'ask 优先与规则顺序无关'
  );
  assert.equal(
    evaluatePermissionRules([allowNpm, askNpm, denyNpm], { tool: 'run_shell', args: { command: 'npm install express' } }),
    'deny',
    'deny 仍压过 ask（安全不回退）'
  );
  assert.equal(
    evaluatePermissionRules([askNpm], { tool: 'run_shell', args: { command: 'npm run build' } }),
    null,
    'ask 规则不命中时仍返回 null'
  );
  assert.equal(
    normalizePermissionRules([{ effect: 'ask', tool: 'run_shell' }])[0].effect,
    'ask',
    'ask 是合法 effect（归一化不把它降级成 allow）'
  );
  // 工具级规则：空 match = 该工具全部调用
  const toolWide = { effect: 'allow', tool: 'list_workspace_files', match: '', scope: 'always' };
  assert.equal(evaluatePermissionRules([toolWide], { tool: 'list_workspace_files', args: {} }), 'allow');
  assert.equal(evaluatePermissionRules([toolWide], { tool: 'run_shell', args: { command: 'ls' } }), null, '不影响别的工具');
  // 路径规则（glob）
  const pathRule = { effect: 'allow', tool: 'write_workspace_file', match: 'src/**/*.js', scope: 'always' };
  assert.equal(
    evaluatePermissionRules([pathRule], { tool: 'write_workspace_file', args: { path: 'src/lib/a.js' } }),
    'allow'
  );
  assert.equal(
    evaluatePermissionRules([pathRule], { tool: 'write_workspace_file', args: { path: 'docs/a.js' } }),
    null
  );
  // 工具通配 '*'
  const anyTool = { effect: 'allow', tool: '*', match: '', scope: 'session' };
  assert.equal(evaluatePermissionRules([anyTool], { tool: 'whatever', args: {} }), 'allow');
  // 带 match 但调用没有可比的原文：不命中（宁问不猜）
  assert.equal(
    evaluatePermissionRules([allowNpm], { tool: 'run_shell', args: {} }),
    null
  );
});

test('makePermissionRule：记「用户看到的那条原文」，不自动放宽', () => {
  const rule = makePermissionRule({ tool: 'run_shell', args: { command: '  npm install express  ' } });
  assert.equal(rule.match, 'npm install express', '只 trim，不取首词、不截短——放宽是用户手写规则的活');
  assert.equal(rule.effect, 'allow');
  assert.equal(rule.scope, 'always');
  assert.equal(rule.tool, 'run_shell');
  assert.equal(makePermissionRule({ tool: 'run_shell', args: { command: 'ls' }, scope: 'session' }).scope, 'session');
  assert.equal(makePermissionRule({ tool: 'write_workspace_file', args: { path: 'a/b.txt' } }).match, 'a/b.txt');
  assert.equal(makePermissionRule({ tool: '' }), null);
  assert.equal(makePermissionRule({ tool: 'x', args: {} }).match, '', '无原文 → 工具级规则');
});

test('normalizePermissionRules：剔除非法、去重、同规则 scope 升级为 always', () => {
  const rules = normalizePermissionRules([
    null,
    {},
    { tool: '' },
    { effect: 'weird', tool: 'x', match: 'm' },
    { tool: 'x', match: 'm', scope: 'session' },
    { tool: 'x', match: 'm' },
  ]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].effect, 'allow', '未知 effect 归一为 allow');
  assert.equal(rules[0].scope, 'always', '同规则合并：语义更强的一方胜出');
});

// ---------- ② 存储 ----------

test('存储：落盘 CRUD 幂等、会话规则绝不落盘、清空两清、损坏备份', async () => {
  const { permissions: mod } = loadStack();
  assert.deepEqual(await mod.getPermissionRules(), []);

  await mod.addPermissionRule({ effect: 'allow', tool: 'run_shell', match: 'npm install' });
  const disk = await mod.getPermissionRules();
  assert.equal(disk.length, 1);
  assert.equal(disk[0].scope, 'always');
  assert.ok(String(store.get(PERMISSIONS_KEY)).includes('npm install'), '规则已落盘');

  await mod.addPermissionRule({ effect: 'allow', tool: 'run_shell', match: 'npm install' });
  assert.equal((await mod.getPermissionRules()).length, 1, '重复规则不重复写');

  mod.addSessionPermissionRule({ tool: 'run_python', match: 'print(1)' });
  assert.equal((await mod.getEffectivePermissionRules()).length, 2, '合并读能看到会话规则');
  assert.equal(String(store.get(PERMISSIONS_KEY)).includes('print(1)'), false, '会话规则绝不落盘（重启即忘是承诺）');

  assert.equal(await mod.removePermissionRule({ effect: 'allow', tool: 'run_shell', match: 'npm install' }), true);
  assert.equal((await mod.getPermissionRules()).length, 0);
  assert.equal(await mod.removePermissionRule({ effect: 'allow', tool: 'run_shell', match: 'npm install' }), false, '删不存在的返回 false');

  await mod.addPermissionRule({ effect: 'allow', tool: 'a', match: 'b' });
  mod.addSessionPermissionRule({ tool: 'c', match: 'd' });
  await mod.clearPermissionRules();
  assert.equal((await mod.getPermissionRules()).length, 0);
  assert.equal(mod.getSessionPermissionRules().length, 0, '清除是两清：永久 + 本次会话');
});

test('存储损坏：备份原始值并按空处理，不静默覆盖', async () => {
  const { permissions: mod } = loadStack();
  store.set(PERMISSIONS_KEY, '{not json');
  assert.deepEqual(await mod.getPermissionRules(), []);
  assert.ok(store.has(`${PERMISSIONS_KEY}__corrupt_backup`), '损坏值已备份');
});

// ---------- ③ 审批流转 ----------

test('approveToolCall：无规则弹框 → 本次会话允许 → 同命令不再问、别的命令仍要问', async () => {
  const { flow } = loadStack();
  const t = key => key;

  let asked = 0;
  const sessionAlert = { alert(title, body, buttons) { asked += 1; buttons[1].onPress(); } };
  const first = await flow.approveToolCall({
    name: 'run_shell',
    args: { command: 'npm install express' },
    t,
    showAlert: sessionAlert,
  });
  assert.equal(first, true);
  assert.equal(asked, 1);

  const never = { alert() { throw new Error('不该再问：会话规则已命中'); } };
  assert.equal(
    await flow.approveToolCall({ name: 'run_shell', args: { command: 'npm install express --save' }, t, showAlert: never }),
    true,
    '词边界命中（多了参数也算同一条命令）'
  );
  let askedAgain = 0;
  const denyAlert = { alert(title, body, buttons) { askedAgain += 1; buttons[0].onPress(); } };
  assert.equal(
    await flow.approveToolCall({ name: 'run_shell', args: { command: 'rm -rf /' }, t, showAlert: denyAlert }),
    false,
    '会话规则只放行那一条命令，不是放行整个工具'
  );
  assert.equal(askedAgain, 1);
});

test('approveToolCall：永远允许落盘 → 重启（重载模块图）后仍免问', async () => {
  const { flow } = loadStack();
  const t = key => key;
  const alwaysAlert = { alert(title, body, buttons) { buttons[2].onPress(); } };
  assert.equal(
    await flow.approveToolCall({ name: 'run_python', args: { code: 'print(1)' }, t, showAlert: alwaysAlert }),
    true
  );
  assert.ok(String(store.get(PERMISSIONS_KEY)).includes('print(1)'), '永远允许必须落盘');

  // 模拟重启：只清模块缓存（内存会话没了），盘上内容保留。
  clearCache();
  const flow2 = loadModule(path.resolve('src/chat/toolApprovalFlow.js'));
  const never = { alert() { throw new Error('重启后盘上规则应命中'); } };
  assert.equal(
    await flow2.approveToolCall({ name: 'run_python', args: { code: 'print(1)' }, t, showAlert: never }),
    true
  );
});

test('approveToolCall：deny 规则最高优先（数据层支持，弹框不产出）', async () => {
  const { permissions: mod, flow } = loadStack();
  const t = key => key;
  mod.addSessionPermissionRule({ effect: 'allow', tool: 'run_shell', match: 'ls' });
  await mod.addPermissionRule({ effect: 'deny', tool: 'run_shell', match: 'ls' });
  const never = { alert() { throw new Error('deny 规则命中不该弹框'); } };
  assert.equal(await flow.approveToolCall({ name: 'run_shell', args: { command: 'ls -al' }, t, showAlert: never }), false);
});

test('approveToolCall：弹框被关掉（dismiss）一律拒绝', async () => {
  const { flow } = loadStack();
  const dismissed = { alert(title, body, buttons, options) { options.onDismiss(); } };
  assert.equal(
    await flow.approveToolCall({ name: 'run_shell', args: { command: 'ls' }, t: key => key, showAlert: dismissed }),
    false
  );
});

test('approveToolCall：extraRules（工作区钩子禁令）deny 命中不弹框；没命中照常问', async () => {
  const { flow } = loadStack();
  const t = key => key;
  const extraRules = [{ effect: 'deny', tool: 'run_shell', match: 'git push', scope: 'session' }];
  const never = { alert() { throw new Error('钩子禁令命中不该弹框：用户早已表态'); } };
  assert.equal(
    await flow.approveToolCall({
      name: 'run_shell',
      args: { command: 'git push origin main' },
      t,
      showAlert: never,
      extraRules,
    }),
    false
  );
  let asked = 0;
  const denyAlert = { alert(title, body, buttons) { asked += 1; buttons[0].onPress(); } };
  assert.equal(
    await flow.approveToolCall({
      name: 'run_shell',
      args: { command: 'ls' },
      t,
      showAlert: denyAlert,
      extraRules,
    }),
    false
  );
  assert.equal(asked, 1, '没命中钩子的命令照常弹框');
});

// ---------- ④ P0-6 的 ask 规则创建入口（两个） ----------

test('设置面板入口：手写的 ask 规则落盘后命中，弹框只给「允许这一次」且不记规则', async () => {
  const { permissions: mod, flow } = loadStack();
  const t = key => key;
  // 表单最终就是这一句：normalizePermissionRule（面板里做）→ addPermissionRule（宿主里做）。
  await mod.addPermissionRule({ effect: 'ask', tool: 'run_shell', match: 'git push' });
  const disk = await mod.getPermissionRules();
  assert.equal(disk.length, 1);
  assert.equal(disk[0].effect, 'ask', 'ask 档能落盘（存储层不对 effect 做白名单）');

  let buttonsSeen = 0;
  const onceAlert = {
    alert(title, body, buttons) {
      buttonsSeen = buttons.length;
      buttons[1].onPress(); // [拒绝, 允许这一次]
    },
  };
  assert.equal(
    await flow.approveToolCall({
      name: 'run_shell',
      args: { command: 'git push origin main' },
      t,
      showAlert: onceAlert,
    }),
    true,
    '命中 ask：用户点了「允许这一次」→ 这次执行'
  );
  assert.equal(buttonsSeen, 2, 'ask 档只给两个选项（没有「本次会话允许 / 永远允许」）');

  // 关键：批准**不记规则**——否则一次点击就把「必须先问」永久解除。
  let askedAgain = 0;
  const againAlert = {
    alert(title, body, buttons) {
      askedAgain += 1;
      buttons[1].onPress();
    },
  };
  assert.equal(
    await flow.approveToolCall({
      name: 'run_shell',
      args: { command: 'git push --force' },
      t,
      showAlert: againAlert,
    }),
    true
  );
  assert.equal(askedAgain, 1, '下一次同类调用仍然要问');
  assert.equal((await mod.getPermissionRules()).length, 1, '盘上仍然只有那条 ask 规则，没有被批准追加 allow');
  assert.equal(mod.getSessionPermissionRules().length, 0, '也没有悄悄记一条会话规则');
});

test('hooks.json 入口：before_shell 写 effect:ask，经 extraRules 走同一套「只允许这一次」', async () => {
  const { flow } = loadStack();
  const t = key => key;
  const extraRules = shellHookRules(parseWorkspaceHooks({
    before_shell: [{ match: 'git push', message: '推送先问我', effect: 'ask' }],
  }));
  assert.equal(extraRules[0].effect, 'ask');

  let buttonsSeen = 0;
  const onceAlert = {
    alert(title, body, buttons) {
      buttonsSeen = buttons.length;
      buttons[1].onPress();
    },
  };
  assert.equal(
    await flow.approveToolCall({
      name: 'run_shell',
      args: { command: 'git push origin main' },
      t,
      showAlert: onceAlert,
      extraRules,
    }),
    true
  );
  assert.equal(buttonsSeen, 2, '钩子 ask 与手写 ask 是同一条链路：同样只给两个选项');

  // 没命中的命令照常走普通三选一弹框。
  let plainButtons = 0;
  const plainAlert = {
    alert(title, body, buttons) {
      plainButtons = buttons.length;
      buttons[0].onPress();
    },
  };
  assert.equal(
    await flow.approveToolCall({
      name: 'run_shell',
      args: { command: 'ls' },
      t,
      showAlert: plainAlert,
      extraRules,
    }),
    false
  );
  assert.equal(plainButtons, 3, '没命中 ask 的命令仍是普通三选项');
});
