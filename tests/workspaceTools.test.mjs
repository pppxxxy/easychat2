import test from 'node:test';
import assert from 'node:assert/strict';

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
    'list_symbols',
    'ask_user',
    'update_plan',
    'materialize_repo',
    'get_build_log',
    'run_subagent',
    'run_workflow',
    'create_workspace_dir',
    'write_workspace_file',
    'edit_workspace_file',
    'run_remote_build',
    'export_workspace_docx',
  ]);
  assert.deepEqual(listToolsForMode(AGENT_MODES.ASK), []);
  assert.deepEqual(
    listToolsForMode(AGENT_MODES.READ).map(item => item.function.name),
    ['list_workspace_files', 'read_workspace_file', 'search_workspace', 'list_symbols', 'ask_user', 'update_plan', 'materialize_repo', 'get_build_log', 'run_subagent', 'run_workflow'],
  );
  assert.deepEqual(
    listToolsForMode(AGENT_MODES.WRITE).map(item => item.function.name),
    ['list_workspace_files', 'read_workspace_file', 'search_workspace', 'list_symbols', 'ask_user', 'update_plan', 'materialize_repo', 'get_build_log', 'run_subagent', 'run_workflow', 'create_workspace_dir', 'write_workspace_file', 'edit_workspace_file', 'run_remote_build', 'export_workspace_docx'],
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

  // agent 仍要能写自己的技能 / 命令 / 分身 / 钩子（T4/T5/T6/E3 的自我演进通路）
  for (const path of [
    '.easychat/skills/demo/SKILL.md',
    '.easychat/commands/demo.md',
    '.easychat/agents/demo.md',
    '.easychat/hooks.json',
  ]) {
    const allowed = await runTool(
      { name: 'write_workspace_file', arguments: JSON.stringify({ path, content: 'x' }) },
      { mode: AGENT_MODES.WRITE, characterId: 'c1' },
    );
    assert.equal(allowed.isError, false, `${path} 应仍可写`);
  }
});