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
  if (request === './api.js') {
    return {
      isCanceledError: () => false,
      isConfigChangedError: () => false,
      sendChatMessage: async (messages) => {
        lastChatCall = messages;
        return '';
      },
    };
  }
  if (request === './chatPipeline.js') {
    return { buildRequestMessages: () => [] };
  }
  if (request === './chatMedia.js') {
    return { getMessagePromptText: item => String(item?.text || '') };
  }
  if (request === './regexEngine.js') {
    return {
      applyRegexScripts: text => text,
      REGEX_PLACEMENT: { USER_INPUT: 1, AI_OUTPUT: 2, WORLD_INFO: 5 },
    };
  }
  if (request === './groupMentions.js') {
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
  const filename = path.resolve('src/groupChat.js');
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

test('群聊选人解析：JSON 提取、名称匹配与去重', () => {
  const { parseSpeakerResponse } = loadGroupChat();
  const characters = [{ id: 'a', name: '阿青' }, { id: 'b', name: '小蓝' }];
  assert.deepEqual(
    parseSpeakerResponse('```json\n{"speakers": ["阿青", "小蓝"]}\n```', characters),
    ['a', 'b']
  );
  assert.deepEqual(parseSpeakerResponse('{"speakers": ["阿青", "阿青", "不存在"]}', characters), ['a']);
  assert.deepEqual(parseSpeakerResponse('不是 JSON', characters), []);
  assert.deepEqual(parseSpeakerResponse('{"speakers": []}', characters), []);
});

test('群聊回复解析：分段、粗体标记、URL 不算发言人与相邻同角色合并', () => {
  const { parseEnsembleReply, mergeAdjacentSegments } = loadGroupChat();
  const characters = [{ id: 'a', name: '阿青' }, { id: 'b', name: '小蓝' }];
  const reply = parseEnsembleReply([
    '**阿青**：第一段发言',
    '补充一行',
    '',
    '小蓝：回应',
    'https://example.com/link',
  ].join('\n'), characters);
  assert.equal(reply.length, 2);
  assert.equal(reply[0].speakerId, 'a');
  assert.equal(reply[0].speakerName, '阿青');
  assert.equal(reply[0].text, '第一段发言\n补充一行');
  assert.equal(reply[1].speakerId, 'b');
  assert.equal(reply[1].text, '回应\nhttps://example.com/link');
  // 未匹配到角色时保留原始名、speakerId 为空（展示兜底）
  const unknown = parseEnsembleReply('路人甲：你好', characters);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].speakerId, '');
  assert.equal(unknown[0].speakerName, '路人甲');
  const merged = mergeAdjacentSegments([
    { speakerId: 'a', speakerName: '阿青', text: '第一句' },
    { speakerId: 'a', speakerName: '阿青', text: '第二句' },
    { speakerId: 'b', speakerName: '小蓝', text: '回应' },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, '第一句\n\n第二句');
  assert.equal(merged[1].speakerId, 'b');
});

test('群聊选人：模型失败时回退（点名 → 最近发言人轮换 → 首位成员）', async () => {
  const { selectSpeakers } = loadGroupChat();
  lastChatCall = null;
  const characters = [{ id: 'a', name: '阿青' }, { id: 'b', name: '小蓝' }, { id: 'c', name: '小红' }];
  // 点名优先
  assert.deepEqual(
    await selectSpeakers({ characters, history: [], userText: '继续', mentions: ['c'] }),
    ['c']
  );
  // 无点名：调度模型回空 → 最近发言人（小蓝）说完轮换到下一位（小红）
  const rotated = await selectSpeakers({
    characters,
    history: [
      { role: 'user', text: '问题' },
      { role: 'assistant', speakerId: 'b', speakerName: '小蓝', text: '回答' },
    ],
    userText: '继续',
  });
  assert.deepEqual(rotated, ['c']);
  // 无历史：回退首位成员
  const first = await selectSpeakers({ characters, history: [], userText: '继续' });
  assert.deepEqual(first, ['a']);
});
