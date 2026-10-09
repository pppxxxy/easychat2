// 子代理（run_subagent）测试（spec: 2026-10-09-agent-extensibility T8）。
//
// 覆盖：① 循环行为（一轮出结论 / 工具往返 / 轮次上限 / 工具报错不中断 / 空任务）；
// ② 硬红线：只读名字白名单——run_subagent 自己也是 readOnly 工具，只看标志会递归；
// ③ 结果截断与无结论兜底；④ 接线契约（工具定义属性、能力清单、注册）。
// 走 loadModule 图（subagent.js 静态依赖网络层，需要 patch）。
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

function loadSubagent() {
  return loadModule(path.resolve('src/agent/subagent.js'));
}

// 只读工具（与 tools.js 的定义同形）与一个「诱饵」：run_subagent 自己也是 readOnly。
function makeTools(calls) {
  return [
    {
      name: 'list_workspace_files',
      description: 'list',
      parameters: { type: 'object', properties: {} },
      readOnly: true,
      execute: async () => {
        calls.push('list');
        return 'a.js\nb.js';
      },
    },
    {
      name: 'read_workspace_file',
      description: 'read',
      parameters: { type: 'object', properties: {} },
      readOnly: true,
      execute: async (options, args) => {
        calls.push(args.path);
        return `内容:${args.path}`;
      },
    },
    {
      name: 'run_subagent',
      description: '诱饵：递归入口',
      parameters: { type: 'object', properties: {} },
      readOnly: true, // 只看 readOnly 就会放它进来 —— 必须被名字白名单挡下
      execute: async () => {
        calls.push('RECURSION');
        return '不应发生';
      },
    },
  ];
}

test('一轮出结论：不调工具直接返回文本（不注入任何工具调用）', async () => {
  const { runSubagent } = loadSubagent();
  const calls = [];
  const stream = async () => ({ text: '结论：项目只有两个文件。', toolCalls: [] });
  const result = await runSubagent({ task: '看看工作区有什么', tools: makeTools(calls), store: {}, stream });
  assert.equal(result.isError, false);
  assert.ok(result.content.includes('结论'));
  assert.deepEqual(calls, []);
});

test('工具往返：读文件 → 结果回填 → 二轮出结论；工具事件上报', async () => {
  const { runSubagent } = loadSubagent();
  const calls = [];
  const events = [];
  let round = 0;
  const stream = async history => {
    round += 1;
    if (round === 1) {
      return {
        text: '',
        toolCalls: [{ id: 'c1', name: 'read_workspace_file', arguments: JSON.stringify({ path: 'a.js' }) }],
      };
    }
    // 第二轮应能看到工具结果在 history 里
    const toolMessage = history.find(item => item.role === 'tool');
    assert.ok(toolMessage && toolMessage.content.includes('内容:a.js'), '工具结果必须回填进 history');
    return { text: '结论：a.js 是入口。', toolCalls: [] };
  };
  const result = await runSubagent({
    task: 'a.js 是什么',
    tools: makeTools(calls),
    store: {},
    stream,
    onEvent: event => events.push(event.phase),
  });
  assert.ok(result.content.includes('a.js 是入口'));
  assert.deepEqual(calls, ['a.js']);
  assert.deepEqual(events, ['start', 'end']);
});

test('结论只取结论轮：中间轮的过渡语不并入（提示词压不住不老实的模型，结构上不采）', async () => {
  const { runSubagent } = loadSubagent();
  const calls = [];
  let round = 0;
  const stream = async () => {
    round += 1;
    if (round === 1) {
      return {
        text: '我先看看目录里有什么…',
        toolCalls: [{ id: 'c1', name: 'list_workspace_files', arguments: '{}' }],
      };
    }
    return { text: '结论：工作区里有两个文件。', toolCalls: [] };
  };
  const result = await runSubagent({ task: '看看有什么', tools: makeTools(calls), store: {}, stream });
  assert.ok(result.content.includes('结论：工作区里有两个文件。'));
  assert.equal(result.content.includes('我先看看目录'), false, '过渡语不得漏进结论（质量建议 ③）');
});

