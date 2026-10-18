// search_workspace 的**读取顺序**与「截断必须诚实」两条不变量。
//
// 事故（用户真机日志 2026-10-18）：
//   turn-tool round=1 tool=search_workspace ok=ok elapsed=2005ms
//   turn-tool round=3 tool=search_workspace ok=ok elapsed=2007ms
//   turn-tool round=4 tool=search_workspace ok=ok elapsed=2007ms   （同一轮里连搜 4 次）
// 每次耗时都精确贴着 2000ms 预算 —— 说明它不是"搜到了"，而是**被预算切断**。
//
// 根因有两条，都在工具壳（不是纯函数）里：
//   ① 旧实现先无条件把工作区**每个文件**读进内存，读到 2000ms 就 break，然后才匹配。
//      搜索的时间花在"搬正文"上，而不是"找内容"上。
//   ② 读取阶段被截断这件事**完全不可见**：truncated 只反映纯函数自己的超时。
//      于是没命中时模型得到「（未找到匹配）」，据此断定"工作区里没有 X"——
//      而真相是一半文件还没读。把没查完说成查过了，比慢危险得多。
//
// 本文件测的是这两条的行为，不是源码长什么样。
import test from 'node:test';
import assert from 'node:assert/strict';

import { clearTools, runTool, AGENT_MODES } from '../src/agent/tools/registry.js';
import { registerWorkspaceTools } from '../src/workspace/tools.js';

// 最小内存 FS：只需 list/read/write。
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

// 说明：这里**不再**用「建 40 个真文件」的快速 FS 造场景。
// 第一版就是这么写的，结果注入「取消排序」时测试没变红——内存 FS 读 40 个文件
// 只要几毫秒，根本撞不到 2000ms 预算，排序前后结果完全一样（假绿）。
// 现在改为在用例里直接给**慢 store**，让"谁先被读"成为可观察差异。

test('读取顺序：文件名命中 pattern 的文件优先被读（预算花在匹配上）', async () => {
  // ⚠️ 这条必须用**慢 store**，否则测不出排序：
  // 内存 FS 读 40 个文件只要几毫秒，排序前后都能读完全部文件，结果完全一样。
  // 只有让每个文件都吃掉可观时间，预算才真的会耗尽，"谁先被读"才成为可观察差异。
  // （第一版就是因为用了快 FS，注入「取消排序」时测试没变红——假绿。）
  const notes = Array.from({ length: 12 }, (_, i) => `notes/note-${String(i).padStart(2, '0')}.md`);
  const paths = notes.concat(['config/needletoken.json']);
  const readOrder = [];
  const store = {
    listWorkspaceFiles: async () => paths,
    readWorkspaceFile: async ({ path }) => {
      readOrder.push(path);
      const started = Date.now();
      while (Date.now() - started < 300) {
        // 忙等：每个文件 300ms，12 个 note 就远超 2000ms 预算
      }
      return { content: path.includes('needletoken') ? '{"value":"needletoken"}' : '普通正文' };
    },
  };
  const { createWorkspaceToolDefinitions } = await import('../src/workspace/tools.js');
  const defs = createWorkspaceToolDefinitions({ store });
  const searchDef = defs.find(item => item.name === 'search_workspace');
  const out = await searchDef.execute(
    { pattern: 'needletoken' },
    { mode: AGENT_MODES.READ, characterId: 'c1' }
  );
  const text = String(out && out.content !== undefined ? out.content : out);

  // 核心断言：命中文件必须被**实际读过**（旧实现按目录顺序读，12 个 note 就耗尽预算，
  // needletoken.json 排在最后永远轮不到 → 搜不到）。
  assert.ok(readOrder.includes('config/needletoken.json'),
    `文件名含 pattern 的文件必须被优先读到；实际读取顺序：${readOrder.join(', ')}`);
  assert.match(text, /needletoken/, `必须命中，实际：${text}`);
  // 排序的收益要能被看见：命中文件应当排在前几个被读的位置。
  assert.ok(readOrder.indexOf('config/needletoken.json') <= 1,
    `命中文件应排在最前（实际第 ${readOrder.indexOf('config/needletoken.json') + 1} 个被读）`);
});

test('读取顺序：内容命中但文件名不含 pattern 时仍然能搜到（排序不是过滤）', async () => {
  clearTools();
  const fileSystem = createMemoryFs();
  registerWorkspaceTools({ root, fileSystem });
  // 文件名完全不含 haytoken，只有内容里有。
  await runTool(
    { name: 'write_workspace_file', arguments: JSON.stringify({ path: 'src/plain.js', content: 'const x = "haytoken";' }) },
    { mode: AGENT_MODES.WRITE, characterId: 'c2' }
  );
  const out = await runTool(
    { name: 'search_workspace', arguments: '{"pattern":"haytoken"}' },
    { mode: AGENT_MODES.READ, characterId: 'c2' }
  );
  assert.match(out.content, /plain\.js/, '文件名不含 pattern 的文件**也必须**被搜索（排序≠过滤）');
});

