import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/groupChat.js');
const transformed = babel.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const originalLoad = Module._load;
let lastChatCall = null;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './api') {
    return {
      isCanceledError: () => false,
      isConfigChangedError: () => false,
      sendChatMessage: async (messages) => {
        lastChatCall = messages;
        return '';
      },
    };
  }
  if (request === './chatPipeline') {
    return { buildRequestMessages: () => [] };
  }
  if (request === './chatMedia') {
    return { getMessagePromptText: item => String(item?.text || '') };
  }
  if (request === './regexEngine') {
    return {
      applyRegexScripts: text => text,
      REGEX_PLACEMENT: { USER_INPUT: 1, AI_OUTPUT: 2, WORLD_INFO: 5 },
    };
  }
  if (request === './groupMentions') {
    return {
      EVERYONE_MENTION: '全体',
      MENTION_PREFIX: '@',
      hasEveryoneMention: () => false,
      parseMentions: () => [],
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function loadGroupChat() {
  const filename = path.resolve('src/groupChat.test-runtime.cjs');
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(transformed, filename);
  return runtimeModule.exports;
}

test('群像提示词保留用户设定、全局预设、摘要、引用和联网资料', () => {
  const { buildEnsemblePrompt } = loadGroupChat();
  const prompt = buildEnsemblePrompt({
    characters: [{ id: 'a', name: '阿青', description: '安静', personality: '温和' }],
    historyMessages: [],
    userText: '继续',
    userProfile: { userName: '小明', persona: '用户喜欢简短回答' },
    globalPresets: ['保持中文'],
    quote: { name: '阿青', text: '之前说过的话' },
    summaryText: '已记住用户偏好',
    pluginContext: '网页摘要：外部事实',
    profiles: {},
  });
  const system = prompt[0].content;
  const userMessages = prompt.filter(item => item.role === 'user').map(item => item.content).join('\n');
  assert.match(system, /用户喜欢简短回答/);
  assert.match(system, /保持中文/);
  assert.match(system, /已记住用户偏好/);
  assert.match(userMessages, /之前说过的话/);
  assert.match(userMessages, /外部事实/);
  assert.match(userMessages, /联网搜索外部资料/);
});

test('群聊开场白把用户设定与全局预设传入提示词', async () => {
  const { generateOpening } = loadGroupChat();
  lastChatCall = null;
  await generateOpening({
    characters: [{ id: 'a', name: '阿青', description: '安静' }],
    userProfile: { persona: '用户喜欢简短回答' },
    globalPresets: ['保持中文'],
  });
  const userContent = lastChatCall
    .filter(item => item.role === 'user')
    .map(item => item.content)
    .join('\n');
  assert.match(userContent, /用户喜欢简短回答/);
  assert.match(userContent, /保持中文/);
  assert.match(userContent, /阿青/);
});