test('硬红线：只读**名字白名单**——run_subagent（同为 readOnly）被结构性挡下，不可能递归', async () => {
  const { runSubagent, SUBAGENT_TOOL_NAMES } = loadSubagent();
  assert.equal(SUBAGENT_TOOL_NAMES.includes('run_subagent'), false, '白名单永远不含递归入口');
  assert.deepEqual([...SUBAGENT_TOOL_NAMES].sort(), ['list_workspace_files', 'read_workspace_file']);

  const calls = [];
  let round = 0;
  const stream = async () => {
    round += 1;
    if (round === 1) {
      return { text: '', toolCalls: [{ id: 'c1', name: 'run_subagent', arguments: '{}' }] };
    }
    return { text: '结论：被拒绝了。', toolCalls: [] };
  };
  const result = await runSubagent({ task: '试着递归', tools: makeTools(calls), store: {}, stream });
  assert.equal(calls.includes('RECURSION'), false, '诱饵工具绝不能被执行');
  assert.ok(result.content.includes('结论'), '循环继续到模型给出文字结论');
});

test('轮次上限：最后仍在调工具 → 收尾并附「可能不完整」；不执行最后一轮工具', async () => {
  const { runSubagent } = loadSubagent();
  const calls = [];
  const stream = async () => ({
    text: '还在找。',
    toolCalls: [{ id: 'c1', name: 'list_workspace_files', arguments: '{}' }],
  });
  const result = await runSubagent({
    task: '无限翻文件',
    tools: makeTools(calls),
    store: {},
    stream,
    maxRounds: 3,
  });
  assert.equal(calls.length, 2, '最后一轮不再执行工具（省一次无意义的调用）');
  assert.ok(result.content.includes('轮次上限'));
  assert.equal(result.isError, false);
});

test('工具报错不中断：错误作为工具结果喂回，循环继续；最终无结论时如实说明', async () => {
  const { runSubagent } = loadSubagent();
  const tools = [
    {
      name: 'read_workspace_file',
      description: 'read',
      parameters: { type: 'object', properties: {} },
      readOnly: true,
      execute: async () => { throw new Error('文件不存在'); },
    },
  ];
  let round = 0;
  const stream = async history => {
    round += 1;
    if (round === 1) {
      return { text: '', toolCalls: [{ id: 'c1', name: 'read_workspace_file', arguments: '{"path":"gone.js"}' }] };
    }
    const toolMessage = history.find(item => item.role === 'tool');
    assert.ok(toolMessage.content.includes('文件不存在'), '错误原文必须喂回模型');
    return { text: '', toolCalls: [] };
  };
  const result = await runSubagent({ task: '读一个不存在的文件', tools, store: {}, stream });
  assert.equal(result.isError, false, '子代理本身不算失败');
  assert.ok(result.content.includes('工具执行遇到问题'), '无结论且有错误时如实说明');
});

test('输入校验与截断：空任务 / 无可用工具 → isError；超长结论截断', async () => {
  const { runSubagent, SUBAGENT_RESULT_LIMIT } = loadSubagent();
  assert.equal((await runSubagent({ task: '  ', tools: [], store: {} })).isError, true);
  assert.equal((await runSubagent({ task: 't', tools: [], store: {} })).isError, true, '没有可用工具');
  assert.equal((await runSubagent({ task: 't', tools: makeTools([]), store: null })).isError, true, '没有 store');

  const long = await runSubagent({
    task: 't',
    tools: makeTools([]),
    store: {},
    stream: async () => ({ text: 'x'.repeat(SUBAGENT_RESULT_LIMIT + 100), toolCalls: [] }),
  });
  assert.ok(long.content.length <= SUBAGENT_RESULT_LIMIT + 20);
  assert.ok(long.content.includes('已截断'));
});

