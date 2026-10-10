// M 系：工作区搜索工具 + 列表 match + 读指引修复。
import test from 'node:test';
import assert from 'node:assert/strict';

import { clearTools, listToolsForMode, runTool, AGENT_MODES } from '../src/agent/tools/registry.js';
import { createWorkspaceToolDefinitions, registerWorkspaceTools } from '../src/workspace/tools.js';
import { searchWorkspaceText, SEARCH_TOOL_OUTPUT_CHARS } from '../src/workspace/toolDefs/searchTool.js';
import { serializeToolResult } from '../src/agent/messages.js';

// ---- 内存文件系统（与 workspaceTools.test 同款最小实现） ----
function createMemoryFs() {
  const entries = new Map();
  return {
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
}

const root = '/doc/workspace/';

// ---- searchWorkspaceText（纯函数） ----

test('searchWorkspaceText：字面量命中 + 上下文行拼装（grep 风格）', () => {
  const files = [{ path: 'a.js', content: 'line1\nline2\nneedle here\nline4\nline5' }];
  const out = searchWorkspaceText(files, { pattern: 'needle', contextLines: 1 });
  assert.equal(out.error, '');
  assert.equal(out.matchCount, 1);
  assert.equal(out.fileCount, 1);
  assert.equal(out.truncated, false);
  assert.equal(out.text, 'a.js-2- line2\na.js:3: needle here\na.js-4- line4');
});

test('searchWorkspaceText：regex 模式可用，默认大小写敏感（与字面量一致）', () => {
  const files = [{ path: 'a.js', content: 'Foo\nfoo\nFOO' }];
  const literal = searchWorkspaceText(files, { pattern: 'foo', contextLines: 0 });
  assert.equal(literal.matchCount, 1, '字面量区分大小写');
  const re = searchWorkspaceText(files, { pattern: 'foo', regex: true, contextLines: 0 });
  assert.equal(re.matchCount, 1, '无 flags 正则也区分大小写');
  const reNum = searchWorkspaceText(files, { pattern: 'F\\w+', regex: true, contextLines: 0 });
  assert.equal(reNum.matchCount, 2, '正则可按模式匹配（Foo 与 FOO）');
});

test('searchWorkspaceText：单文件超过 maxMatchesPerFile 汇总为「已列前 M 处」', () => {
  const content = Array.from({ length: 5 }, (_, i) => `hit ${i}`).join('\n');
  const out = searchWorkspaceText([{ path: 'f.txt', content }], { pattern: 'hit', contextLines: 0, maxMatchesPerFile: 2 });
  assert.equal(out.matchCount, 5);
  assert.match(out.text, /f\.txt:2: hit 1/);
  assert.match(out.text, /f\.txt: （5 处匹配，已列前 2 处）/);
  assert.equal(/hit 4/.test(out.text), false, '超出上限的匹配不展开');
});

test('searchWorkspaceText：相邻匹配的上下文重叠去重', () => {
  const files = [{ path: 'f.txt', content: 'a\nx\nx\nb' }];
  const out = searchWorkspaceText(files, { pattern: 'x', contextLines: 1 });
  // 行 2、3 都是匹配；上下文 1..4 去重后每行只出现一次
  assert.equal(out.text, 'f.txt-1- a\nf.txt:2: x\nf.txt:3: x\nf.txt-4- b');
});

test('searchWorkspaceText：总输出预算上限触发截断', () => {
  const content = Array.from({ length: 50 }, () => 'match line content').join('\n');
  const out = searchWorkspaceText([{ path: 'big.txt', content }], {
    pattern: 'match',
    contextLines: 0,
    maxMatchesPerFile: 50,
    maxOutputChars: 60,
  });
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 80);
});

test('searchWorkspaceText：时间预算到点返回已完成部分并标注截断', () => {
  const files = [
    { path: 'a.txt', content: 'x1\nx2' },
    { path: 'b.txt', content: 'x3' },
    { path: 'c.txt', content: 'x4' },
  ];
  let clock = 0;
  const now = () => (clock += 1000);
  const out = searchWorkspaceText(files, { pattern: 'x', contextLines: 0, now, startTime: 0, timeBudgetMs: 2000 });
  assert.equal(out.truncated, true);
  assert.equal(out.fileCount, 1, '只扫完第一个文件即超时');
});

test('searchWorkspaceText：坏正则与空 pattern', () => {
  assert.equal(searchWorkspaceText([{ path: 'a', content: 'x' }], { pattern: '(' , regex: true }).error, 'bad-regex');
  assert.equal(searchWorkspaceText([{ path: 'a', content: 'x' }], { pattern: '' }).error, 'empty-pattern');
});

test('O2/M1：工具路径输出上限远高于序列化上限（超大结果走 O1 落盘而非就地截断）', () => {
  // 循环的 O1 序列化上限是 16KB；工具路径硬上限必须高于它，超大搜索结果才会交给
  // O1 落盘管道（预览 + 指针），而不是在工具内 8KB 处截断丢中段。
  assert.ok(SEARCH_TOOL_OUTPUT_CHARS > 16 * 1024);
});

// ---- search_workspace 工具（经 runTool 端到端） ----

