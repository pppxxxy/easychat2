// 工作区能力说明的数据结构与渲染键（capabilities.js，纯数据）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeWorkspaceTools,
  CAPABILITY_INTRO_KEY,
  CAPABILITY_LIMITS,
  CAPABILITY_STEPS,
  CAPABILITY_TITLE_KEY,
  capabilityViewModel,
} from '../src/workspace/capabilities.js';

const APP_ROOT = { kind: 'app', uri: '', name: '' };
const SAF_ROOT = { kind: 'saf', uri: 'content://tree/primary%3ADocs', name: 'Docs' };

test('1→5 循环恰好五步，顺序与语义对应需求原文', () => {
  assert.deepEqual(CAPABILITY_STEPS.map(step => step.id), ['receive', 'compose', 'decide', 'execute', 'answer']);
  // 每步都要有可翻译的键，且不重复
  const keys = CAPABILITY_STEPS.map(step => step.labelKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every(key => key.startsWith('workspace.capability.step.')));
});

test('边界条目覆盖五条硬约束（工具集 / 两个开关 / 隔离 / 外部根 / shell 范围）+ 本地模型 + 工作区记忆 + 持久会话', () => {
  assert.deepEqual(CAPABILITY_LIMITS.map(limit => limit.id), [
    'tools', 'memory', 'shellSwitch', 'pythonSwitch', 'pythonIsolation', 'externalRoot', 'shellScope', 'shellSession', 'localModel', 'githubImport',
  ]);
  // memory（AGENTS.md）虽不是「限制」，但会被自动注入且可被 agent 自行改写——
  // 用户必须能在能力说明里看到它、知道删掉即恢复默认（自我演进 ≠ 失控）。
});

test('activeWorkspaceTools：按模式给出真实工具集', () => {
  assert.deepEqual(activeWorkspaceTools({ mode: 'ask' }), [], '询问模式一个工具都没有');
  assert.deepEqual(activeWorkspaceTools(null), []);
  assert.deepEqual(activeWorkspaceTools({ mode: 'read' }), ['list_workspace_files', 'read_workspace_file', 'search_workspace', 'update_plan', 'materialize_repo', 'get_build_log', 'run_subagent']);
  assert.deepEqual(activeWorkspaceTools({ mode: 'write', location: APP_ROOT }), [
    'list_workspace_files',
    'read_workspace_file',
    'search_workspace',
    'update_plan',
    'materialize_repo',
    'get_build_log',
    'run_subagent',
    'create_workspace_dir',
    'write_workspace_file',
    'edit_workspace_file',
    'run_remote_build',
    'export_workspace_docx',
  ]);
});

test('run_shell 只有「开关开 + 可改 + 应用内根 + 原生可用」才出现在清单里', () => {
  const base = { mode: 'write', location: APP_ROOT, allowCommandExecution: true };
  assert.ok(activeWorkspaceTools(base, { shellAvailable: true }).includes('run_shell'));
  // 四种缺一不可，逐个验证
  assert.equal(activeWorkspaceTools({ ...base, allowCommandExecution: false }, { shellAvailable: true }).includes('run_shell'), false);
  assert.equal(activeWorkspaceTools({ ...base, location: SAF_ROOT }, { shellAvailable: true }).includes('run_shell'), false);
  assert.equal(activeWorkspaceTools(base, { shellAvailable: false }).includes('run_shell'), false);
  assert.equal(activeWorkspaceTools({ ...base, mode: 'read' }, { shellAvailable: true }).includes('run_shell'), false);
});

// run_python 与 run_shell 同一套门控，但看的是**另一个开关**（allowPythonExecution）。
// 「开命令执行就顺带出现 run_python」是必须被钉死的错误——两条执行面风险不同，
// 用户只授权了 shell 却拿到能联网的 Python，是安全开关最糟的形态。
test('run_python 门控与 run_shell 同形，但用独立开关（互不代偿）', () => {
  const shellOn = { mode: 'write', location: APP_ROOT, allowCommandExecution: true, allowPythonExecution: false };
  const shellTools = activeWorkspaceTools(shellOn, { shellAvailable: true, pythonAvailable: true });
  assert.ok(shellTools.includes('run_shell'));
  assert.equal(shellTools.includes('run_python'), false, '只开命令执行不得出现 run_python');

  const pythonOn = { mode: 'write', location: APP_ROOT, allowCommandExecution: false, allowPythonExecution: true };
  const pythonTools = activeWorkspaceTools(pythonOn, { shellAvailable: true, pythonAvailable: true });
  assert.ok(pythonTools.includes('run_python'));
  assert.equal(pythonTools.includes('run_shell'), false, '只开 Python 不得出现 run_shell');

  // 四种缺一不可
  const base = { mode: 'write', location: APP_ROOT, allowPythonExecution: true };
  assert.equal(activeWorkspaceTools({ ...base, allowPythonExecution: false }, { pythonAvailable: true }).includes('run_python'), false);
  assert.equal(activeWorkspaceTools({ ...base, location: SAF_ROOT }, { pythonAvailable: true }).includes('run_python'), false);
  assert.equal(activeWorkspaceTools(base, { pythonAvailable: false }).includes('run_python'), false);
  assert.equal(activeWorkspaceTools({ ...base, mode: 'read' }, { pythonAvailable: true }).includes('run_python'), false);
});

