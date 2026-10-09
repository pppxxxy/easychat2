import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKSPACE_AGENT_BASE_PROMPT,
  buildWorkspaceAgentMessages,
  buildWorkspaceAgentSystemPrompt,
  projectWorkspaceChatHistory,
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
