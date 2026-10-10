// 工作流步骤执行器（workflowRunner）测试：agent 档案收窄 + 黑板跨步骤共享 + 结果格式化。
import test from 'node:test';
import assert from 'node:assert/strict';

import { runWorkflowSteps, formatWorkflowResult } from '../src/workspace/toolDefs/workflowRunner.js';
import { createBlackboard } from '../src/agent/blackboard.js';

function makeStore(files = {}) {
  return {
    async listWorkspaceFiles({ subdir }) {
      const prefix = subdir ? `${subdir}/` : '';
      return Object.keys(files).filter(item => item.startsWith(prefix));
    },
    async readWorkspaceFile({ path }) {
      if (!(path in files)) throw new Error('fileNotFound');
      return { content: files[path] };
    },
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
  assert.deepEqual(captured[0], ['board_post', 'board_read', 'read_workspace_file']);
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

test('formatWorkflowResult：失败给错误对象；成功按拓扑顺序合并；空产出兜底', () => {
  const failed = formatWorkflowResult({ ok: false, errors: ['成环'] });
  assert.equal(failed.isError, true);
  assert.ok(failed.content.includes('成环'));
  const ok = formatWorkflowResult({ ok: true, order: ['a', 'b'], results: { a: 'A', b: 'B' } });
  assert.equal(ok.isError, undefined);
  assert.ok(ok.content.includes('【步骤 a】A') && ok.content.includes('【步骤 b】B'));
  assert.ok(formatWorkflowResult({ ok: true, order: [], results: {} }).content.includes('没有产出'));
});