test('诚实截断：没命中但读取被预算切断时，不得说成「未找到匹配」', async () => {
  clearTools();
  // 造一个慢 store：每次 readWorkspaceFile 都吃掉 600ms，3 次就超过 2000ms 预算。
  // 这样读取阶段必然被截断，而 pattern 在整个工作区里都不存在。
  const paths = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
  const store = {
    listWorkspaceFiles: async () => paths,
    readWorkspaceFile: async ({ path }) => {
      const started = Date.now();
      while (Date.now() - started < 600) {
        // 忙等，模拟大文件读盘
      }
      return { content: `// ${path}\n没有关键词\n` };
    },
  };
  const { createWorkspaceToolDefinitions } = await import('../src/workspace/tools.js');
  const defs = createWorkspaceToolDefinitions({ store });
  const searchDef = defs.find(item => item.name === 'search_workspace');
  const out = await searchDef.execute(
    { pattern: '不存在的词' },
    { mode: AGENT_MODES.READ, characterId: 'c3' }
  );
  // 核心：不能出现「（未找到匹配）」那种绝对断言。
  assert.equal(
    /^（未找到匹配）$/.test(String(out).trim()),
    false,
    `读取被截断时**不得**返回「未找到匹配」，实际：${out}`
  );
  assert.match(String(out), /时间上限|没读完|未搜索/, '必须明确说明还有文件没读完');
  assert.match(String(out), /不能据此断定不存在/, '必须阻止模型把"没查完"当成"不存在"');
});

test('诚实截断：读取被切断但确实命中了，也要说明结果可能不完整', async () => {
  // 命中文件读得很快（排第一，立即命中），后面的文件很慢 → 命中已拿到，
  // 但读取阶段仍会在预算处被切断。这正是「有结果 + 不完整」的组合。
  const paths = ['hit.js', 'slow1.js', 'slow2.js', 'slow3.js', 'slow4.js'];
  const store = {
    listWorkspaceFiles: async () => paths,
    readWorkspaceFile: async ({ path }) => {
      if (path !== 'hit.js') {
        const started = Date.now();
        while (Date.now() - started < 700) {
          // 忙等，模拟大文件读盘
        }
      }
      return { content: path === 'hit.js' ? '关键词在这里' : '别的内容' };
    },
  };
  const { createWorkspaceToolDefinitions } = await import('../src/workspace/tools.js');
  const defs = createWorkspaceToolDefinitions({ store });
  const searchDef = defs.find(item => item.name === 'search_workspace');
  const out = await searchDef.execute(
    { pattern: '关键词' },
    { mode: AGENT_MODES.READ, characterId: 'c4' }
  );
  // execute 返回 { content, isError } 形态（与 registry 的 runTool 一致）。
  const text = String(out && out.content !== undefined ? out.content : out);
  assert.match(text, /hit\.js/, `命中必须返回，实际：${text}`);
  assert.match(text, /未搜索|可能不完整/, '命中但没读完时也要如实说明');
});

test('对照：文件少、全部读完且没命中时，仍然返回简洁的「未找到匹配」', async () => {
  const store = {
    listWorkspaceFiles: async () => ['a.js'],
    readWorkspaceFile: async () => ({ content: 'nothing here' }),
  };
  const { createWorkspaceToolDefinitions } = await import('../src/workspace/tools.js');
  const defs = createWorkspaceToolDefinitions({ store });
  const searchDef = defs.find(item => item.name === 'search_workspace');
  const out = await searchDef.execute(
    { pattern: '缺词' },
    { mode: AGENT_MODES.READ, characterId: 'c5' }
  );
  assert.equal(String(out).trim(), '（未找到匹配）', '真读完了且没命中，就该直接说没找到');
});

test('正则模式下文件名排序不得因非法正则而崩', async () => {
  const store = {
    listWorkspaceFiles: async () => ['a.js', 'b.js'],
    readWorkspaceFile: async () => ({ content: 'x' }),
  };
  const { createWorkspaceToolDefinitions } = await import('../src/workspace/tools.js');
  const defs = createWorkspaceToolDefinitions({ store });
  const searchDef = defs.find(item => item.name === 'search_workspace');
  // 非法正则：排序阶段 try/catch 兜住，交给纯函数统一报 bad-regex。
  const out = await searchDef.execute(
    { pattern: '(', regex: true },
    { mode: AGENT_MODES.READ, characterId: 'c6' }
  );
  const text = String(out && out.content !== undefined ? out.content : out);
  assert.match(text, /正则语法错误/, '非法正则必须给明确错误，而不是崩溃');
});