test('接线契约：run_subagent 工具只读但不递归；能力清单含它；注册表按 readOnly 进 read 模式', () => {
  // 定义已按域拆到 toolDefs/（质量建议 ①）：断言跟着去新文件，并保留一条聚合断言。
  const toolFile = fs.readFileSync(path.resolve('src/workspace/toolDefs/subagentTool.js'), 'utf8');
  assert.ok(toolFile.includes("name: 'run_subagent'"), '工具已注册进工作区定义');
  assert.ok(toolFile.includes('SUBAGENT_TOOL_NAMES.includes(item.name)'), '子代理工具按名字白名单过滤（不看 readOnly 标志）');
  assert.ok(toolFile.includes('READ_ONLY_TOOL_DEFINITIONS'), '只读对象直接引 readTools（不经注册表过滤）');
  assert.ok(toolFile.includes('timeoutMs: 300000'), '子代理需要更长的工具超时（多轮模型请求；E3 起 180s → 300s）');
  const indexFile = fs.readFileSync(path.resolve('src/workspace/tools.js'), 'utf8');
  assert.ok(indexFile.includes('SUBAGENT_TOOL_DEFINITION'), '索引层聚合了子代理定义');

  const subagent = fs.readFileSync(path.resolve('src/agent/subagent.js'), 'utf8');
  assert.ok(subagent.includes("SUBAGENT_TOOL_NAMES = Object.freeze(['list_workspace_files', 'read_workspace_file'])"),
    '白名单是写死的只读两项');
  assert.equal(/from\s+'[^']*registry[^']*'/.test(subagent), false,
    '子代理不得 import 全局注册表（结构上不可递归）');

  const caps = fs.readFileSync(path.resolve('src/workspace/capabilities.js'), 'utf8');
  assert.ok(caps.includes("'run_subagent'"), '能力清单如实列出子代理');
});

test('E3 mapWithConcurrency：有界并发、结果保序、空输入与抛错行为', async () => {
  const { mapWithConcurrency } = loadSubagent();
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async item => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return item * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50], '结果保持输入顺序');
  assert.ok(peak <= 2, `并发不超过 2（实际峰值 ${peak}）`);
  assert.deepEqual(await mapWithConcurrency(null, 2, () => 1), [], '坏输入安全');
  assert.deepEqual(await mapWithConcurrency([], 2, () => 1), []);
  // worker 抛错原样上抛（调用方决定降级，执行器不吞错）
  await assert.rejects(
    mapWithConcurrency([1], 2, async () => { throw new Error('boom'); }),
    /boom/
  );
});

test('E3 工具契约：task 支持数组、agent 可选、并发上限与防递归仍成立', () => {
  const source = fs.readFileSync(path.resolve('src/workspace/toolDefs/subagentTool.js'), 'utf8');
  assert.ok(source.includes("type: ['string', 'array']"), 'task 支持数组形态');
  assert.ok(source.includes("agent: {"), 'agent 参数存在');
  assert.ok(source.includes('SUBAGENT_BATCH_LIMIT'), '批量上限常量（≤3）');
  assert.ok(source.includes('mapWithConcurrency(tasks, SUBAGENT_CONCURRENCY'), '并发按上限执行');
  assert.ok(source.includes('timeoutMs: 300000'), '超时 180s → 300s（并行批次按最慢一路算）');
  assert.ok(source.includes('SUBAGENT_TOOL_NAMES.includes(item.name)'), '名字白名单过滤保留（防递归未破坏）');
  // 档案 tools 只能收窄，不能扩大：执行前按 profile.tools 再过滤一次。
  assert.ok(source.includes('readOnlyTools.filter(item => profile.tools.includes(item.name))'), '档案只收窄工具表');
  assert.ok(source.includes("readWorkspaceAgents(options.store"), '档案每轮直读（改完下一轮生效）');
});