test('capabilityViewModel：界面渲染模型齐备且 shellEnabled 口径与工具集一致', () => {
  const model = capabilityViewModel({ mode: 'write', location: APP_ROOT, allowCommandExecution: true }, { shellAvailable: true });
  assert.equal(model.titleKey, CAPABILITY_TITLE_KEY);
  assert.equal(model.introKey, CAPABILITY_INTRO_KEY);
  assert.equal(model.steps.length, 5);
  assert.equal(model.limits.length, CAPABILITY_LIMITS.length);
  assert.ok(model.limitsTitleKey);
  assert.ok(model.tools.includes('run_shell'));
  assert.equal(model.shellEnabled, true);
  // 外部根下 shellEnabled 必须跟着工具集一起变 false，不能出现「说明说开着、工具却没有」
  const external = capabilityViewModel({ mode: 'write', location: SAF_ROOT, allowCommandExecution: true }, { shellAvailable: true });
  assert.equal(external.shellEnabled, false);
  assert.equal(external.tools.includes('run_shell'), false);
  // 询问模式
  const ask = capabilityViewModel({ mode: 'ask' }, {});
  assert.deepEqual(ask.tools, []);
  assert.equal(ask.shellEnabled, false);
  assert.equal(ask.pythonEnabled, false);
});

// 说明里的 pythonEnabled 必须与工具集口径一致：说「开着」但工具不在清单里
// （或反过来）都是误导——这正是「能力说明」这个模块存在的意义。
test('capabilityViewModel：pythonEnabled 与工具集口径一致', () => {
  const on = { mode: 'write', location: APP_ROOT, allowPythonExecution: true };
  const model = capabilityViewModel(on, { pythonAvailable: true });
  assert.equal(model.pythonEnabled, true);
  assert.ok(model.tools.includes('run_python'));

  const external = capabilityViewModel({ ...on, location: SAF_ROOT }, { pythonAvailable: true });
  assert.equal(external.pythonEnabled, false, '外部根下不可用，说明也必须跟着变');
  assert.equal(external.tools.includes('run_python'), false);

  const notIsolated = capabilityViewModel(on, { pythonAvailable: false });
  assert.equal(notIsolated.pythonEnabled, false, '原生侧不可用时说明不能说「开着」');
});

test('能力说明的每个键都在两种语言里有词条', async () => {
  const { zhCN } = await import('../src/i18n/locales/zh-CN.js');
  const { en } = await import('../src/i18n/locales/en.js');
  const keys = [
    CAPABILITY_TITLE_KEY,
    CAPABILITY_INTRO_KEY,
    capabilityViewModel({}, {}).limitsTitleKey,
    'workspace.capability.toolsNow',
    'workspace.capability.toolsNone',
    ...CAPABILITY_STEPS.map(step => step.labelKey),
    ...CAPABILITY_LIMITS.map(limit => limit.labelKey),
  ];
  for (const key of keys) {
    assert.equal(typeof zhCN[key], 'string', `中文缺 ${key}`);
    assert.ok(zhCN[key], `中文 ${key} 为空`);
    assert.equal(typeof en[key], 'string', `英文缺 ${key}`);
    assert.ok(en[key], `英文 ${key} 为空`);
  }
  // {tools} 占位符中英一致
  const zh = (zhCN['workspace.capability.toolsNow'].match(/\{(\w+)\}/g) || []).join(',');
  const eng = (en['workspace.capability.toolsNow'].match(/\{(\w+)\}/g) || []).join(',');
  assert.equal(zh, eng);
  assert.equal(zh, '{tools}');
});

test('W7：开了本地版本控制且应用内根时，卡片如实列出三个 git 只读工具', () => {
  const read = activeWorkspaceTools({ mode: 'read', allowLocalGit: true });
  for (const name of ['git_status', 'git_diff', 'git_log']) {
    assert.ok(read.includes(name), `${name} 应出现在卡片清单里（与门控条件一致）`);
  }
  const saf = activeWorkspaceTools({ mode: 'read', allowLocalGit: true, location: { kind: 'saf', uri: 'content://x', name: 'x' } });
  assert.equal(saf.includes('git_status'), false, '外部根下没有 git（与 gitGateReason 一致）');
  assert.equal(activeWorkspaceTools({ mode: 'read' }).includes('git_status'), false, '开关关着不列');
});
