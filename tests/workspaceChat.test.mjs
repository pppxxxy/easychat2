import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKSPACE_AGENT_BASE_PROMPT,
  buildWorkspaceAgentMessages,
  buildWorkspaceAgentSystemPrompt,
  projectWorkspaceChatHistory,
  resolveSendText,
  toolOrderSignature,
  workspaceAgentModeHint,
  workspaceExecutionToolHints,
} from '../src/workspace/chat.js';

test('buildWorkspaceAgentSystemPrompt：基础提示 + 角色名 + 模式提示', () => {
  const prompt = buildWorkspaceAgentSystemPrompt({ mode: 'write', characterName: '小美' });
  assert.ok(prompt.startsWith(WORKSPACE_AGENT_BASE_PROMPT));
  assert.match(prompt, /小美/);
  assert.match(prompt, /可改/);
  // 三种模式各自给出不同的提示
  assert.notEqual(workspaceAgentModeHint('ask'), workspaceAgentModeHint('read'));
  assert.notEqual(workspaceAgentModeHint('read'), workspaceAgentModeHint('write'));
  // 未知模式回退到只读问答
  assert.equal(workspaceAgentModeHint('WEIRD'), workspaceAgentModeHint('ask'));
});

// 2026-10-08 真机观察：用户开了 Python 开关后让模型「用 python 算一下 1234*567」，
// 模型**没有调用工具**，而是写了个 `>>> 1234 * 567` 的代码块把答案算出来贴上去——
// 看起来像跑过了，其实一次都没跑（当时跑的是没带这版工具的旧包，但提示词这一侧的
// 缺口是真实存在的：模式提示只列了文件操作，模型没有「我这儿真能跑代码」这条信息）。
//
// 所以：提示词要按**注册表里真实存在的工具**补上执行类说明，并明确点出
// 「写出代码不等于真的跑过」——后者是这次真机现象直接换来的。
test('系统提示：只在工具真的注册了时才写执行类说明，且点明「写出代码 ≠ 跑过」', () => {
  const base = ['list_workspace_files', 'read_workspace_file'];

  const withPython = buildWorkspaceAgentSystemPrompt({ mode: 'write', tools: [...base, 'run_python'] });
  assert.match(withPython, /run_python/, '注册了就必须告诉模型它能用');
  assert.match(withPython, /不等于真的跑过/, '要明确否掉「写代码块就算执行过」这种假动作');
  assert.equal(/run_shell/.test(withPython), false, '没注册的工具不得出现在提示词里');

  const withShell = buildWorkspaceAgentSystemPrompt({ mode: 'write', tools: [...base, 'run_shell'] });
  assert.match(withShell, /run_shell/);
  assert.equal(/run_python/.test(withShell), false);

  // 没传 / 空清单 → 一条执行类说明都不能有：不能承诺一个调不动的能力
  assert.equal(/run_python|run_shell/.test(buildWorkspaceAgentSystemPrompt({ mode: 'write' })), false);
  assert.equal(/run_python|run_shell/.test(buildWorkspaceAgentSystemPrompt({ mode: 'write', tools: [] })), false);

  // 只读/询问模式：即便调用方把工具名传进来也不许提（两道门，各管各的）
  assert.equal(/run_python/.test(buildWorkspaceAgentSystemPrompt({ mode: 'read', tools: ['run_python'] })), false);
  assert.equal(/run_python/.test(buildWorkspaceAgentSystemPrompt({ mode: 'ask', tools: ['run_python'] })), false);

  // 纯函数出口：命中哪些工具就返回哪几条说明 + 一条通用验证约定（A0），顺序稳定
  assert.deepEqual(workspaceExecutionToolHints(['run_python', 'x']).length, 2, '工具说明 + 验证约定');
  assert.deepEqual(workspaceExecutionToolHints(['run_shell', 'run_python']).length, 3);
  assert.deepEqual(workspaceExecutionToolHints(null), [], '没有任何执行工具 → 空（连验证约定也不注入）');
});

