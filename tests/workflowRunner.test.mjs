// 工作流步骤执行器（workflowRunner）测试：agent 档案收窄 + 黑板跨步骤共享 + 结果格式化。
//
// P1 回归（2026-10-11）也在这里：run_workflow / run_team 的 write 步骤此前**从不执行**
// 却报成功——workflowRunner 调 runSubagent 时漏传 workspaceMode，而 subagent.js 用它
// 拦截 write 模式（纵深防御第二层），于是每个 write 步骤都恒返回「写子代理不可用：
// 当前不是「可改」模式（未执行）」，runWorkflow 仍 ok:true、formatWorkflowResult 照报成功。
import test from 'node:test';
import assert from 'node:assert/strict';

import { runWorkflowSteps, formatWorkflowResult } from '../src/workspace/toolDefs/workflowRunner.js';
import { runWorkflow } from '../src/agent/workflow.js';
import { mapWithConcurrency } from '../src/agent/subagent.js';
import { createBlackboard } from '../src/agent/blackboard.js';

function makeStore(files = {}) {
  return {
    files,
    async listWorkspaceFiles({ subdir }) {
      const prefix = subdir ? `${subdir}/` : '';
      return Object.keys(files).filter(item => item.startsWith(prefix));
    },
    async readWorkspaceFile({ path }) {
      if (!(path in files)) throw new Error('fileNotFound');
      return { content: files[path] };
    },
    async writeWorkspaceFile({ path, content }) {
      files[path] = content;
      return { path, length: String(content).length };
    },
    async editWorkspaceFile({ path, find, replace }) {
      files[path] = String(files[path] || '').replace(find, replace);
      return { path, count: 1, length: files[path].length };
    },
  };
}

// 假流：第一轮按脚本发工具调用，之后给结论。**用真实工具定义**（buildSubagentTools），
// 不造假工具——写子代理审批那条历史事故就是自造假工具造成的。
function toolCallStream(callsByRound) {
  let round = 0;
  return async () => {
    const calls = callsByRound[round] || [];
    round += 1;
    return calls.length > 0 ? { text: '', toolCalls: calls } : { text: '步骤结论', toolCalls: [] };
  };
}

test('工作流步骤子代理含 search_workspace（与 run_subagent 一致）', async () => {
  const captured = [];
  const stream = async (history, options) => {
    captured.push((options.tools || []).map(item => item.function.name).sort());
    return { text: '结论', toolCalls: [] };
  };
  await runWorkflowSteps({ store: makeStore({}), characterId: 'c', steps: [{ id: 'a', task: 'x' }], stream });
  assert.ok(captured[0].includes('search_workspace'), '默认子代理应能搜索工作区');
});

