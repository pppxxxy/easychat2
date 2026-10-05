import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKSPACE_AGENT_BASE_PROMPT,
  buildWorkspaceAgentMessages,
  buildWorkspaceAgentSystemPrompt,
  projectWorkspaceChatHistory,
  workspaceAgentModeHint,
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
