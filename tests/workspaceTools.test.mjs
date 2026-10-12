import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  AGENT_MODES,
  clearTools,
  getTool,
  listToolsForMode,
  runTool,
} from '../src/agent/tools/registry.js';
import {
  createWorkspaceToolDefinitions,
  formatWorkspaceReadResult,
  WORKSPACE_TOOL_NAMES,
  registerWorkspaceTools,
  unregisterWorkspaceTools,
} from '../src/workspace/tools.js';
import * as docxModule from '../src/workspace/docx.js';
import { setDocxModule } from '../src/workspace/toolDefs/docxTool.js';
import { READ_ONLY_TOOL_DEFINITIONS } from '../src/workspace/toolDefs/readTools.js';
import { SEARCH_TOOL_DEFINITION } from '../src/workspace/toolDefs/searchTool.js';
import { PLAN_TOOL_DEFINITION } from '../src/workspace/toolDefs/planTool.js';
import { MATERIALIZE_TOOL_DEFINITION } from '../src/workspace/toolDefs/materializeTool.js';
import { GET_BUILD_LOG_DEFINITION, RUN_REMOTE_BUILD_DEFINITION } from '../src/workspace/toolDefs/ciTools.js';
import { WRITE_TOOL_DEFINITIONS } from '../src/workspace/toolDefs/writeTools.js';
import { SUBAGENT_TOOL_DEFINITION } from '../src/workspace/toolDefs/subagentTool.js';
import { PYTHON_TOOL_DEFINITION, SHELL_TOOL_DEFINITION } from '../src/workspace/toolDefs/execTools.js';
import { SHELL_TOOL_TIMEOUT_MS } from '../src/workspace/shell.js';
import { PYTHON_TOOL_TIMEOUT_MS } from '../src/workspace/python.js';
import { hookPermissionRules, parseWorkspaceHooks } from '../src/workspace/hooks.js';

// 钩子规则走真实链路：hooks.json 文本 → parseWorkspaceHooks（归一成 pattern）→
// hookPermissionRules（翻成权限规则）。手搓 {match:...} 对象会跳过归一化，
// 测出来的东西就不是生产里跑的那条链（本轮多个 P0 都源于此类假输入）。
function hookRulesFromJson(json) {
  return hookPermissionRules(parseWorkspaceHooks(JSON.stringify(json)));
}

function createMemoryFs() {
  const entries = new Map();
  const api = {
    documentDirectory: '/doc/',
    async getInfoAsync(uri) {
      const key = entries.has(uri) ? uri : (entries.has(`${uri}/`) ? `${uri}/` : null);
      if (!key) return { exists: false };
      return { exists: true, isDirectory: entries.get(key).type === 'dir' };
    },
    async makeDirectoryAsync(uri, options) {
      const full = uri.endsWith('/') ? uri : `${uri}/`;
      if (options && options.intermediates) {
        let acc = '';
        for (const part of full.split('/').filter(Boolean)) {
          acc += `/${part}`;
          entries.set(`${acc}/`, { type: 'dir' });
        }
        return;
      }
      entries.set(full, { type: 'dir' });
    },
    async readDirectoryAsync(uri) {
      const prefix = uri.endsWith('/') ? uri : `${uri}/`;
      const names = new Set();
      for (const key of entries.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length).replace(/\/$/, '');
        if (!rest) continue;
        names.add(rest.split('/')[0]);
      }
      if (names.size === 0) throw new Error('ENOENT');
      return [...names];
    },
    async readAsStringAsync(uri) {
      const entry = entries.get(uri);
      if (!entry || entry.type !== 'file') throw new Error('ENOENT');
      return entry.content;
    },
    async writeAsStringAsync(uri, text) {
      entries.set(uri, { type: 'file', content: String(text) });
    },
  };
  return api;
}

const root = '/doc/workspace/';
let fileSystem;

test.beforeEach(() => {
  clearTools();
  fileSystem = createMemoryFs();
});

