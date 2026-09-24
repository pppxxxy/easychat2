import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/memorySummary.js');
const sourceCode = fs.readFileSync(sourcePath, 'utf8');
const transformed = babel.transformSync(sourceCode, {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

let summaryText = '';
const storageMock = {
  appendSessionSummary: async () => [],
  getSessionSummaries: async () => [],
  setSessionSummarizedUpTo: async () => {},
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './api' || request.endsWith('/api')) {
    return { sendChatMessage: async () => summaryText };
  }
  if (request === './storage' || request.endsWith('/storage')) {
    return storageMock;
  }
  if (request === './cardParser' || request.endsWith('/cardParser')) {
    return { createWorldEntry: partial => partial };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const filename = path.resolve('src/memorySummary.test-runtime.cjs');
const runtimeModule = new Module(filename);
runtimeModule.filename = filename;
runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
runtimeModule._compile(transformed, filename);
Module._load = originalLoad;
const memorySummary = runtimeModule.exports;

function makeMessages(turns) {
  return Array.from({ length: turns * 2 }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `消息 ${index + 1}`,
  }));
}

test('自动总结阈值按可总结消息计算', () => {
  const messages = makeMessages(9);
  const settings = { enabled: true, threshold: 8 };
  assert.equal(memorySummary.shouldSummarize({
    session: { summarizedUpTo: '' },
    messages,
    settings,
  }), true);
  const exactThresholdMessages = makeMessages(7);
  assert.equal(memorySummary.shouldSummarize({
    session: { summarizedUpTo: '' },
    messages: exactThresholdMessages,
    settings,
  }), true);
  assert.equal(memorySummary.shouldSummarize({
    session: { summarizedUpTo: '' },
    messages: makeMessages(6),
    settings,
  }), false);
  assert.equal(memorySummary.shouldSummarize({
    session: { summarizedUpTo: messages[7].id },
    messages,
    settings,
  }), false);
  assert.equal(memorySummary.shouldSummarize({
    session: { summarizedUpTo: '' },
    messages,
    settings: { enabled: false, threshold: 8 },
  }), false);
  assert.equal(memorySummary.shouldSummarize({
    session: { summarizedUpTo: '' },
    messages,
    settings: { enabled: false, threshold: 8 },
    force: true,
  }), true);
});

test('手动总结包含保留的最近消息且绕过自动候选限制', () => {
  const messages = makeMessages(3);
  const automatic = memorySummary.selectSummarizable(messages, '');
  const manual = memorySummary.selectManualSummarizable(messages, '');
  assert.equal(automatic.length, 0);
  assert.equal(manual.length, messages.length);
  assert.equal(
    memorySummary.selectManualSummarizable(messages, messages[messages.length - 1].id).length,
    messages.length
  );
});

test('关键词-only 总结不会推进边界', async () => {
  summaryText = '关键词：小明、会面';
  let updated = false;
  const result = await memorySummary.applySummary({
    session: { id: 'session-1', summarizedUpTo: '' },
    character: { id: 'character-1', worldInfo: [] },
    messages: makeMessages(2),
    updateCharacter: async () => { updated = true; },
  });
  assert.equal(result.skipped, true);
  assert.equal(updated, false);
});

test('生成非空摘要时写入世界书并推进边界', async () => {
  summaryText = '- 约定周末见面\n关键词：周末、见面';
  let patch = null;
  let boundary = '';
  storageMock.setSessionSummarizedUpTo = async (_sessionId, messageId) => {
    boundary = messageId;
  };
  const result = await memorySummary.applySummary({
    session: { id: 'session-2', summarizedUpTo: '' },
    character: { id: 'character-2', worldInfo: [] },
    messages: makeMessages(2),
    updateCharacter: async value => { patch = value; },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.summary, '- 约定周末见面');
  assert.equal(boundary, 'message-4');
  assert.equal(patch.worldInfo.length, 1);
  assert.equal(patch.worldInfo[0].content, '- 约定周末见面');
});

test('会话摘要边界写入失败时回滚摘要列表', async () => {
  summaryText = '- 新的约定\n关键词：约定';
  let summaries = [];
  storageMock.getSessionSummaries = async () => summaries;
  storageMock.saveSessionSummaries = async (_sessionId, list) => { summaries = list; };
  storageMock.setSessionSummarizedUpTo = async () => { throw new Error('boundary failed'); };
  await assert.rejects(() => memorySummary.applySummary({
    session: { id: 'session-rollback', summarizedUpTo: '' },
    character: { id: 'character-rollback', worldInfo: [] },
    messages: makeMessages(2),
    scoped: true,
    updateCharacter: async () => {},
  }), /boundary failed/);
  assert.deepEqual(summaries, []);
});
