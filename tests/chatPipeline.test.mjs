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

test('图片与文字作为连续两条用户消息发送', () => {
  const messages = buildRequestMessages({
    character,
    historyMessages: [],
    imageMessages: [{
      kind: 'image',
      image: { name: '照片.jpg' },
      dataUri: 'data:image/jpeg;base64,abc',
    }],
    userText: '看看这张图',
    userProfile: {},
  });
  const userMessages = messages.filter(item => item.role === 'user');
  assert.equal(userMessages.length, 2);
  assert.equal(userMessages[0].content[1].image_url.url, 'data:image/jpeg;base64,abc');
  assert.equal(userMessages[1].content, '看看这张图');
});

test('无识图模型收到表情包名称提示', () => {
  const messages = buildRequestMessages({
    character,
    historyMessages: [],
    imageMessages: [{
      kind: 'sticker',
      image: { stickerId: 's1', stickerName: '开心' },
      dataUri: 'data:image/jpeg;base64,abc',
      includeImage: false,
    }],
    userText: '',
    userProfile: {},
  });
  const userMessages = messages.filter(item => item.role === 'user');
  assert.equal(userMessages.length, 1);
  assert.match(userMessages[0].content, /表情包：开心/);
  assert.equal(userMessages[0].content.includes('image_url'), false);
});

test('当前媒体名称经过用户输入正则处理', () => {
  const messages = buildRequestMessages({
    character: {
      ...character,
      regexScripts: [{
        id: 'redact-media',
        findRegex: '秘密',
        replaceString: '[已脱敏]',
        placement: [1],
        enabled: true,
        useRegex: false,
      }],
    },
    historyMessages: [],
    imageMessages: [{
      kind: 'image',
      image: { name: '秘密.jpg' },
      dataUri: 'data:image/jpeg;base64,abc',
    }],
    userText: '',
    userProfile: {},
  });
  const media = messages.find(item => Array.isArray(item.content));
  assert.match(media.content[0].text, /\[已脱敏\]/);
  assert.equal(media.content[0].text.includes('秘密'), false);
});

test('媒体名称参与世界书关键词激活', () => {
  const messages = buildRequestMessages({
    character: {
      ...character,
      worldInfo: [{ keys: ['照片.jpg'], content: '图片相关世界设定' }],
    },
    historyMessages: [],
    imageMessages: [{
      kind: 'image',
      image: { name: '照片.jpg' },
      dataUri: '',
      includeImage: false,
    }],
    userText: '',
    userProfile: {},
  });
  assert.ok(messages.find(item => item.role === 'system').content.includes('图片相关世界设定'));
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