test('registerWorkspaceTools 按模式暴露工具', () => {
  registerWorkspaceTools({ root, fileSystem });
  assert.deepEqual(WORKSPACE_TOOL_NAMES, [
    'list_workspace_files',
    'read_workspace_file',
    'search_workspace',
    'list_symbols', 'find_references',
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
  assert.deepEqual(listToolsForMode(AGENT_MODES.ASK), []);
  assert.deepEqual(
    listToolsForMode(AGENT_MODES.READ).map(item => item.function.name),
    ['list_workspace_files', 'read_workspace_file', 'search_workspace', 'list_symbols', 'find_references', 'ask_user', 'skill', 'update_plan', 'materialize_repo', 'get_build_log', 'run_subagent', 'run_workflow', 'run_team', 'export_extension_pack'],
  );
  assert.deepEqual(
    listToolsForMode(AGENT_MODES.WRITE).map(item => item.function.name),
    ['list_workspace_files', 'read_workspace_file', 'search_workspace', 'list_symbols', 'find_references', 'ask_user', 'skill', 'update_plan', 'materialize_repo', 'get_build_log', 'run_subagent', 'run_workflow', 'run_team', 'export_extension_pack', 'create_workspace_dir', 'write_workspace_file', 'edit_workspace_file', 'run_remote_build', 'export_workspace_docx', 'install_extension_pack'],
  );
});

test('工作区工具经 runTool 读写（以 ctx.characterId 分沙盒）', async () => {
  registerWorkspaceTools({ root, fileSystem });
  const written = await runTool(
    { name: 'write_workspace_file', arguments: '{"path":"notes/a.md","content":"你好"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(written.isError, false);
  assert.match(written.content, /已写入 notes\/a.md/);

  const read = await runTool(
    { name: 'read_workspace_file', arguments: '{"path":"notes/a.md"}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.equal(read.content, '你好');

  const list = await runTool(
    { name: 'list_workspace_files', arguments: '{}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  // J1：写前快照在 .easychat/file-history/ 下（隐形历史——列表里只见 .easychat/
  // 目录条目，entries/ 与 index.json 被过滤），用户文件照常。
  assert.equal(list.content, '.easychat/\nnotes/\nnotes/a.md');

  // 另一个角色是独立沙盒
  const other = await runTool(
    { name: 'list_workspace_files', arguments: '{}' },
    { mode: AGENT_MODES.READ, characterId: 'c2' },
  );
  assert.equal(other.content, '（工作区为空）');
});

test('只读模式下写工具被门控，非法扩展名以错误结果返回', async () => {
  registerWorkspaceTools({ root, fileSystem });
  const denied = await runTool(
    { name: 'write_workspace_file', arguments: '{"path":"b.md","content":"x"}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.equal(denied.isError, true);
  assert.match(denied.content, /当前模式不允许/);

  const badPath = await runTool(
    { name: 'write_workspace_file', arguments: '{"path":"a.png","content":"x"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(badPath.isError, true);
  assert.match(badPath.content, /只能读写文本文件/);
});

test('unregisterWorkspaceTools 清理注册', () => {
  registerWorkspaceTools({ root, fileSystem });
  unregisterWorkspaceTools();
  assert.deepEqual(listToolsForMode(AGENT_MODES.WRITE), []);
});

test('export_workspace_docx 仅在可改模式生成 .docx 并可被 list 看到', async () => {
  // docx.js 在工具层是惰性 require（不把 fflate 拖进加载链）；纯 ESM 测试环境
  // 没有 require，用注入点把真实模块接进来——生产走 Metro 的 require，无需注入。
  setDocxModule(docxModule);
  registerWorkspaceTools({ root, fileSystem });
  const exported = await runTool(
    { name: 'export_workspace_docx', arguments: '{"path":"report.docx","content":"第一段\\n第二段","title":"报告"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(exported.isError, false);
  assert.match(exported.content, /已导出 report\.docx/);

  const list = await runTool(
    { name: 'list_workspace_files', arguments: '{}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.equal(list.content, 'report.docx');

  // 只读模式下导出被门控
  const denied = await runTool(
    { name: 'export_workspace_docx', arguments: '{"path":"x.docx","content":"x"}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.equal(denied.isError, true);
  assert.match(denied.content, /当前模式不允许/);

  // 非 .docx 路径拒绝
  const wrongExt = await runTool(
    { name: 'export_workspace_docx', arguments: '{"path":"x.txt","content":"x"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(wrongExt.isError, true);
  assert.match(wrongExt.content, /必须以 \.docx 结尾/);
});
test('edit_workspace_file：替换唯一一处，返回替换处数', async () => {
  registerWorkspaceTools({ root, fileSystem });
  await runTool(
    { name: 'write_workspace_file', arguments: '{"path":"a.md","content":"# 标题\\n旧句子\\n结尾"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  const edited = await runTool(
    { name: 'edit_workspace_file', arguments: '{"path":"a.md","find":"旧句子","replace":"新句子"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(edited.isError, false);
  assert.match(edited.content, /已修改 a\.md（替换 1 处）/);

  const read = await runTool(
    { name: 'read_workspace_file', arguments: '{"path":"a.md"}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.equal(read.content, '# 标题\n新句子\n结尾');
});

test('edit_workspace_file：多处匹配默认拒绝，all:true 才全替换', async () => {
  registerWorkspaceTools({ root, fileSystem });
  await runTool(
    { name: 'write_workspace_file', arguments: '{"path":"a.md","content":"猫 猫 猫"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  const ambiguous = await runTool(
    { name: 'edit_workspace_file', arguments: '{"path":"a.md","find":"猫","replace":"狗"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content, /匹配到 3 处/);

  const all = await runTool(
    { name: 'edit_workspace_file', arguments: '{"path":"a.md","find":"猫","replace":"狗","all":true}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(all.isError, false);
  assert.match(all.content, /替换 3 处/);
  const read = await runTool(
    { name: 'read_workspace_file', arguments: '{"path":"a.md"}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.equal(read.content, '狗 狗 狗');
});

test('edit_workspace_file：只读模式门控 + 找不到原文报错 + 不许清空', async () => {
  registerWorkspaceTools({ root, fileSystem });
  await runTool(
    { name: 'write_workspace_file', arguments: '{"path":"a.md","content":"正文"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  const denied = await runTool(
    { name: 'edit_workspace_file', arguments: '{"path":"a.md","find":"正文","replace":"x"}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.equal(denied.isError, true);
  assert.match(denied.content, /当前模式不允许/);

  const missing = await runTool(
    { name: 'edit_workspace_file', arguments: '{"path":"a.md","find":"不存在的句子","replace":"x"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(missing.isError, true);
  assert.match(missing.content, /未找到要替换的原文/);

  const empty = await runTool(
    { name: 'edit_workspace_file', arguments: '{"path":"a.md","find":"正文","replace":""}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(empty.isError, true);
  assert.match(empty.content, /不能为空/);

  // 越界路径照旧被路径守卫拦住
  const escape = await runTool(
    { name: 'edit_workspace_file', arguments: '{"path":"../x.md","find":"a","replace":"b"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(escape.isError, true);
  assert.match(escape.content, /越出工作区/);
});

test('工具定义只认 store 接口：注入自定义后端即可整体换根', async () => {
  // 这条钉住「换根不用换工具」：store 是唯一的注入面，root/fileSystem 不再被工具层直接使用。
  const calls = [];
  const fakeStore = {
    rootKind: 'saf',
    async listWorkspaceFiles(args) { calls.push(['list', args]); return ['x.md']; },
    async readWorkspaceFile(args) { calls.push(['read', args]); return { path: args.path, content: 'hi', truncated: false }; },
    async writeWorkspaceFile(args) { calls.push(['write', args]); return { path: args.path, length: 2 }; },
    async writeWorkspaceBinaryFile(args) { calls.push(['writeBinary', args]); return { path: args.path, base64Length: 4 }; },
    async editWorkspaceFile(args) { calls.push(['edit', args]); return { path: args.path, count: 1, length: 3 }; },
  };
  registerWorkspaceTools({ store: fakeStore });
  const listed = await runTool(
    { name: 'list_workspace_files', arguments: '{"subdir":"notes"}' },
    { mode: AGENT_MODES.READ, characterId: 'c9' },
  );
  assert.equal(listed.content, 'x.md');
  assert.deepEqual(calls[0], ['list', { characterId: 'c9', subdir: 'notes', match: '' }]);
  const edited = await runTool(
    { name: 'edit_workspace_file', arguments: '{"path":"x.md","find":"h","replace":"H"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c9' },
  );
  assert.equal(edited.isError, false);
  // J1：edit 前有快照读取（宽上限读旧内容），快照记录的条目/index 写入也走同一
  // fakeStore——断言钉语义（edit 恰好一次、参数正确），不钉调用顺序细节。
  const kinds = calls.slice(1).map(item => item[0]);
  assert.equal(kinds[0], 'read', 'edit 前先快照读旧内容');
  assert.equal(kinds.filter(kind => kind === 'edit').length, 1, 'edit 恰好一次');
  const editCall = calls.find(item => item[0] === 'edit');
  assert.deepEqual(editCall[1], { characterId: 'c9', path: 'x.md', find: 'h', replace: 'H', all: false });
  const snapshotRead = calls.slice(1).find(item => item[0] === 'read');
  assert.equal(snapshotRead[1].maxChars, 8388608, '快照读取用宽上限（截断内容不配当旧版本）');
});

test('create_workspace_dir：可改模式建目录，只读模式被门控', async () => {
  registerWorkspaceTools({ root, fileSystem });
  const created = await runTool(
    { name: 'create_workspace_dir', arguments: '{"path":"src/components"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(created.isError, false);
  assert.match(created.content, /已创建目录 src\/components\//);
  const listed = await runTool(
    { name: 'list_workspace_files', arguments: '{}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.match(listed.content, /src\/components\//);

  const denied = await runTool(
    { name: 'create_workspace_dir', arguments: '{"path":"x"}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.equal(denied.isError, true, '只读模式下建目录被门控');
});

test('read_workspace_file：offset/limit 分段读取与续读提示', async () => {
  registerWorkspaceTools({ root, fileSystem });
  await runTool(
    { name: 'write_workspace_file', arguments: '{"path":"big.txt","content":"0123456789"}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  const head = await runTool(
    { name: 'read_workspace_file', arguments: '{"path":"big.txt","limit":4}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.match(head.content, /^0123/);
  assert.match(head.content, /共 10 字符，本次为 0–4；继续读取请用 offset=4/);
  const tail = await runTool(
    { name: 'read_workspace_file', arguments: '{"path":"big.txt","offset":4,"limit":4}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.match(tail.content, /^4567/);
  assert.match(tail.content, /继续读取请用 offset=8/);
  const end = await runTool(
    { name: 'read_workspace_file', arguments: '{"path":"big.txt","offset":8}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.match(end.content, /^89/);
  assert.match(end.content, /已到文件末尾：共 10 字符/);
  const beyond = await runTool(
    { name: 'read_workspace_file', arguments: '{"path":"big.txt","offset":999}' },
    { mode: AGENT_MODES.READ, characterId: 'c1' },
  );
  assert.match(beyond.content, /已到文件末尾/);
});

test('read_workspace_file：limit 收敛到 1MB 上限（防上下文爆炸）', async () => {
  const calls = [];
  const fakeStore = {
    readWorkspaceFile: async args => {
      calls.push(args);
      return { path: args.path, content: 'x', truncated: false, offset: 0, total: 1 };
    },
  };
  const definitions = createWorkspaceToolDefinitions({ store: fakeStore });
  const readDef = definitions.find(item => item.name === 'read_workspace_file');
  await readDef.execute({ path: 'a.txt', limit: 99999999 }, {});
  assert.equal(calls[0].maxChars, 1024 * 1024, '超大 limit 必须被收敛到上限');
  await readDef.execute({ path: 'a.txt' }, {});
  assert.equal(calls[1].maxChars, undefined, '不传 limit → 走后端默认');
  await readDef.execute({ path: 'a.txt', offset: -5 }, {});
  assert.equal(calls[2].offset, 0, '负 offset 归零');
});

test('formatWorkspaceReadResult：默认完整读不加后缀，截断/分段才加提示', () => {
  assert.equal(
    formatWorkspaceReadResult({ path: 'a.txt', content: '全文', truncated: false, offset: 0, total: 2 }),
    '全文',
    '完整读取原样返回（既有行为不变）'
  );
  assert.match(
    formatWorkspaceReadResult({ path: 'a.txt', content: 'ab', truncated: true, offset: 0, total: 10, nextOffset: 2 }),
    /共 10 字符，本次为 0–2；继续读取请用 offset=2/
  );
  assert.match(
    formatWorkspaceReadResult({ path: 'a.txt', content: 'ij', truncated: false, offset: 8, total: 10 }),
    /已到文件末尾：共 10 字符/
  );
});

// ---- 工具超时（2026-10-10 修 P0-4：定义声明的 timeoutMs 曾被静默丢弃）----

test('工具超时：定义声明的 timeoutMs 原样生效，未声明的走兜底表/默认', () => {
  const definitions = createWorkspaceToolDefinitions({
    store: {},
    shell: async () => {},
    python: async () => {},
    ci: {},
  });
  const byName = new Map(definitions.map(item => [item.name, item]));

  // 这三个此前只吃到注册表默认 15s，长任务必然被误判「超时」（结果未知）——
  // 模型看到不确定可能重跑写操作，所以这条断言钉的是行为正确性，不只是数值。
  assert.equal(byName.get('run_subagent').timeoutMs, 300000, '子代理多轮模型请求：声明 300s 必须生效');
  assert.equal(byName.get('run_remote_build').timeoutMs, 60000, '触发云构建：声明 60s 必须生效');
  assert.equal(byName.get('get_build_log').timeoutMs, 90000, '下载解包构建日志：声明 90s 必须生效');

  // 定义里没写 timeoutMs 的两个执行工具仍由兜底表给长超时。
  assert.equal(byName.get('run_shell').timeoutMs, SHELL_TOOL_TIMEOUT_MS);
  assert.equal(byName.get('run_python').timeoutMs, PYTHON_TOOL_TIMEOUT_MS);

  // 其余工具不写 timeoutMs，交给注册表默认——不能顺手塞值（否则默认值改动失效）。
  assert.equal(byName.get('list_workspace_files').timeoutMs, undefined);
  assert.equal(byName.get('write_workspace_file').timeoutMs, undefined);
});

test('工具超时：注册表实例也拿到长超时（端到端，不只纯函数层）', () => {
  registerWorkspaceTools({ root, fileSystem, shell: async () => {}, python: async () => {}, ci: {} });
  assert.equal(getTool('run_subagent').timeoutMs, 300000);
  assert.equal(getTool('get_build_log').timeoutMs, 90000);
  assert.equal(getTool('run_remote_build').timeoutMs, 60000);
  assert.equal(getTool('run_shell').timeoutMs, SHELL_TOOL_TIMEOUT_MS);
  // 未声明的工具由注册表归一成默认 15000ms。
  assert.equal(getTool('read_workspace_file').timeoutMs, 15000);
});

test('工具超时：所有声明 timeoutMs 的定义都被透传（新增工具不会静默丢失）', () => {
  const raw = [
    ...READ_ONLY_TOOL_DEFINITIONS,
    SEARCH_TOOL_DEFINITION,
    PLAN_TOOL_DEFINITION,
    MATERIALIZE_TOOL_DEFINITION,
    GET_BUILD_LOG_DEFINITION,
    SUBAGENT_TOOL_DEFINITION,
    ...WRITE_TOOL_DEFINITIONS,
    RUN_REMOTE_BUILD_DEFINITION,
    SHELL_TOOL_DEFINITION,
    PYTHON_TOOL_DEFINITION,
  ];
  const registered = new Map(
    createWorkspaceToolDefinitions({
      store: {},
      shell: async () => {},
      python: async () => {},
      ci: {},
    }).map(item => [item.name, item])
  );
  const declared = raw.filter(item => Number.isFinite(Number(item.timeoutMs)) && Number(item.timeoutMs) > 0);
  // 这条守卫靠「声明集合非空」才有意义：至少覆盖当前三个长任务工具。
  assert.ok(declared.length >= 3, `声明了 timeoutMs 的定义应至少 3 个，实际 ${declared.length}`);
  for (const item of declared) {
    assert.equal(
      registered.get(item.name).timeoutMs,
      item.timeoutMs,
      `${item.name} 声明的 timeoutMs 必须原样生效（不要退回只读兜底表的写法）`
    );
  }
});

// ---- 受保护写入路径（审计与快照，2026-10-10）----

test('审计/快照文件不可被写工具改写，相邻的 agent 资产不受影响', async () => {
  registerWorkspaceTools({ root, fileSystem });
  const protectedPaths = [
    '.easychat/sessions/s1.jsonl',
    '.easychat/file-history/index.json',
    '.easychat/file-history/entries/abc.json',
    '.easychat/rollback/1700000000000.json',
  ];
  for (const path of protectedPaths) {
    const denied = await runTool(
      { name: 'write_workspace_file', arguments: JSON.stringify({ path, content: 'tampered' }) },
      { mode: AGENT_MODES.WRITE, characterId: 'c1' },
    );
    assert.equal(denied.isError, true, `${path} 的写入应被拒绝`);
    assert.match(denied.content, /不允许改写/);
  }

  const editDenied = await runTool(
    {
      name: 'edit_workspace_file',
      arguments: JSON.stringify({ path: '.easychat/sessions/s1.jsonl', find: 'a', replace: 'b' }),
    },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(editDenied.isError, true, 'edit 同样被拦（不只是 write）');
  assert.match(editDenied.content, /不允许改写/);

  // agent 仍要能写自己的技能 / 命令 / 分身（T4/T5/T6/E3 的自我演进通路）
  for (const path of [
    '.easychat/skills/demo/SKILL.md',
    '.easychat/commands/demo.md',
    '.easychat/agents/demo.md',
  ]) {
    const allowed = await runTool(
      { name: 'write_workspace_file', arguments: JSON.stringify({ path, content: 'x' }) },
      { mode: AGENT_MODES.WRITE, characterId: 'c1' },
    );
    assert.equal(allowed.isError, false, `${path} 应仍可写`);
  }

  // ⚠️ P1-4（2026-10-12）：hooks.json 从「应仍可写」改成**必须被拦**。
  // 此前它在这条白名单里，而 hooks.js 的注释「agent 可读写——只能收紧不能放宽」**不成立**：
  // 写工具不逐条确认，写成 `{}` 就抹掉用户全部预置禁令（清空 = 最彻底的放宽）。
  // 同一文件走「安装包」要 requiresConfirmation，走「写文件」却无声覆盖 —— 威胁模型不一致。
  const hooksDenied = await runTool(
    { name: 'write_workspace_file', arguments: JSON.stringify({ path: '.easychat/hooks.json', content: '{}' }) },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(hooksDenied.isError, true, 'hooks.json 是权限面，写工具不得覆盖它');
  assert.match(hooksDenied.content, /不允许改写/);

  const hooksEditDenied = await runTool(
    {
      name: 'edit_workspace_file',
      arguments: JSON.stringify({ path: '.easychat/hooks.json', find: 'a', replace: 'b' }),
    },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(hooksEditDenied.isError, true, 'edit 同样被拦（不只是 write）');
});

// P1 回归（2026-10-11）：**所有**带 path 的写类工具都必须守住受保护路径。
//
// 事故形态：守卫此前只加在 write_workspace_file / edit_workspace_file 上——
// create_workspace_dir（能造出 .easychat/sessions/ 这类目录）与 export_workspace_docx
// 是漏的。这类漏法靠「逐个手抄要检查的工具名」永远补不干净，所以这里**从真实定义表
// 派生**待检查集合：凡 readOnly !== true 且参数里有 path 的工具，一律拿受保护路径打一遍。
// 新增写工具只要声明了 path 就自动进入这条守卫，忘了加 assertWritableWorkspacePath 会红。
// P1 回归（2026-10-11）：before_tool 钩子的 deny 必须对**不需要确认的工具**生效。
//
// 事故形态：钩子规则的唯一求值入口是 onToolApproval（宿主接的 confirm），而 runTool
// 只在 tool.requiresConfirmation 时才调 confirm。write_workspace_file 按设计不逐条确认
//（见 paths.js 的说明），于是挂在它上面的 before_tool deny 永不求值——与 hooks.js
// 「拦下任意工具」的承诺矛盾。修法：runTool 直接对 ctx.permissionRules 求值。
test('P1 回归：不需确认的写工具也受 before_tool deny 规则约束（钩子规则真的拦得住）', async () => {
  registerWorkspaceTools({ root, fileSystem });
  // 用真实定义表里的规则翻译器：hooks.json 的 before_tool → 权限规则
  const rules = hookRulesFromJson({
    before_tool: [{ tool: 'write_workspace_file', match: '**/*.md', message: '不许改 md', effect: 'deny' }],
  });
  assert.equal(rules.length, 1, '前置条件：钩子规则确实翻译出了一条');
  assert.equal(rules[0].match, '**/*.md', '前置条件：匹配串没有在归一化里丢掉');

  const denied = await runTool(
    { name: 'write_workspace_file', arguments: JSON.stringify({ path: 'notes/a.md', content: 'x' }) },
    { mode: AGENT_MODES.WRITE, characterId: 'c1', permissionRules: () => rules },
  );
  assert.equal(denied.isError, true, 'deny 规则命中时必须拒绝（此前永不求值）');
  assert.match(denied.content, /before_tool/);

  // 行为断言：被拒的写入不得落盘
  const listed = await runTool(
    { name: 'list_workspace_files', arguments: '{}' },
    { mode: AGENT_MODES.WRITE, characterId: 'c1' },
  );
  assert.equal(String(listed.content).includes('notes/a.md'), false, '被拦下的写入不得落盘');

  // 规则只覆盖 md：别的扩展名照旧可写（deny 不误伤）
  const allowed = await runTool(
    { name: 'write_workspace_file', arguments: JSON.stringify({ path: 'notes/a.txt', content: 'x' }) },
    { mode: AGENT_MODES.WRITE, characterId: 'c1', permissionRules: () => rules },
  );
  assert.equal(allowed.isError, false, '规则未命中时照常执行');
});

test('P1 回归：ask 规则让「不需确认的工具」也走审批；问不到用户则拒绝', async () => {
  registerWorkspaceTools({ root, fileSystem });
  const rules = hookRulesFromJson({
    before_tool: [{ tool: 'write_workspace_file', effect: 'ask', message: '写之前先问' }],
  });
  // 没有 confirm 出口 → 拒绝（与 requiresConfirmation 同款纪律：问不到 = 不执行）
  const noOutlet = await runTool(
    { name: 'write_workspace_file', arguments: JSON.stringify({ path: 'ask/a.md', content: 'x' }) },
    { mode: AGENT_MODES.WRITE, characterId: 'c1', permissionRules: rules },
  );
  assert.equal(noOutlet.isError, true, 'ask 规则命中但问不到用户 → 必须拒绝');
  assert.match(noOutlet.content, /需要用户确认/);

  // 有出口且批准 → 执行
  const approved = await runTool(
    { name: 'write_workspace_file', arguments: JSON.stringify({ path: 'ask/a.md', content: 'x' }) },
    { mode: AGENT_MODES.WRITE, characterId: 'c1', permissionRules: rules, confirm: async () => true },
  );
  assert.equal(approved.isError, false, '用户批准后照常执行');
  // 有出口但拒绝 → 不执行
  const rejected = await runTool(
    { name: 'write_workspace_file', arguments: JSON.stringify({ path: 'ask/b.md', content: 'x' }) },
    { mode: AGENT_MODES.WRITE, characterId: 'c1', permissionRules: rules, confirm: async () => false },
  );
  assert.equal(rejected.isError, true);
  assert.match(rejected.content, /拒绝/);
});

test('P1 回归：宿主把 permissionRules 接到 runAgentTurn 上（否则规则等于没接）', () => {
  const loop = fs.readFileSync(path.resolve('src/agent/loop.js'), 'utf8');
  assert.ok(loop.includes('permissionRules'), 'loop.js 必须把 permissionRules 透传给 runTool');
  // ⚠️ P0-2（2026-10-12）：必须是 readToolPermissionRules（钩子规则 + 用户存储规则合并）。
  // 此前两处宿主都只接 readHookPermissionRules ⇒ 设置页手写的 deny 对「不逐条确认的工具」
  // 是死键（它们走不到 approveToolCall，唯一求值入口就是这里）。
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  assert.ok(
    /permissionRules:\s*async\s*\(\)\s*=>\s*readToolPermissionRules\(/.test(panel),
    '工作区宿主必须接上「钩子 + 存储」合并后的规则',
  );
  assert.ok(
    !/permissionRules:\s*\(\)\s*=>\s*readHookPermissionRules\(/.test(panel),
    '工作区宿主不得只接钩子规则（会让手写 deny 失效）',
  );
  const chat = fs.readFileSync(path.resolve('src/chat/useChatSend.js'), 'utf8');
  assert.ok(
    /permissionRules:\s*async\s*\(\)\s*=>\s*readToolPermissionRules\(/.test(chat),
    '聊天宿主必须接上「钩子 + 存储」合并后的规则',
  );
  assert.ok(
    !/permissionRules:\s*\(\)\s*=>\s*readHookPermissionRules\(/.test(chat),
    '聊天宿主不得只接钩子规则（会让手写 deny 失效）',
  );
});

// ⚠️ P0-0（2026-10-12）：宿主接的是 **async** 读盘函数，而 registry 曾经**不 await** 它。
// 不 await 拿到 Promise ⇒ Array.isArray(Promise) 恒 false ⇒ if 分支永不进入 ⇒ ruleVerdict 恒 null
// ⇒ 2026-10-11 那次「让 deny 对任意工具生效」的修复**从未生效**。
// 测试此前全绿是因为用例传的是**同步数组**，而生产传的是 **async 函数** —— 形状不一致的缺口。
// 这条用 **async 函数**做输入，把「必须 await」钉成不变量。
test('P0-0 回归：permissionRules 是 async 函数时规则仍然生效（registry 必须 await）', async () => {
  registerWorkspaceTools({ root, fileSystem });
  const rules = hookRulesFromJson({
    before_tool: [{ tool: 'write_workspace_file', match: '**/*.md', message: '不许改 md', effect: 'deny' }],
  });
  // async 函数 = 生产形状（readToolPermissionRules / readHookPermissionRules 都是 async）
  const denied = await runTool(
    { name: 'write_workspace_file', arguments: JSON.stringify({ path: 'async/a.md', content: 'x' }) },
    { mode: AGENT_MODES.WRITE, characterId: 'c1', permissionRules: async () => rules },
  );
  assert.equal(denied.isError, true, 'async permissionRules 的 deny 必须生效（漏 await 时这里会是 false）');
  assert.match(denied.content, /before_tool/);

  // 反向：async 返回空数组不得误拦
  const allowed = await runTool(
    { name: 'write_workspace_file', arguments: JSON.stringify({ path: 'async/a.txt', content: 'x' }) },
    { mode: AGENT_MODES.WRITE, characterId: 'c1', permissionRules: async () => [] },
  );
  assert.equal(allowed.isError, false, 'async 空规则不得误拦');

  // 源码锚点：await 必须在，且必须 await 的是函数调用结果（防有人改回同步写法）
  const registry = fs.readFileSync(path.resolve('src/agent/tools/registry.js'), 'utf8');
  assert.ok(
    /await\s+ctx\.permissionRules\(\)/.test(registry),
    'registry 必须 await ctx.permissionRules()（宿主接的是 async 函数）',
  );
});

test('P1 回归：所有带 path 的写类工具都守住审计/快照路径（从真实定义表派生）', async () => {
  const definitions = createWorkspaceToolDefinitions({ root, fileSystem });
  const writeTools = definitions.filter(item => (
    item.readOnly !== true
    && item.parameters
    && item.parameters.properties
    && item.parameters.properties.path
  ));
  // 覆盖非空才有意义：至少要盖住这四个已知的「写文件/建目录/导出」
  const names = writeTools.map(item => item.name);
  for (const expected of [
    'create_workspace_dir',
    'write_workspace_file',
    'edit_workspace_file',
    'export_workspace_docx',
  ]) {
    assert.ok(names.includes(expected), `${expected} 应在待检查集合里（实际：${names.join(', ')}）`);
  }

  const protectedPath = '.easychat/sessions/tamper.jsonl';
  for (const tool of writeTools) {
    const protectedPathForTool = tool.name === 'export_workspace_docx'
      ? '.easychat/sessions/tamper.docx'
      : protectedPath;
    await assert.rejects(
      () => tool.execute({ path: protectedPathForTool, content: 'x', find: 'a', replace: 'b', title: 't' }, { characterId: 'c1' }),
      /不允许改写/,
      `${tool.name} 必须拒绝受保护路径（否则审计流可被写工具改写）`
    );
  }

  // 行为断言：整轮下来沙盒里不得留下任何 .easychat 文件（守卫缺失时这里会先红）
  const listTool = definitions.find(item => item.name === 'list_workspace_files');
  const listing = await listTool.execute({}, { characterId: 'c1' });
  assert.equal(
    String(listing.content).includes('.easychat'),
    false,
    '受保护路径不得被写类工具落盘'
  );
});