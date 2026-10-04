import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/memory/memorySummary.js');
const sourceCode = fs.readFileSync(sourcePath, 'utf8');
const transformed = babel.transformSync(sourceCode, {
  babelrc: false,
  configFile: false,
  filename: sourcePath,
  presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

let summaryText = '';
let summaryRevision = 0;
let invalidateFails = false;
const storageMock = {
  appendSessionSummary: async (_sessionId, entry, expectedRevision) => {
    if (expectedRevision !== summaryRevision) throw new Error('会话摘要已重置');
    return [entry];
  },
  getSessionSummariesStatus: async () => ({ status: 'ok', summaries: [] }),
  getSessionSummaryRevision: () => summaryRevision,
  isSessionSummaryRevisionCurrent: (_sessionId, revision) => revision === summaryRevision,
  setSessionSummarizedUpTo: async () => {},
  invalidateSessionSummaries: async () => {
    if (invalidateFails) throw new Error('reset failed');
  },
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  // 按文件名匹配，兼容源码搬迁后 `./x.js` → `../x.js` 的相对路径变化。
  const base = String(request).split('/').pop();
  if (base === 'api.js') {
    return { sendChatMessage: async () => summaryText };
  }
  if (base === 'storage.js') {
    return storageMock;
  }
  if (base === 'cardParser.js') {
    return { createWorldEntry: partial => partial };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const filename = path.resolve('src/memory/memorySummary.js');
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

test('总结提示词只记剧情与关键对话，排除习惯/口头禅且不重复已有记忆', () => {
  const prompt = memorySummary.buildSummaryPrompt(
    [{ role: 'user', text: '你好' }, { role: 'assistant', text: '你好呀' }],
    '用户',
    '- 之前发生过的事'
  );
  const system = prompt[0].content;
  assert.ok(system.includes('重要对话'));
  assert.ok(system.includes('不要重复'));
  assert.ok(system.includes('口头禅'));
  assert.ok(system.includes('习惯'));
  assert.ok(system.includes('之前发生过的事'));
});

test('总结响应解析：记忆行、关键词行与占位过滤', () => {
  const response = memorySummary.parseSummaryResponse([
    '- 第一条记忆',
    '- 第二条记忆',
    '关键词：小明、咖啡店',
  ].join('\n'));
  assert.equal(response.skipped, false);
  assert.equal(response.summary, '- 第一条记忆\n- 第二条记忆');
  assert.deepEqual(response.keywords, ['小明', '咖啡店']);
  // 有记忆行但缺关键词行时回退「前情提要」
  assert.deepEqual(memorySummary.parseSummaryResponse('- 只有记忆').keywords, ['前情提要']);
  // 没有记忆行（只有关键词）时跳过
  const skipped = memorySummary.parseSummaryResponse('关键词：只有关键词');
  assert.equal(skipped.skipped, true);
  assert.deepEqual(skipped.keywords, []);
});

test('关键词行与记忆行解析的标签与分隔符', () => {
  assert.deepEqual(memorySummary.parseKeywordsLine('关键词：a、b，c; d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(memorySummary.parseKeywordsLine('Keywords: alpha, beta'), ['alpha', 'beta']);
  assert.deepEqual(memorySummary.parseKeywordsLine('没有关键词行'), []);
  assert.deepEqual(
    memorySummary.parseMemoryLines('- 记忆一\n关键词：x\n* 记忆二\n（暂无已记录的记忆）'),
    ['记忆一', '记忆二']
  );
});

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

test('删除总结边界后回退到最近仍存在的消息', () => {
  const messages = makeMessages(4);
  assert.equal(
    memorySummary.summarizeBoundaryAfterDeletion(messages, 'message-6', ['message-6']),
    'message-5'
  );
  assert.equal(
    memorySummary.summarizeBoundaryAfterDeletion(messages, 'message-6', ['message-5', 'message-6']),
    'message-4'
  );
  assert.equal(
    memorySummary.summarizeBoundaryAfterDeletion(
      messages,
      'message-6',
      ['message-1', 'message-2', 'message-3', 'message-4', 'message-5', 'message-6']
    ),
    ''
  );
  assert.equal(
    memorySummary.summarizeBoundaryAfterDeletion(messages, 'message-6', ['message-1']),
    'message-5'
  );
  assert.equal(
    memorySummary.summarizeBoundaryAfterDeletion(messages, 'message-6', ['message-7']),
    'message-6'
  );
});

test('已有会话摘要时不会因作用域降级而从上下文消失', () => {
  assert.equal(
    memorySummary.buildMemorySummaryText({}, [{ summary: '会话记忆' }], false),
    '会话记忆'
  );
});

test('摘要写回前发现角色世界书变化时放弃旧结果', async () => {
  summaryText = '- 新记忆\n关键词：记忆';
  await assert.rejects(
    () => memorySummary.applySummary({
      session: { id: 'session-conflict', summarizedUpTo: '' },
      character: { id: 'character-1', worldInfo: [] },
      messages: makeMessages(2),
      getCurrentCharacter: () => ({ id: 'character-1', worldInfo: [{ id: 'edited' }] }),
      updateCharacter: async () => {},
    }),
    /角色已在总结期间更新/
  );
});

test('已有会话摘要与世界书摘要同时保留，避免作用域切换分裂', () => {
  const text = memorySummary.buildMemorySummaryText(
    { worldInfo: [{ comment: '记忆总结 1', content: '世界记忆' }] },
    [{ summary: '会话记忆' }],
    false,
  );
  assert.match(text, /世界记忆/);
  assert.match(text, /会话记忆/);
});

test('会话作用域严格忽略世界书摘要，避免跨会话串味', () => {
  assert.equal(
    memorySummary.buildMemorySummaryText(
      { worldInfo: [{ comment: '记忆总结 1', content: '世界记忆' }] },
      [],
      true,
    ),
    ''
  );
});

test('摘要请求期间作用域变化时放弃写回，避免跨会话记忆泄漏', async () => {
  summaryText = '- 新记忆\n关键词：记忆';
  await assert.rejects(
    () => memorySummary.applySummary({
      session: { id: 'session-scope-change', summarizedUpTo: '' },
      character: { id: 'character-1', worldInfo: [] },
      messages: makeMessages(2),
      scoped: false,
      getCurrentScope: () => true,
      updateCharacter: async () => {},
    }),
    /记忆作用域已变化/
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
    updateCharacter: async value => {
      patch = typeof value === 'function'
        ? value({ id: 'character-2', worldInfo: [] })
        : value;
    },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.summary, '- 约定周末见面');
  assert.equal(boundary, 'message-4');
  assert.equal(patch.worldInfo.length, 1);
  assert.equal(patch.worldInfo[0].content, '- 约定周末见面');
});

test('会话摘要损坏时拒绝覆盖历史数据', async () => {
  summaryText = '- 新的约定\n关键词：约定';
  storageMock.getSessionSummariesStatus = async () => ({ status: 'corrupt', summaries: [] });
  await assert.rejects(() => memorySummary.applySummary({
    session: { id: 'session-corrupt', summarizedUpTo: '' },
    character: { id: 'character-corrupt', worldInfo: [] },
    messages: makeMessages(2),
    scoped: true,
    updateCharacter: async () => {},
  }), /记忆摘要读取失败/);
  storageMock.getSessionSummariesStatus = async () => ({ status: 'ok', summaries: [] });
});

test('会话摘要版本变化后拒绝写回', async () => {
  summaryText = '- 新的约定\n关键词：约定';
  let appended = false;
  storageMock.isSessionSummaryRevisionCurrent = () => false;
  storageMock.appendSessionSummary = async () => {
    appended = true;
    return [];
  };
  await assert.rejects(() => memorySummary.applySummary({
    session: { id: 'session-rollback', summarizedUpTo: '' },
    character: { id: 'character-rollback', worldInfo: [] },
    messages: makeMessages(2),
    scoped: true,
    updateCharacter: async () => {},
  }), /会话摘要已重置/);
  assert.equal(appended, false);
  storageMock.isSessionSummaryRevisionCurrent = (_sessionId, revision) => revision === summaryRevision;
});

test('启用向量记忆后自动总结强制降级为会话级', () => {
  const sessions = [{ id: 'only', characterId: 'c', preview: '有一条消息' }];
  // 默认（未启用向量）单会话写世界书
  assert.equal(memorySummary.isSessionScopedMemory(sessions, 'c'), false);
  // override=true（启用向量）时恒为会话级，跨会话召回交给向量
  assert.equal(memorySummary.isSessionScopedMemory(sessions, 'c', null, [], true), true);
});

test('记忆预算按向量命中与否分账且不会超支', () => {
  const plain = memorySummary.planMemoryBudget({ hasVectorContext: false });
  assert.equal(plain.vectorMaxChars, 0);
  assert.equal(plain.summaryMaxChars, memorySummary.MEMORY_CONTEXT_BUDGET);
  const withVector = memorySummary.planMemoryBudget({ hasVectorContext: true });
  assert.equal(
    withVector.vectorMaxChars + withVector.summaryMaxChars,
    memorySummary.MEMORY_CONTEXT_BUDGET
  );
  assert.ok(withVector.vectorMaxChars > withVector.summaryMaxChars);
});

test('摘要超出预算时优先保留较新的整条记忆', () => {
  const character = {
    worldInfo: [
      { comment: '记忆总结 1', content: '旧'.repeat(200) },
      { comment: '记忆总结 2', content: '新'.repeat(200) },
    ],
  };
  const text = memorySummary.buildMemorySummaryText(character, [], false, 220);
  assert.ok(text.length <= 220);
  assert.ok(text.includes('新'));
  assert.equal(text.includes('旧'), false);
  // 单条超过预算时保留其尾部，而不是整体丢弃
  const single = memorySummary.buildMemorySummaryText(
    { worldInfo: [{ comment: '记忆总结 1', content: 'A'.repeat(50) + '尾部' }] },
    [],
    false,
    2
  );
  assert.equal(single, '尾部');
});

test('preview 为空但已推进边界或当前有消息的会话仍计入记忆', () => {
  const sessions = [
    { id: 's1', characterId: 'c', preview: '' },
    { id: 's2', characterId: 'c', preview: '', summarizedUpTo: 'm1' },
    { id: 's3', characterId: 'c', type: 'group' },
  ];
  assert.equal(memorySummary.countCharacterMemories(sessions, 'c'), 1);
  assert.equal(
    memorySummary.countCharacterMemories(sessions, 'c', { id: 's1' }, [{ role: 'user', text: 'hi' }]),
    2
  );
  assert.equal(memorySummary.isSessionScopedMemory(sessions, 'c', { id: 's1' }, [{ role: 'user', text: 'hi' }]), true);
});

test('摘要失效规划与幸存会话摘要选择不误伤边界后的消息', () => {
  const messages = makeMessages(3);
  const boundary = 'message-6';
  assert.deepEqual(
    memorySummary.planSummaryInvalidation({ messages, summarizedUpTo: boundary, removedIds: ['message-1'] }),
    { touched: true, nextBoundary: 'message-5' }
  );
  assert.equal(
    memorySummary.planSummaryInvalidation({ messages, summarizedUpTo: boundary, removedIds: ['message-7'] }).touched,
    false
  );
  const summaries = [
    { summary: '边界内', boundary: 'message-6' },
    { summary: '边界后', boundary: '' },
  ];
  assert.deepEqual(
    memorySummary.selectSurvivingSessionSummaries(summaries, messages, ['message-6']).map(item => item.summary),
    ['边界后']
  );
  assert.equal(
    memorySummary.shouldInvalidateWorldSummary(
      { comment: '记忆总结 1', boundary: 'message-2' }, messages, ['message-1']
    ),
    true
  );
  assert.equal(
    memorySummary.shouldInvalidateWorldSummary(
      { comment: '记忆总结 1', boundary: 'message-6' }, messages, ['message-7']
    ),
    false
  );
});

test('边界写失败时精确补偿世界书摘要条目', async () => {
  summaryText = '- 需要回滚\n关键词：回滚';
  storageMock.setSessionSummarizedUpTo = async () => {
    throw new Error('boundary write failed');
  };
  const patches = [];
  await assert.rejects(() => memorySummary.applySummary({
    session: { id: 'session-compensate', summarizedUpTo: '' },
    character: { id: 'character-compensate', worldInfo: [] },
    messages: makeMessages(2),
    updateCharacter: async value => {
      const current = { id: 'character-compensate', worldInfo: [] };
      const resolved = typeof value === 'function' ? value(current) : value;
      patches.push(resolved);
    },
  }), /boundary write failed/);
  assert.equal(patches.length, 2);
  assert.equal(patches[0].worldInfo.length, 1);
  assert.equal(patches[1].worldInfo.length, 0);
  storageMock.setSessionSummarizedUpTo = async () => {};
});

test('摘要失效补偿会恢复世界书条目原来的开关状态', async () => {
  invalidateFails = true;
  try {
    let worldInfo = [
      { id: 'w1', comment: '记忆总结 1', boundary: 'm2', enabled: true },
      { id: 'w2', comment: '记忆总结 2', boundary: 'm1', enabled: false },
    ];
    const updateCharacter = async value => {
      const current = { id: 'character-invalidate', worldInfo };
      const resolved = typeof value === 'function' ? await value(current) : value;
      worldInfo = resolved.worldInfo;
    };
    await assert.rejects(() => memorySummary.invalidateHistorySummaries({
      session: { id: 'session-invalidate', summarizedUpTo: 'm2' },
      messages: [
        { id: 'm1', role: 'user', text: '一' },
        { id: 'm2', role: 'assistant', text: '二' },
        { id: 'm3', role: 'user', text: '三' },
      ],
      removedIds: ['m1'],
      scoped: false,
      character: { id: 'character-invalidate', worldInfo },
      updateCharacter,
    }), /reset failed/);
    assert.equal(worldInfo.find(entry => entry.id === 'w1').enabled, true);
    assert.equal(worldInfo.find(entry => entry.id === 'w1').stale, false);
    assert.equal(worldInfo.find(entry => entry.id === 'w2').enabled, false);
    assert.equal(worldInfo.find(entry => entry.id === 'w2').stale, false);
  } finally {
    invalidateFails = false;
  }
});