test('agent 档案收窄工具集（步骤写 agent 时不再被忽略）', async () => {
  const store = makeStore({
    '.easychat/agents/narrow.md': '---\nname: narrow\ntools: read_workspace_file\n---\n',
  });
  const captured = [];
  const stream = async (history, options) => {
    captured.push((options.tools || []).map(item => item.function.name).sort());
    return { text: '结论', toolCalls: [] };
  };
  const result = await runWorkflowSteps({
    store, characterId: 'c', steps: [{ id: 'a', task: 'x', agent: 'narrow' }], stream,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(captured[0], ['board_inbox', 'board_post', 'board_read', 'board_send', 'board_task', 'read_workspace_file']);
});

test('黑板跨步骤共享：前一步 board_post 的内容，后一步 board_read 读得到', async () => {
  const store = makeStore({});
  const stream = async history => {
    const task = String((history.find(m => m.role === 'user') || {}).content || '');
    if (task.includes('发布')) {
      return { text: '', toolCalls: [{ id: 'p', name: 'board_post', arguments: JSON.stringify({ topic: '共享', text: 'A 的发现' }) }] };
    }
    if (task.includes('读取')) {
      const toolMsg = history.find(m => m.role === 'tool');
      if (!toolMsg) {
        return { text: '', toolCalls: [{ id: 'r', name: 'board_read', arguments: JSON.stringify({ topic: '共享' }) }] };
      }
      assert.ok(toolMsg.content.includes('A 的发现'), '后一步必须读得到前一步发布的内容');
      return { text: '看到 A 的发现', toolCalls: [] };
    }
    return { text: '无', toolCalls: [] };
  };
  const result = await runWorkflowSteps({
    store,
    characterId: 'c',
    steps: [
      { id: 'a', task: '发布到黑板' },
      { id: 'c', task: '读取黑板', dependsOn: ['a'] },
    ],
    stream,
  });
  assert.equal(result.ok, true);
  assert.ok(result.results.c.includes('看到 A 的发现'));
});

test('注入已播种的黑板：步骤读得到跨会话沉淀（remember 通路）', async () => {
  const seeded = createBlackboard({ initial: { topics: { '历史结论': [{ from: 'task-9', text: '上次的发现' }] } } });
  const stream = async history => {
    const toolMsg = history.find(m => m.role === 'tool');
    if (!toolMsg) {
      return { text: '', toolCalls: [{ id: 'r', name: 'board_read', arguments: JSON.stringify({ topic: '历史结论' }) }] };
    }
    assert.ok(toolMsg.content.includes('上次的发现'), '必须读到播种内容');
    return { text: '看到上次的发现', toolCalls: [] };
  };
  const result = await runWorkflowSteps({
    store: makeStore({}), characterId: 'c', steps: [{ id: 'a', task: '读取历史' }], stream, board: seeded,
  });
  assert.equal(result.ok, true);
  assert.ok(result.results.a.includes('看到上次的发现'));
});

// ---- P1 回归：write 步骤真的执行、失败不再报成功 ----
//
// 注：写子代理对每个写工具**逐条**要用户确认（subagent.js 的 needsConfirm 判据是
// `readOnly !== true`，fail-closed），所以这里显式注入「一律批准」的 confirm ——
// 这正是宿主（ChatPanel / useChatSend）在生产里做的事。不注入的话写工具会如实报
// 「无法询问用户（未执行）」，那是另一条正确的路径（下面第二条用例钉的就是它）。

test('P1 回归：hostMode=write + mode=write 时 write 步骤真的落盘（此前恒返回「未执行」）', async () => {
  const store = makeStore({});
  const stream = toolCallStream([[
    { id: 'w1', name: 'write_workspace_file', arguments: JSON.stringify({ path: 'out/note.md', content: '写进去了' }) },
  ]]);
  const approved = [];
  const result = await runWorkflowSteps({
    store,
    characterId: 'c',
    hostMode: 'write',
    confirm: async call => { approved.push(call.name); return true; },
    steps: [{ id: 'a', task: '写一个文件', mode: 'write' }],
    stream,
  });
  assert.deepEqual(approved, ['write_workspace_file'], '写步骤要逐条请用户确认');
  assert.equal(result.ok, true, `工作流应成功，实际错误：${JSON.stringify(result.errors)}`);
  assert.equal(store.files['out/note.md'], '写进去了', 'write 步骤必须真的落盘（此前恒返回「未执行」）');
});

test('P1 回归：没有审批出口时 write 步骤不落盘，且工作流**不得**报成功', async () => {
  // 不注入 confirm：写工具按「问不到用户 = 不执行」处理。子代理的结论轮仍会产出文字，
  // 但工作流必须把它判为失败——「没写的写成了」是最不能接受的伪装。
  const store = makeStore({});
  const stream = toolCallStream([[
    { id: 'w1', name: 'write_workspace_file', arguments: JSON.stringify({ path: 'out/note.md', content: 'x' }) },
  ]]);
  const result = await runWorkflowSteps({
    store,
    characterId: 'c',
    hostMode: 'write',
    steps: [{ id: 'a', task: '写一个文件', mode: 'write' }],
    stream,
  });
  assert.equal(store.files['out/note.md'], undefined, '问不到用户时不得落盘');
  assert.equal(result.ok, false, '写没落地，工作流必须 ok:false');
  assert.ok(result.failed.includes('a'), '失败步骤要被点名');
  const formatted = formatWorkflowResult(result);
  assert.equal(formatted.isError, true, '工具结果必须是错误（此前照报成功）');
  assert.ok(formatted.content.includes('步骤 a'), '错误文案要点名失败步骤');
});

test('P1 回归：宿主只读时 write 步骤被拒，且工作流**不得**报成功', async () => {
  const store = makeStore({});
  const stream = toolCallStream([[
    { id: 'w1', name: 'write_workspace_file', arguments: JSON.stringify({ path: 'out/note.md', content: 'x' }) },
  ]]);
  const result = await runWorkflowSteps({
    store,
    characterId: 'c',
    hostMode: 'read',
    confirm: async () => true,
    steps: [{ id: 'a', task: '写一个文件', mode: 'write' }],
    stream,
  });
  assert.equal(store.files['out/note.md'], undefined, '只读宿主下不得落盘');
  assert.equal(result.ok, false, '步骤没执行成功，工作流必须 ok:false');
  assert.ok(result.failed.includes('a'), '失败步骤要被点名');
});

test('P1 回归：子代理不可用时工作流 ok:false 且文案不谎报成功', async () => {
  // 不注入 stream → runSubagent 拿不到网络层 → 如实报「子代理不可用」。
  const store = makeStore({});
  const result = await runWorkflowSteps({
    store, characterId: 'c', steps: [{ id: 'a', task: '随便' }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['a']);
  const formatted = formatWorkflowResult(result);
  assert.equal(formatted.isError, true);
  assert.ok(formatted.content.includes('子代理不可用'), '要带上真实原因');
});

test('runWorkflow：失败时仍保留已成功步骤的结论（部分信息不丢）', async () => {
  const result = await runWorkflow({
    steps: [{ id: 'ok1', task: 't1' }, { id: 'bad', task: 't2' }],
    runStep: async step => (step.id === 'bad'
      ? { text: '没做成', isError: true, error: '未执行' }
      : { text: '成功结论', isError: false }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['bad']);
  assert.equal(result.results.ok1, '成功结论', '已成功的结论仍要收进结果');
  const formatted = formatWorkflowResult(result);
  assert.equal(formatted.isError, true);
  assert.ok(formatted.content.includes('成功结论'), '部分信息比空手好，但判定必须诚实');
});

test('runWorkflow：旧形状（runStep 返回字符串）按成功处理（向后兼容）', async () => {
  const result = await runWorkflow({ steps: [{ id: 'a', task: 't' }], runStep: async () => '纯文本结论' });
  assert.equal(result.ok, true);
  assert.equal(result.results.a, '纯文本结论');
});

// ---- P1 回归：mapWithConcurrency 首个失败后兄弟不再派新活，且结果可回收 ----

test('P1 回归：mapWithConcurrency 首个失败后不再派新活，失败错误上带已完成结果', async () => {
  const started = [];
  let threw = null;
  try {
    await mapWithConcurrency([0, 1, 2, 3, 4, 5], 1, async (item) => {
      started.push(item);
      if (item === 2) throw new Error(`boom-${item}`);
      return `r${item}`;
    });
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, '失败必须上抛');
  assert.equal(threw.message, 'boom-2');
  assert.deepEqual(started, [0, 1, 2], '失败之后不得再派新活（此前会一路跑完 3/4/5）');
  assert.deepEqual(threw.completedIndices, [0, 1], '已完成的下标要能拿到');
  assert.deepEqual(threw.partialResults.slice(0, 2), ['r0', 'r1'], '已完成的结果不再被丢弃');
  assert.equal(threw.failedIndex, 2);
});

test('mapWithConcurrency：全部成功时结果保持输入顺序', async () => {
  const results = await mapWithConcurrency([3, 1, 2], 2, async item => {
    await new Promise(resolve => setTimeout(resolve, item * 5));
    return item * 10;
  });
  assert.deepEqual(results, [30, 10, 20]);
});

test('formatWorkflowResult：失败给错误对象；成功按拓扑顺序合并；空产出兜底', () => {
  const failed = formatWorkflowResult({ ok: false, errors: ['成环'] });
  assert.equal(failed.isError, true);
  assert.ok(failed.content.includes('成环'));
  const ok = formatWorkflowResult({ ok: true, order: ['a', 'b'], results: { a: 'A', b: 'B' } });
  assert.equal(ok.isError, undefined);
  assert.ok(ok.content.includes('【步骤 a】A') && ok.content.includes('【步骤 b】B'));
  assert.ok(formatWorkflowResult({ ok: true, order: [], results: {} }).content.includes('没有产出'));
});
