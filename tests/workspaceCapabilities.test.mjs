// 工作区能力说明的数据结构与渲染键（capabilities.js，纯数据）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  activeWorkspaceTools,
  CAPABILITY_INTRO_KEY,
  CAPABILITY_LIMITS,
  CAPABILITY_STEPS,
  CAPABILITY_TITLE_KEY,
  capabilityViewModel,
} from '../src/workspace/capabilities.js';
import {
  WORKSPACE_TOOL_NAMES,
  WRITE_ONLY_WORKSPACE_TOOL_NAMES,
} from '../src/workspace/tools.js';

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
  // 2026-10-11 审查 P1-4：这里**不再手抄**清单，而是从工具注册的唯一事实源（WORKSPACE_TOOL_NAMES）
  // 派生——手抄的那份漏了本次合并新增的 list_symbols 与 run_workflow，能力卡因此对用户说谎。
  assert.deepEqual(
    activeWorkspaceTools({ mode: 'read' }),
    WORKSPACE_TOOL_NAMES.filter(name => !WRITE_ONLY_WORKSPACE_TOOL_NAMES.includes(name)),
  );
  assert.deepEqual(activeWorkspaceTools({ mode: 'write', location: APP_ROOT }), [...WORKSPACE_TOOL_NAMES]);
  // 具体名单仍然钉死（派生关系正确 + 名单本身是人能读懂的契约）。
  assert.deepEqual(activeWorkspaceTools({ mode: 'read' }), [
    'list_workspace_files',
    'read_workspace_file',
    'search_workspace',
    'list_symbols',
    'find_references',
    'ask_user',
    'skill',
    'update_plan',
    'materialize_repo',
    'get_build_log',
    'run_subagent',
    'run_workflow',
    'run_team',
    'export_extension_pack',
  ]);
  assert.deepEqual(activeWorkspaceTools({ mode: 'write', location: APP_ROOT }), [
    'list_workspace_files',
    'read_workspace_file',
    'search_workspace',
    'list_symbols',
    'find_references',
    'ask_user',
    'skill',
    'update_plan',
    'materialize_repo',
    'get_build_log',
    'run_subagent',
    'run_workflow',
    'run_team',
    'export_extension_pack',
    'create_workspace_dir',
    'write_workspace_file',
    'edit_workspace_file',
    'run_remote_build',
    'export_workspace_docx',
    'install_extension_pack',
  ]);
});

