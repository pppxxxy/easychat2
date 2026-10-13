// SW2：看屏幕·工作区会话的回合编排（agent 管线 + 确认 + 线程落库）。
//
// 核心风险（本文件钉的就是这些）：
//  ① scope 分流错误 → 工作区会话误走聊天评论管线（没有工具，干不了活）；
//  ② 确认缺失 → 破坏性操作被静默拒绝（或更糟：被静默放行）；
//  ③ 线程落库失败 → 挡住本轮回复（用户明明看到回答却被告知失败）；
//  ④ 空文本/纯文字无内容 → 白发一次请求。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScreenWatchAgentHistory,
  buildScreenWatchTurnEntries,
  resolveScreenWatchPipeline,
  runWorkspaceWatchTurn,
} from '../src/screenWatch/workspaceWatchTurn.js';

const t = key => key;

test('resolveScreenWatchPipeline：workspace → agent 管线；其余 → 聊天评论管线', () => {
  assert.equal(resolveScreenWatchPipeline('workspace'), 'workspace-agent');
  assert.equal(resolveScreenWatchPipeline('chat'), 'chat-comment');
  // 旧数据/坏值一律走聊天侧（与 normalizeThreadScope 同口径：不把历史线程误升级成能动手的会话）
  for (const bad of [undefined, null, '', 'WORKSPACE', 'other', 0, {}]) {
    assert.equal(resolveScreenWatchPipeline(bad), 'chat-comment', `${JSON.stringify(bad)} 应走聊天管线`);
  }
});

test('buildScreenWatchAgentHistory：只取有文本的条目，倒序截断，role 沿用 user/assistant', () => {
  const entries = [
    { id: '1', role: 'user', text: '看这个' },
    { id: '2', role: 'assistant', text: '   ' },      // 空白丢弃
    { id: '3', role: 'assistant', text: '好的' },
    { id: '4', role: 'user', text: '' },               // 空丢弃
    { id: '5', role: 'user', text: '继续' },
  ];
  const history = buildScreenWatchAgentHistory(entries, 2);
  assert.deepEqual(history, [
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '继续' },
  ], '只保留最近 2 条有文本的');
  assert.deepEqual(buildScreenWatchAgentHistory(null), []);
  assert.deepEqual(buildScreenWatchAgentHistory(entries, 0), []);
});

test('buildScreenWatchTurnEntries：用户说话与回复各一条，空文本不产生条目', () => {
  const entries = buildScreenWatchTurnEntries({
    userText: ' 帮我看下这个报错 ',
    replyText: ' 这是空指针 ',
    imageUri: 'file:///shot.jpg',
    at: 1234,
    idFactory: prefix => `${prefix}-fixed`,
  });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    id: 'swu-fixed', role: 'user', text: '帮我看下这个报错', imageUri: 'file:///shot.jpg', at: 1234,
  });
  assert.deepEqual(entries[1], {
    id: 'swc-fixed', role: 'assistant', text: '这是空指针', imageUri: 'file:///shot.jpg', at: 1234,
  });
  // 纯截屏（用户没说话）→ 只有回复一条
  assert.equal(buildScreenWatchTurnEntries({ userText: '', replyText: 'x', at: 1, idFactory: p => p }).length, 1);
  // 空回复 → 只有用户那条
  assert.equal(buildScreenWatchTurnEntries({ userText: 'y', replyText: '  ', at: 1, idFactory: p => p }).length, 1);
  assert.deepEqual(buildScreenWatchTurnEntries({}), []);
});

test('runWorkspaceWatchTurn：走 agent 管线并把确认钩子原样透传', async () => {
  const calls = [];
  const confirm = async () => true;
  const result = await runWorkspaceWatchTurn({
    userText: '把 README 改一下',
    imageUri: 'file:///shot.jpg',
    mode: 'write',
    characterId: 'w1',
    runAgent: async payload => {
      calls.push(payload);
      return { text: '改好了', steps: [{ name: 'edit_workspace_file' }] };
    },
    confirm,
    readFrame: async uri => `data:image/jpeg;base64,${uri.slice(-3)}`,
    t,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '改好了');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, '把 README 改一下');
  assert.equal(calls[0].mode, 'write');
  assert.equal(calls[0].characterId, 'w1');
  assert.deepEqual(calls[0].images, ['data:image/jpeg;base64,jpg'], '帧转成 data URI 后传给 agent');
  assert.equal(calls[0].confirm, confirm, '确认钩子必须原样透传（缺失会导致破坏性操作被拒）');
});

test('runWorkspaceWatchTurn：确认被拒 → agent 拿到 false（不擅自放行）', async () => {
  let received = null;
  const deny = async () => false;
  await runWorkspaceWatchTurn({
    userText: '删掉所有文件',
    runAgent: async payload => { received = payload.confirm; return { text: '好的' }; },
    confirm: deny,
    t,
  });
  assert.equal(received, deny, '拒绝钩子也要传下去（registry 依此返回「用户拒绝」）');
  assert.equal(await received(), false);
});

