import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_OUTPUT_FORMAT_PROMPT,
  buildRequestMessages,
} from '../src/chatPipeline.js';

const character = { name: '测试角色', systemPrompt: '你是测试角色。', regexScripts: [] };

test('始终附带输出格式指令，不依赖预设开关', () => {
  const messages = buildRequestMessages({
    character,
    historyMessages: [],
    userText: '你好',
    userProfile: { userName: '小明', persona: '' },
    globalPresets: [],
  });
  const system = messages.find(item => item.role === 'system');
  assert.ok(system.content.includes('[输出格式]'));
  assert.ok(system.content.includes(DEFAULT_OUTPUT_FORMAT_PROMPT));
});

test('角色预设与全局预设按角色范围注入', () => {
  const messages = buildRequestMessages({
    character: {
      ...character,
      presets: [
        { id: 'style', prompt: '保持角色语气', enabled: true },
        { id: 'off', prompt: '关闭内容', enabled: false },
      ],
    },
    historyMessages: [],
    userText: '你好',
    userProfile: { userName: '小明' },
    globalPresets: ['全局内容'],
  });
  const system = messages.find(item => item.role === 'system');
  assert.ok(system.content.includes('[角色预设]'));
  assert.ok(system.content.includes('保持角色语气'));
  assert.equal(system.content.includes('关闭内容'), false);
  assert.ok(system.content.includes('[全局预设]'));
  assert.ok(system.content.indexOf('[角色预设]') < system.content.indexOf('[全局预设]'));
});

test('全局预设与输出格式指令共存', () => {
  const messages = buildRequestMessages({
    character,
    historyMessages: [],
    userText: '你好',
    userProfile: {},
    globalPresets: ['保持沉浸'],
  });
  const system = messages.find(item => item.role === 'system');
  assert.ok(system.content.includes('[全局预设]'));
  assert.ok(system.content.includes('保持沉浸'));
  assert.ok(system.content.includes('[输出格式]'));
});