test('A0 规划与验证引导：三步清单约定常驻；验证闭环只在有执行工具时注入', () => {
  // 规划引导是流程约定，所有模式都成立（ask 里讨论多步任务同样适用）
  const ask = buildWorkspaceAgentSystemPrompt({ mode: 'ask' });
  assert.match(ask, /三步以上/, '规划引导对所有模式生效');
  assert.match(ask, /勾掉/, '逐步执行、完成一步勾掉一步');
  assert.equal(/验证/.test(ask), false, 'ask 模式没有执行工具，不提验证（说了也做不到）');

  // 验证闭环只在任一执行工具可用时注入（不绑定具体工具）
  const withShell = buildWorkspaceAgentSystemPrompt({ mode: 'write', tools: ['run_shell'] });
  assert.match(withShell, /验证/, '有执行工具 → 验证闭环约定在');
  assert.match(withShell, /带病收尾/, '验证不过继续修，不带病收尾');
  const noTools = buildWorkspaceAgentSystemPrompt({ mode: 'write', tools: [] });
  assert.equal(/带病收尾/.test(noTools), false, '没有执行工具就不提验证');
});

test('projectWorkspaceChatHistory：只保留有文字的 user/assistant', () => {
  const history = projectWorkspaceChatHistory([
    { role: 'user', content: '把 a.txt 改成 b' },
    { role: 'assistant', content: '   ' },
    { role: 'error', content: 'boom' },
    { role: 'assistant', content: '已处理' },
    null,
  ]);
  assert.deepEqual(history, [
    { role: 'user', content: '把 a.txt 改成 b' },
    { role: 'assistant', content: '已处理' },
  ]);
});

test('buildWorkspaceAgentMessages：system 在前，历史随后，纯文本用户消息', () => {
  const messages = buildWorkspaceAgentMessages({
    systemPrompt: 'SYS',
    history: [{ role: 'user', content: '早' }, { role: 'assistant', content: '你好' }],
    userText: '列出文件',
  });
  assert.deepEqual(messages, [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: '早' },
    { role: 'assistant', content: '你好' },
    { role: 'user', content: '列出文件' },
  ]);
});

test('buildWorkspaceAgentMessages：有图片时用多模态 content 数组', () => {
  const messages = buildWorkspaceAgentMessages({
    systemPrompt: 'SYS',
    userText: '看看这张图',
    images: ['data:image/png;base64,AAA', { dataUri: 'data:image/jpeg;base64,BBB' }],
  });
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'user');
  assert.deepEqual(last.content, [
    { type: 'text', text: '看看这张图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } },
  ]);
});

test('buildWorkspaceAgentMessages：只有图片没有文字时用占位文本', () => {
  const messages = buildWorkspaceAgentMessages({ systemPrompt: 'SYS', images: ['data:image/png;base64,AAA'] });
  assert.equal(messages[1].content[0].text, '[用户发来图片]');
});

test('E1 缓存契约：readLog 行（每轮最高频动态项）必须在 systemPrompt 最末尾', () => {
  const prompt = buildWorkspaceAgentSystemPrompt({
    mode: 'write',
    characterName: '小助手',
    tools: ['run_shell', 'update_plan', 'materialize_repo'],
    memory: '# 记忆\n- 约定一',
    skills: [{ name: 'lint', description: '跑 lint' }],
    readLog: [{ path: 'a.js', chars: 3200 }],
  });
  const idx = prompt.indexOf('本会话已读');
  assert.ok(idx > 0, 'readLog 行在');
  // 最硬的判据：它之后**不能有任何内容**（连换行都没有）——前缀缓存按 token 序列
  // 工作，它在最尾 = 变化时「后面」为空，静态段与历史的命中全保住。
  assert.equal(prompt.slice(idx).includes('\n'), false, 'readLog 行之后不允许再有任何行');

  // 对照：memory/skills/工具引导都在它前面（静态段前置、动态段后置的次序契约）
  assert.ok(prompt.indexOf('约定一') < idx, 'memory 在 readLog 前');
  assert.ok(prompt.indexOf('lint') < idx, '技能清单在 readLog 前');
  assert.ok(prompt.indexOf('update_plan') < idx, '计划引导在 readLog 前');

  // 没有 readLog（没读过任何文件）→ 提示词与不带该参数逐字一致（零行为变化）
  const noLog = buildWorkspaceAgentSystemPrompt({ mode: 'write', characterName: '小助手', tools: ['run_shell'] });
  assert.equal(/本会话已读/.test(noLog), false);
});