test('runWorkspaceWatchTurn：权限规则原样透传（缺失会让写工具上的手写 deny 变死键）', async () => {
  let received = 'unset';
  const rules = [{ effect: 'deny', tool: 'run_shell' }];
  await runWorkspaceWatchTurn({
    userText: '跑一下',
    runAgent: async payload => { received = payload.permissionRules; return { text: 'ok' }; },
    permissionRules: rules,
    t,
  });
  assert.equal(received, rules, 'permissionRules 必须透传到 agent 循环（P0-2）');

  // 不传时保持 undefined 语义（不造空数组：空数组与「无规则」在求值层是两回事）
  let untouched = 'unset';
  await runWorkspaceWatchTurn({
    userText: '跑一下',
    runAgent: async payload => { untouched = payload.permissionRules; return { text: 'ok' }; },
    t,
  });
  assert.equal(untouched, null, '缺省时透传 null（与「没有规则」同义）');
});

test('runWorkspaceWatchTurn：线程历史注入 + 本轮条目落库（写失败不挡结果）', async () => {
  const appended = [];
  const thread = {
    id: 'th1',
    entries: [
      { id: 'e1', role: 'user', text: '先看下这个' },
      { id: 'e2', role: 'assistant', text: '好的' },
    ],
  };
  const result = await runWorkspaceWatchTurn({
    userText: '继续',
    thread,
    runAgent: async payload => {
      assert.deepEqual(payload.messages, [
        { role: 'user', content: '先看下这个' },
        { role: 'assistant', content: '好的' },
      ], '线程历史按 user/assistant 注入');
      return { text: '已完成' };
    },
    appendEntry: async (threadId, entry) => {
      appended.push({ threadId, entry });
      if (entry.role === 'user') throw new Error('写盘失败'); // 模拟失败：不得挡住结果
    },
    t,
  });
  assert.equal(result.ok, true, '线程写失败不得把本轮判成失败');
  assert.equal(result.text, '已完成');
  assert.equal(appended.length, 2, '两条都尝试落库');
  assert.deepEqual(appended.map(a => a.threadId), ['th1', 'th1']);
});

test('runWorkspaceWatchTurn：纯文字无内容不发请求；agent 缺失如实报错', async () => {
  let called = 0;
  const skipped = await runWorkspaceWatchTurn({
    userText: '   ',
    runAgent: async () => { called += 1; return { text: 'x' }; },
    t,
  });
  assert.equal(skipped.ok, false);
  assert.equal(called, 0, '没有内容就不该发请求');

  const unavailable = await runWorkspaceWatchTurn({ userText: '你好', t });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, 'screenWatch.error.agentUnavailable');
});

test('runWorkspaceWatchTurn：帧读取失败 → 专属文案（不把读盘失败说成模型问题）', async () => {
  const result = await runWorkspaceWatchTurn({
    userText: '看看',
    imageUri: 'file:///missing.jpg',
    runAgent: async () => ({ text: 'x' }),
    readFrame: async () => { throw new Error('ENOENT'); },
    t,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'screenWatch.capture.failed.body');
});

test('runWorkspaceWatchTurn：agent 抛错 → 带真实原因（不吞成一句通用失败）', async () => {
  const result = await runWorkspaceWatchTurn({
    userText: '跑一下测试',
    runAgent: async () => { throw new Error('503 upstream'); },
    t,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /screenWatch\.comments\.failed/);
  assert.match(result.error, /503 upstream/, '真实原因必须露出来（排查方向不能被带偏）');
});

test('runWorkspaceWatchTurn：空回复按失败处理（占位文本不是回答）', async () => {
  const result = await runWorkspaceWatchTurn({
    userText: '在吗',
    runAgent: async () => ({ text: '   ' }),
    t,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'error.comments.noReply');
});

test('runWorkspaceWatchTurn：中止（signal）不报错、不留失败态', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runWorkspaceWatchTurn({
    userText: '你好',
    signal: controller.signal,
    runAgent: async () => ({ text: 'x' }),
    t,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, '', '中止不是失败，不该给用户看错误');
});

test('词条齐备：SW2 新增键 zh/en 都在（漏译界面会显示原始键名）', async () => {
  const { zhCN } = await import('../src/i18n/locales/zh-CN.js');
  const { en } = await import('../src/i18n/locales/en.js');
  for (const [locale, table] of [['zh-CN', zhCN], ['en', en]]) {
    for (const key of [
      'screenWatch.error.agentUnavailable',
      'screenWatch.workspace.confirmTitle',
      'screenWatch.workspace.confirmBody',
      'screenWatch.workspace.confirmOk',
      'screenWatch.workspace.confirmCancel',
    ]) {
      assert.ok(typeof table[key] === 'string' && table[key].length > 0, `${locale} 缺 ${key}`);
    }
    assert.match(table['screenWatch.workspace.confirmBody'], /\{name\}/);
    assert.match(table['screenWatch.workspace.confirmBody'], /\{args\}/);
  }
});