test('search_workspace 工具：注册进只读集，字面量与正则可用', async () => {
  clearTools();
  const fileSystem = createMemoryFs();
  registerWorkspaceTools({ root, fileSystem });
  await runTool({ name: 'write_workspace_file', arguments: '{"path":"src/app.js","content":"const a = 1;\\nfunction foo() {}\\nconst b = 2;"}' }, { mode: AGENT_MODES.WRITE, characterId: 'c1' });
  await runTool({ name: 'write_workspace_file', arguments: '{"path":"README.md","content":"# Title\\nfoo appears here"}' }, { mode: AGENT_MODES.WRITE, characterId: 'c1' });

  assert.ok(listToolsForMode(AGENT_MODES.READ).some(item => item.function.name === 'search_workspace'));

  const literal = await runTool({ name: 'search_workspace', arguments: '{"pattern":"foo"}' }, { mode: AGENT_MODES.READ, characterId: 'c1' });
  assert.equal(literal.isError, false);
  assert.match(literal.content, /src\/app\.js:2: function foo/);
  assert.match(literal.content, /README\.md:2: foo appears here/);

  const re = await runTool({ name: 'search_workspace', arguments: '{"pattern":"foo\\\\(\\\\)","regex":true}' }, { mode: AGENT_MODES.READ, characterId: 'c1' });
  assert.match(re.content, /src\/app\.js:2:/);

  const none = await runTool({ name: 'search_workspace', arguments: '{"pattern":"zzz-nope"}' }, { mode: AGENT_MODES.READ, characterId: 'c1' });
  assert.equal(none.content, '（未找到匹配）');
});

test('search_workspace：subdir 限定范围', async () => {
  clearTools();
  const fileSystem = createMemoryFs();
  registerWorkspaceTools({ root, fileSystem });
  await runTool({ name: 'write_workspace_file', arguments: '{"path":"a/one.js","content":"needle"}' }, { mode: AGENT_MODES.WRITE, characterId: 'c1' });
  await runTool({ name: 'write_workspace_file', arguments: '{"path":"b/two.js","content":"needle"}' }, { mode: AGENT_MODES.WRITE, characterId: 'c1' });
  const scoped = await runTool({ name: 'search_workspace', arguments: '{"pattern":"needle","subdir":"a"}' }, { mode: AGENT_MODES.READ, characterId: 'c1' });
  assert.match(scoped.content, /a\/one\.js:1:/);
  assert.equal(/two\.js/.test(scoped.content), false);
});

test('search_workspace：坏正则返回友好错误（isError）', async () => {
  clearTools();
  const fileSystem = createMemoryFs();
  registerWorkspaceTools({ root, fileSystem });
  const bad = await runTool({ name: 'search_workspace', arguments: '{"pattern":"(","regex":true}' }, { mode: AGENT_MODES.READ, characterId: 'c1' });
  assert.equal(bad.isError, true);
  assert.match(bad.content, /正则语法错误/);
  const empty = await runTool({ name: 'search_workspace', arguments: '{"pattern":""}' }, { mode: AGENT_MODES.READ, characterId: 'c1' });
  assert.equal(empty.isError, true);
});

// ---- list_workspace_files：match 参数 + 截断告警 ----

test('list_workspace_files：match 只列匹配文件名，且不含目录项', async () => {
  clearTools();
  const fileSystem = createMemoryFs();
  registerWorkspaceTools({ root, fileSystem });
  await runTool({ name: 'write_workspace_file', arguments: '{"path":"src/app.test.js","content":"x"}' }, { mode: AGENT_MODES.WRITE, characterId: 'c1' });
  await runTool({ name: 'write_workspace_file', arguments: '{"path":"src/app.js","content":"x"}' }, { mode: AGENT_MODES.WRITE, characterId: 'c1' });
  await runTool({ name: 'write_workspace_file', arguments: '{"path":"README.md","content":"x"}' }, { mode: AGENT_MODES.WRITE, characterId: 'c1' });
  const list = await runTool({ name: 'list_workspace_files', arguments: '{"match":".test.js"}' }, { mode: AGENT_MODES.READ, characterId: 'c1' });
  assert.equal(list.content, 'src/app.test.js');
});

test('list_workspace_files：命中上限时附截断告警行', async () => {
  clearTools();
  // 用桩 store 直接触发 truncated，避免造 2001 个真实文件。
  const defs = createWorkspaceToolDefinitions({
    store: {
      listWorkspaceFilesWithMeta: async () => ({ files: ['a.js', 'b.js'], truncated: true }),
    },
  });
  const listDef = defs.find(item => item.name === 'list_workspace_files');
  const out = await listDef.execute({}, { mode: AGENT_MODES.READ, characterId: 'c1' });
  assert.match(out, /a\.js\nb\.js/);
  assert.match(out, /已达上限/);
});

test('list_workspace_files：桩 store 只有旧方法时无截断标记（向后兼容）', async () => {
  const defs = createWorkspaceToolDefinitions({
    store: { listWorkspaceFiles: async () => ['a.js'] },
  });
  const listDef = defs.find(item => item.name === 'list_workspace_files');
  const out = await listDef.execute({}, { mode: AGENT_MODES.READ, characterId: 'c1' });
  assert.equal(out, 'a.js');
});

// ---- M0：读指引参数名 + 搜索指引分派 ----

test('serializeToolResult：读指引用 offset/limit（不是 maxChars），搜索有专属指引', () => {
  const big = 'x'.repeat(20000);
  const readOut = serializeToolResult(big, 100, 'read_workspace_file');
  assert.match(readOut, /offset\/limit/);
  assert.equal(/maxChars/.test(readOut), false, '不得把模型引向不存在的 maxChars 参数');

  const searchOut = serializeToolResult(big, 100, 'search_workspace');
  assert.match(searchOut, /收窄 pattern/);

  const shellOut = serializeToolResult(big, 100, 'run_shell');
  assert.match(shellOut, /重跑/);
});