test('E1 toolOrderSignature：两种形态归一、顺序敏感（漂移检出）、空输入空串', () => {
  assert.equal(toolOrderSignature(['a', 'b']), 'a,b', '纯名字数组');
  assert.equal(
    toolOrderSignature([{ function: { name: 'a' } }, { function: { name: 'b' } }]),
    'a,b',
    '工具定义数组取 function.name'
  );
  // 顺序不同 → 签名不同：前缀缓存按**序列**工作，顺序一变 = 全 miss，这正是要检出的
  assert.notEqual(toolOrderSignature(['b', 'a']), toolOrderSignature(['a', 'b']));
  assert.equal(toolOrderSignature(null), '');
  assert.equal(toolOrderSignature([]), '');
  assert.equal(toolOrderSignature(['a', null, 'b']), 'a,b', '杂项被过滤不产生空段');
});

test('P5：projectWorkspaceChatHistory 展开 toolTrace，tool 消息透传', () => {
  const projected = projectWorkspaceChatHistory([
    { role: 'user', content: '读 a.js' },
    {
      role: 'assistant',
      content: '读完了',
      toolTrace: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_workspace_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'body' },
      ],
    },
  ]);
  assert.equal(projected.length, 4);
  assert.ok(Array.isArray(projected[1].tool_calls) && projected[1].tool_calls[0].id === 'c1');
  assert.equal(projected[2].role, 'tool');
  assert.equal(projected[2].content, 'body');
  assert.equal(projected[3].role, 'assistant');
  assert.equal(projected[3].content, '读完了');
  // 无轨迹的普通消息行为不变
  assert.deepEqual(projectWorkspaceChatHistory([{ role: 'user', content: 'x' }]), [{ role: 'user', content: 'x' }]);
});

// 回归：工作区里发什么都变成 "[object Object]"。
// 根因是 `onPress={handleSend}`——RN 会把**点击事件对象**当第一个实参传给 handleSend，
// 而当时的判据是「不是 undefined 就用它」，于是 `String(事件对象)` 成了 "[object Object]"。
test('resolveSendText：事件对象不算 override（只认字符串），否则会发出 [object Object]', () => {
  // 按钮点击：RN 传进来的是一个事件对象 → 必须回落到输入框
  const pressEvent = { nativeEvent: { pageX: 1, pageY: 2 }, persist() {} };
  assert.equal(resolveSendText(pressEvent, '你好'), '你好');
  assert.notEqual(resolveSendText(pressEvent, '你好'), '[object Object]');
  // 数字/布尔/null 同样不是文本，一并回落（只有字符串才算显式覆盖）
  for (const bad of [0, 1, true, false, null, {}, [], () => {}]) {
    assert.equal(resolveSendText(bad, '输入框内容'), '输入框内容', `${String(bad)} 不该被当作文本`);
  }
  // 计划批准链路（I2）传的是真字符串 → 照常覆盖输入框
  assert.equal(resolveSendText('确认执行计划', '用户正打着的别的话'), '确认执行计划');
  assert.equal(resolveSendText('', '输入框内容'), '', '空字符串是显式覆盖（清空发送）');
  // 输入框为空时回落为空串，不抛
  assert.equal(resolveSendText(undefined, undefined), '');
  assert.equal(resolveSendText(pressEvent, undefined), '');
  // 两侧都做 trim（与旧行为一致）
  assert.equal(resolveSendText('  x  ', 'y'), 'x');
  assert.equal(resolveSendText(undefined, '  y  '), 'y');
});