// 回归 P1-4：能力卡的核心承诺是「如实回答现在开了哪些」。这条断言把清单**钉在门控上**：
// read 模式的清单必须恰好等于注册表 canRunTool 会放行的那些（readOnly === true），
// 于是「新增工具忘了同步能力卡」这类漏改在门禁上直接变红，而不是等用户发现卡片在说谎。
test('回归 P1-4：能力清单与注册表的模式门控同源（新增工具不会再漏）', async () => {
  const { createWorkspaceToolDefinitions } = await import('../src/workspace/tools.js');
  // 用真实定义聚合（不接 shell/python 桥，它们按开关单独加）。
  const definitions = createWorkspaceToolDefinitions({});
  const byName = new Map(definitions.map(item => [item.name, item]));
  // 1) 能力卡写的每个名字都必须在真实定义里存在（否则卡上写着「开着」而工具根本不存在）。
  for (const name of WORKSPACE_TOOL_NAMES) {
    assert.ok(byName.has(name), `能力清单里的 ${name} 必须有真实定义`);
  }
  // 2) write 模式清单 = 全部基础工具，且顺序与定义聚合一致。
  assert.deepEqual([...WORKSPACE_TOOL_NAMES], definitions
    .map(item => item.name)
    .filter(name => WORKSPACE_TOOL_NAMES.includes(name)));
  // 3) write 专属集合 = readOnly !== true 的那些——与 registry.canRunTool 的判据逐字一致。
  const expectedWriteOnly = definitions
    .filter(item => WORKSPACE_TOOL_NAMES.includes(item.name) && item.readOnly !== true)
    .map(item => item.name);
  assert.deepEqual([...WRITE_ONLY_WORKSPACE_TOOL_NAMES], expectedWriteOnly);
  // 4) read 模式清单必须恰好是「readOnly 为真」的那些（逐条比对，不靠集合大小）。
  const readList = activeWorkspaceTools({ mode: 'read' });
  const readOnlyNames = definitions
    .filter(item => WORKSPACE_TOOL_NAMES.includes(item.name) && item.readOnly === true)
    .map(item => item.name);
  assert.deepEqual([...readList].sort(), [...readOnlyNames].sort(), 'read 清单必须与门控放行的集合完全一致');
  // 5) 本次合并新增的两个工具必须在卡上（这就是 P1-4 漏掉的那两个）。
  assert.ok(readList.includes('list_symbols'), 'list_symbols（LSP-lite）必须在能力卡上');
  assert.ok(readList.includes('run_workflow'), 'run_workflow（依赖式编排）必须在能力卡上');
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
    // 三个「按开关注册」能力的渲染键（2026-10-12）：标志必须被画出来，文案也必须两语齐备。
    'workspace.capability.switchesTitle',
    'workspace.capability.switch.git',
    'workspace.capability.switch.on',
    'workspace.capability.switch.off',
    'workspace.capability.switch.row',
    'workspace.capability.switch.offNote',
    // shell / python 的名字复用工具卡词条（同一能力不该有两套叫法）。
    'workspace.toolCard.name.shell',
    'workspace.toolCard.name.python',
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
  // 新增的 switch.row 三个占位符中英一致（整行做成模板，语序随语言走）
  const zhSwitch = (zhCN['workspace.capability.switch.row'].match(/\{(\w+)\}/g) || []).join(',');
  const enSwitch = (en['workspace.capability.switch.row'].match(/\{(\w+)\}/g) || []).join(',');
  assert.equal(zhSwitch, enSwitch);
  assert.equal(zhSwitch, '{name},{state},{tools}');
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

// git 门控此前有**三处**平行定义（native.js 的 gitGateReason / 工具清单 / 界面标志），
// 而界面侧那处根本不存在（只有 shell/python 两个标志）。现在三者同源：gitEnabled 与
// 「清单里有没有 git_status」必须恒等，否则卡片会像当年 shellEnabled 那样说谎。
test('capabilityViewModel：gitEnabled 与工具集口径一致（第三处平行定义已收口）', () => {
  const on = { mode: 'read', allowLocalGit: true };
  const model = capabilityViewModel(on, {});
  assert.equal(model.gitEnabled, true);
  assert.ok(model.tools.includes('git_status'));

  const external = capabilityViewModel({ ...on, location: SAF_ROOT }, {});
  assert.equal(external.gitEnabled, false, '外部根下不可用（与 gitGateReason 的 EXTERNAL_ROOT 一致）');
  assert.equal(external.tools.includes('git_status'), false);

  const off = capabilityViewModel({ mode: 'read' }, {});
  assert.equal(off.gitEnabled, false, '开关关着不列');
  assert.equal(off.tools.includes('git_status'), false);

  // 不要求可改模式（read 模式正好用来回看自己改过什么），也不依赖原生模块
  //（isomorphic-git 是纯 JS，没有「原生模块不可用」这一层）。
  const readOnlyNoNative = capabilityViewModel(on, { shellAvailable: false, pythonAvailable: false });
  assert.equal(readOnlyNoNative.gitEnabled, true);
  // 但 ask 模式一个工具都不注册，标志也必须跟着灭。
  const ask = capabilityViewModel({ mode: 'ask', allowLocalGit: true }, {});
  assert.equal(ask.gitEnabled, false, 'ask 模式不注册任何工作区工具（agentToolSetup 的总闸）');
  assert.deepEqual(ask.tools, []);
});

// 三个标志与工具清单**恒等**：这条断言把「说明说开着、清单里没有」这类漂移挡在门禁上，
// 而不是等用户看到卡片在说谎。判定现在只有 switchedCapabilities 一份。
test('capabilityViewModel：shell/python/git 三个标志与工具清单恒等（判定只许有一份）', () => {
  const cases = [
    { mode: 'write', location: APP_ROOT, allowCommandExecution: true, allowPythonExecution: true, allowLocalGit: true },
    { mode: 'write', location: SAF_ROOT, allowCommandExecution: true, allowPythonExecution: true, allowLocalGit: true },
    { mode: 'read', location: APP_ROOT, allowCommandExecution: true, allowPythonExecution: true, allowLocalGit: true },
    { mode: 'ask', location: APP_ROOT, allowCommandExecution: true, allowPythonExecution: true, allowLocalGit: true },
    { mode: 'write', location: APP_ROOT },
    {},
  ];
  const availabilities = [
    { shellAvailable: true, pythonAvailable: true },
    { shellAvailable: false, pythonAvailable: false },
  ];
  for (const settings of cases) {
    for (const availability of availabilities) {
      const label = `${JSON.stringify(settings)} / ${JSON.stringify(availability)}`;
      const model = capabilityViewModel(settings, availability);
      assert.equal(model.shellEnabled, model.tools.includes('run_shell'), `shell 口径漂移：${label}`);
      assert.equal(model.pythonEnabled, model.tools.includes('run_python'), `python 口径漂移：${label}`);
      assert.equal(model.gitEnabled, model.tools.includes('git_status'), `git 口径漂移：${label}`);
    }
  }
});

test('2026-10-11：MCP 工具（含 GitHub）如实进能力卡清单（去重、跳过空名）', () => {
  const withMcp = activeWorkspaceTools(
    { mode: 'read' },
    { mcpToolNames: ['github_read_file', 'github_create_or_update_file', '', '  ', 'github_read_file'] },
  );
  assert.ok(withMcp.includes('github_read_file'), 'GitHub 工具在清单里');
  assert.ok(withMcp.includes('github_create_or_update_file'));
  assert.equal(withMcp.filter(name => name === 'github_read_file').length, 1, '不重复');
  assert.equal(withMcp.includes(''), false, '空名不进清单');
  // 没连 MCP 时清单不变（既有行为）
  assert.equal(activeWorkspaceTools({ mode: 'read' }).some(name => name.startsWith('github_')), false);
  // 与基础工具不冲突：传进来的名字若已在清单里不重复加
  const overlap = activeWorkspaceTools({ mode: 'read' }, { mcpToolNames: ['read_workspace_file'] });
  assert.equal(overlap.filter(name => name === 'read_workspace_file').length, 1);
});

// 三个 enabled 标志此前**只被测试消费**：capabilityViewModel 有 shellEnabled/pythonEnabled/
// gitEnabled，但卡片只画 model.tools ⇒「说明如实」只落在数据层，用户看不出哪个能力开着、
// 某个工具为什么不在清单里。这条断言把卡片里的开关表与 capabilityViewModel 钉在一起：
//   · 卡片声明的 enabledKey 必须是 capabilityViewModel 真有的字段（不是随手写的名字）；
//   · 开关开着时，卡片写在用户眼前的工具名必须真的出现在 model.tools 里（否则卡片在说谎）；
//   · 卡片必须**真的用**这些字段渲染（定义而不用 = 假修复）。
test('卡片渲染三个开关标志，且与 capabilityViewModel 的工具清单恒等', () => {
  const card = fs.readFileSync(path.resolve('src/WorkspaceCapabilitiesCard.js'), 'utf8');
  // 卡片里的开关表（模块级常量，逐条解析）
  const entries = [...card.matchAll(
    /\{\s*id:\s*'(\w+)',\s*labelKey:\s*'([^']+)',\s*enabledKey:\s*'(\w+)',\s*tools:\s*\[([^\]]*)\]\s*\}/g,
  )].map(match => ({
    id: match[1],
    labelKey: match[2],
    enabledKey: match[3],
    tools: match[4].split(',').map(part => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean),
  }));
  assert.deepEqual(entries.map(entry => entry.id), ['shell', 'python', 'git'],
    '卡片必须渲染 shell / python / git 三个开关');
  assert.equal(new Set(entries.map(entry => entry.enabledKey)).size, 3, 'enabledKey 不得重复');

  // 每个开关「开」的那组条件（与 capabilities.js 的 switchedCapabilities 口径一致）
  const onCases = {
    shell: [{ mode: 'write', location: APP_ROOT, allowCommandExecution: true }, { shellAvailable: true }],
    python: [{ mode: 'write', location: APP_ROOT, allowPythonExecution: true }, { pythonAvailable: true }],
    git: [{ mode: 'read', location: APP_ROOT, allowLocalGit: true }, {}],
  };
  const modelKeys = Object.keys(capabilityViewModel({}, {}));
  for (const entry of entries) {
    assert.ok(modelKeys.includes(entry.enabledKey),
      `卡片声明的 ${entry.enabledKey} 必须是 capabilityViewModel 真有的字段`);
    const [settings, availability] = onCases[entry.id];
    const on = capabilityViewModel(settings, availability);
    assert.equal(on[entry.enabledKey], true, `${entry.id} 在该条件下应判为开启`);
    for (const tool of entry.tools) {
      assert.ok(on.tools.includes(tool),
        `卡片说 ${entry.id} 开着时管着 ${tool}，但工具清单里没有它（卡片在说谎）`);
    }
    // 关掉时：标志为假，且这些工具确实不在清单里——「未生效 ⇒ 清单里没有」这句才成立
    const off = capabilityViewModel({ ...settings, allowCommandExecution: false, allowPythonExecution: false, allowLocalGit: false }, availability);
    assert.equal(off[entry.enabledKey], false, `${entry.id} 开关关着时标志必须为假`);
    for (const tool of entry.tools) {
      assert.equal(off.tools.includes(tool), false, `${entry.id} 未生效时 ${tool} 不该在清单里`);
    }
    assert.ok(entry.labelKey.startsWith('workspace.'), `${entry.id} 的标签必须走 i18n 键`);
  }

  // 卡片必须真的用这些字段与键渲染（定义而不用 = 假修复）
  assert.ok(card.includes('model[item.enabledKey]'),
    '卡片必须直接读 capabilityViewModel 的标志来渲染开关状态');
  assert.ok(card.includes("t('workspace.capability.switchesTitle')"), '开关区必须有标题');
  assert.ok(card.includes("t(on ? 'workspace.capability.switch.on' : 'workspace.capability.switch.off')"),
    '开关状态必须走 i18n 词条（中英都要有）');
  assert.ok(card.includes("t('workspace.capability.switch.row'"),
    '每个开关必须用整行模板列出它管着的工具（语序/标点随语言走，不焊死在 JSX 里）');
  assert.ok(card.includes("tools: item.tools.join"), '整行模板必须填入该开关真正管着的工具名');
  assert.ok(card.includes("t('workspace.capability.switch.offNote')"), '必须说明「未生效 ⇒ 清单里没有」');
});
