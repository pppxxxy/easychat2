import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const sourcePath = path.resolve('src/chat/groupChat.js');
const moduleDirectory = path.resolve('src/chat/groupChat');

function isGroupChatModule(filename) {
  return filename === sourcePath || filename.startsWith(`${moduleDirectory}${path.sep}`);
}

function clearGroupChatCache() {
  for (const filename of Object.keys(Module._cache)) {
    if (isGroupChatModule(filename)) delete Module._cache[filename];
  }
}

function loadGroupChatModule(filename, parent) {
  if (Module._cache[filename]) return Module._cache[filename].exports;
  const runtimeModule = new Module(filename, parent);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  // Cache before compiling so recursive imports share the same module instance.
  Module._cache[filename] = runtimeModule;
  try {
    const transformed = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
      babelrc: false,
      configFile: false,
      filename,
      presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
    }).code;
    runtimeModule._compile(transformed, filename);
    runtimeModule.loaded = true;
    return runtimeModule.exports;
  } catch (error) {
    delete Module._cache[filename];
    throw error;
  }
}

const originalLoad = Module._load;
let lastChatCall = null;
let stubs;
Module._load = function patchedLoad(request, parent, isMain) {
  // 按 basename 匹配，兼容源码搬迁后 `./x.js` → `../x.js` 的相对路径变化。
  const base = String(request).split('/').pop();
  if (base === 'api.js') {
    return {
      isCanceledError: error => error?.canceled === true || error?.name === 'AbortError',
      isConfigChangedError: error => error?.code === 'CONFIG_CHANGED',
      sendChatMessage: async (messages, options) => {
        lastChatCall = messages;
        stubs.chatCalls.push({ messages, options });
        const reply = stubs.replies.shift() ?? '';
        if (reply instanceof Error) throw reply;
        return typeof reply === 'function' ? reply(messages, options) : reply;
      },
    };
  }
  if (base === 'chatPipeline.js') {
    return {
      buildRequestMessages: options => {
        stubs.requestCalls.push(options);
        return stubs.requestResult;
      },
    };
  }
  if (base === 'chatMedia.js') {
    return {
      getMessagePromptText: item => {
        stubs.mediaCalls.push(item);
        return stubs.mediaText(item);
      },
    };
  }
  if (base === 'regexEngine.js') {
    return {
      applyRegexScripts: (text, scripts, placement, options) => {
        stubs.regexCalls.push({ text, scripts, placement, options });
        return stubs.regexText(text);
      },
      REGEX_PLACEMENT: { USER_INPUT: 1, AI_OUTPUT: 2, WORLD_INFO: 5 },
    };
  }
  if (base === 'groupMentions.js') {
    return {
      EVERYONE_MENTION: '全体',
      MENTION_PREFIX: '@',
      hasEveryoneMention: () => false,
      parseMentions: () => [],
    };
  }
  if (request.startsWith('.') || path.isAbsolute(request)) {
    const filename = Module._resolveFilename(request, parent, isMain);
    if (isGroupChatModule(filename)) return loadGroupChatModule(filename, parent);
  }
  return originalLoad.call(this, request, parent, isMain);
};

after(() => {
  Module._load = originalLoad;
  clearGroupChatCache();
});

function loadGroupChat(options = {}) {
  clearGroupChatCache();
  lastChatCall = null;
  stubs = {
    replies: [...(options.replies || [])],
    requestResult: options.requestResult ?? [],
    mediaText: options.mediaText ?? (item => String(item?.text || '')),
    regexText: options.regexText ?? (text => text),
    chatCalls: [],
    requestCalls: [],
    mediaCalls: [],
    regexCalls: [],
  };
  try {
    return loadGroupChatModule(sourcePath);
  } catch (error) {
    clearGroupChatCache();
    throw error;
  }
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

test('群聊回复解析：粗体未匹配角色时名字不带星号，前缀名不误配', () => {
  const { parseEnsembleReply } = loadGroupChat();
  const characters = [{ id: 'al', name: 'Al' }, { id: 'alice', name: 'Alice' }];
  // 贪婪分组会把闭合 ** 吃进名字，未知说话人会展示成「旁白**」
  const bold = parseEnsembleReply('**旁白**：你好', characters);
  assert.equal(bold[0].speakerName, '旁白');
  // 前缀包含：Alice 不能误配到 Al
  const prefix = parseEnsembleReply('**Alice**：你好', characters);
  assert.equal(prefix[0].speakerId, 'alice');
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

test('群聊加载器复用模块实例，每次加载清理入口与子模块缓存', () => {
  const first = loadGroupChat();
  assert.strictEqual(require(sourcePath), first);
  const second = loadGroupChat();
  assert.notStrictEqual(second, first);
  assert.notStrictEqual(second.buildGroupContext, first.buildGroupContext);
  assert.notStrictEqual(second.generateMemberProfile, first.generateMemberProfile);
  assert.strictEqual(require(sourcePath), second);
});

test('简介生成复用已有缓存、跳过完整人设与无效成员，并保留原缓存', async () => {
  const { ensureMemberProfiles, needsProfile, PROFILE_MIN_CHARS } = loadGroupChat({
    replies: ['  新简介\n  合并空白  '],
  });
  const profiles = { cached: '已有简介', removed: '保留旧条目' };
  const characters = [
    null,
    { name: '没有 ID' },
    { id: 'cached', name: '已有角色' },
    { id: 'complete', name: '完整角色', description: '长'.repeat(PROFILE_MIN_CHARS) },
    {
      id: 'new', name: '阿青', description: '安静', personality: '温和',
      scenario: '茶馆', mesExample: '请坐', alternateGreetings: ['早上好', '晚上好'],
    },
  ];
  assert.equal(needsProfile({ description: '短'.repeat(PROFILE_MIN_CHARS - 1) }), true);
  assert.equal(needsProfile(characters[3]), false);
  const signal = new AbortController().signal;
  const options = { expectedConfigId: 'config-a', expectedConfigFingerprint: 'fingerprint-a', signal };
  const next = await ensureMemberProfiles({ characters, profiles, ...options });
  assert.deepEqual(next, { ...profiles, new: '新简介 合并空白' });
  assert.deepEqual(profiles, { cached: '已有简介', removed: '保留旧条目' });
  assert.notStrictEqual(next, profiles);
  assert.equal(stubs.chatCalls.length, 1);
  assert.deepEqual(stubs.chatCalls[0].options, options);
  assert.equal(stubs.chatCalls[0].messages[1].content,
    '名称：阿青\n简介：安静\n性格：温和\n场景：茶馆\n对话示例：请坐\n开场白：早上好 / 晚上好');
  assert.deepEqual(await ensureMemberProfiles({ characters, profiles: next }), next);
  assert.equal(stubs.chatCalls.length, 1);
});

test('简介空回复与普通错误返回 null，批量生成继续处理后续成员', async () => {
  const { generateMemberProfile, ensureMemberProfiles } = loadGroupChat({
    replies: [' \n ', new Error('offline'), '后续简介'],
  });
  assert.equal(await generateMemberProfile(null), null);
  assert.equal(stubs.chatCalls.length, 0);
  assert.equal(await generateMemberProfile({ id: 'empty' }), null);
  assert.deepEqual(await ensureMemberProfiles({
    characters: [{ id: 'failed' }, { id: 'next' }], profiles: null,
  }), { next: '后续简介' });
  assert.equal(stubs.chatCalls.length, 3);
  assert.deepEqual(await ensureMemberProfiles({ characters: null }), {});
});

test('简介批处理在已取消及成员间取消时停止，保留传入缓存', async () => {
  const controller = new AbortController();
  controller.abort();
  let api = loadGroupChat();
  await assert.rejects(api.ensureMemberProfiles({
    characters: [{ id: 'a' }], signal: controller.signal,
  }), error => error.name === 'AbortError' && error.canceled === true);
  assert.equal(stubs.chatCalls.length, 0);

  const midway = new AbortController();
  api = loadGroupChat({ replies: [() => { midway.abort(); return '首位简介'; }] });
  const profiles = {};
  await assert.rejects(api.ensureMemberProfiles({
    characters: [{ id: 'a' }, { id: 'b' }], profiles, signal: midway.signal,
  }), error => error.name === 'AbortError' && error.canceled === true);
  assert.equal(stubs.chatCalls.length, 1);
  assert.deepEqual(profiles, {});
});

for (const [label, error] of [
  ['取消', Object.assign(new Error('canceled'), { name: 'AbortError', canceled: true })],
  ['配置变化', Object.assign(new Error('changed'), { code: 'CONFIG_CHANGED' })],
]) {
  test(`简介、选人与开场原样传播${label}错误及请求配置`, async () => {
    const api = loadGroupChat({ replies: [error, error, error, error] });
    const character = { id: 'a', name: '阿青' };
    const signal = new AbortController().signal;
    const options = { expectedConfigId: 'config-b', expectedConfigFingerprint: 'fingerprint-b', signal };
    const args = { characters: [character], history: [], userText: '继续', ...options };
    for (const run of [
      () => api.generateMemberProfile(character, options.expectedConfigId, options.expectedConfigFingerprint, signal),
      () => api.ensureMemberProfiles({ ...args, characters: [character, { id: 'b' }] }),
      () => api.selectSpeakers(args),
      () => api.generateOpening(args),
    ]) {
      await assert.rejects(run, actual => actual === error);
    }
    assert.equal(stubs.chatCalls.length, 4);
    for (const call of stubs.chatCalls) assert.deepEqual(call.options, options);
  });
}

test('选人全体直返所有有效 ID，显式点名与模型选人均遵守上限', async () => {
  const { selectSpeakers, MAX_SPEAKERS } = loadGroupChat({
    replies: ['前言 {"speakers":["小红","阿青","小蓝","小白","小红","未知"]} 后记'],
  });
  const characters = [
    { id: 'a', name: '阿青' }, { id: 'b', name: '小蓝' },
    { id: 'c', name: '小红' }, { id: 'd', name: '小白' },
  ];
  assert.equal(MAX_SPEAKERS, 3);
  assert.deepEqual(await selectSpeakers({
    characters: [...characters, { name: '无 ID' }], everyone: true, mentions: ['c'],
  }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(await selectSpeakers({ characters, mentions: ['d', 'c', 'b', 'a'] }), ['d', 'c', 'b']);
  assert.deepEqual(await selectSpeakers({ characters: [], everyone: true }), []);
  assert.equal(stubs.chatCalls.length, 0);
  assert.deepEqual(await selectSpeakers({
    characters, history: [], userText: '继续', mentions: ['d', 'unknown'],
  }), ['d', 'c', 'a']);
  assert.equal(stubs.chatCalls.length, 1);
  assert.match(stubs.chatCalls[0].messages[1].content, /用户点名：小白/);
});

test('选人普通请求错误按文字点名和最近发言人回退', async () => {
  const { selectSpeakers } = loadGroupChat({ replies: [new Error('offline'), new Error('offline')] });
  const characters = [{ id: 'a', name: '阿青' }, { id: 'b', name: '小蓝' }];
  assert.deepEqual(await selectSpeakers({ characters, userText: '请小蓝回答' }), ['b']);
  assert.deepEqual(await selectSpeakers({
    characters, history: [{ role: 'assistant', speakerId: 'b', text: '上一轮' }], userText: '继续',
  }), ['a']);
});

test('开场解析支持围栏和包裹 JSON，未知角色与空正文分别回退', async () => {
  const { generateOpening } = loadGroupChat({ replies: [
    '```json\n{"opening":"  茶会开始  ","speaker":" 小蓝 "}\n```',
    '前言 {"opening":" 新场景 ","speaker":"陌生人"} 后记',
    '{"opening":"  ","speaker":"小蓝"}',
  ] });
  const characters = [{ id: 'a', name: '阿青' }, { id: 'b', name: '小蓝' }];
  assert.deepEqual(await generateOpening({ characters }), {
    opening: '茶会开始', speakerId: 'b', speakerName: '小蓝',
  });
  assert.deepEqual(await generateOpening({ characters }), {
    opening: '新场景', speakerId: 'a', speakerName: '阿青',
  });
  assert.deepEqual(await generateOpening({ characters }), {
    opening: '阿青、小蓝 已经就位。', speakerId: 'b', speakerName: '小蓝',
  });
});

test('开场无效 JSON、空回复与普通错误回退，空成员直接返回 null', async () => {
  const { generateOpening } = loadGroupChat({ replies: ['invalid', '', new Error('offline')] });
  assert.equal(await generateOpening({ characters: [] }), null);
  assert.equal(await generateOpening({ characters: null }), null);
  assert.equal(stubs.chatCalls.length, 0);
  const characters = [{ id: 'a', name: '阿青' }, { id: 'b', name: '小蓝' }];
  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(await generateOpening({ characters }), {
      opening: '阿青、小蓝 已经就位，对话开始了。', speakerId: 'a', speakerName: '阿青',
    });
  }
});

test('群聊历史仅改写发言人及图片提示文字，保留原消息元数据与引用', () => {
  const { buildGroupHistory } = loadGroupChat({ mediaText: item => `media:${item.text}` });
  const messages = [
    null,
    { id: 'u', role: 'user', text: '普通文字', quote: { text: '引用' } },
    { id: 'a', role: 'assistant', speakerId: 'a', speakerName: '阿青', text: '回答', extra: 1 },
    { id: 'i', role: 'user', text: '图片', image: { uri: 'file:///photo.jpg' }, timestamp: 42 },
    { id: 'anonymous', role: 'assistant', text: '无名回答' },
  ];
  const original = globalThis.structuredClone(messages);
  const history = buildGroupHistory(messages);
  assert.deepEqual(history, [
    messages[0], messages[1], { ...messages[2], text: '阿青：media:回答' },
    { ...messages[3], text: 'media:图片' }, messages[4],
  ]);
  assert.strictEqual(history[1], messages[1]);
  assert.strictEqual(history[3].image, messages[3].image);
  assert.strictEqual(history[4], messages[4]);
  assert.deepEqual(messages, original);
  assert.deepEqual(stubs.mediaCalls, [messages[2], messages[3]]);
  assert.deepEqual(buildGroupHistory(null), []);
});

test('群聊情境保留简介优先级、本人标记和最近发言限制，并调用媒体及正则桩', () => {
  const scriptA = { id: 'regex-a' };
  const scriptB = { id: 'regex-b' };
  const { buildGroupContext, GROUP_RECENT_LINES, MEMBER_RECENT_LINES } = loadGroupChat({
    mediaText: item => `media:${item.text}`,
    regexText: text => `regex:${text}`,
  });
  const characters = [
    { id: 'a', name: '阿青', description: '静态简介', regexScripts: [scriptA] },
    { id: 'b', name: '小蓝', description: ' 活泼 ', personality: ' 热心 ', regexScripts: [scriptB] },
    { id: 'c', name: '小红' },
  ];
  const historyMessages = [
    ...Array.from({ length: 10 }, (_, index) => ({
      role: 'assistant', speakerId: 'a', text: `发言${index}`,
    })),
    { role: 'user', text: '用户问题' },
    { role: 'system', text: '内部消息' },
    null,
  ];
  const context = buildGroupContext({
    speaker: characters[0], characters: [null, ...characters], historyMessages,
    profiles: { a: '缓存简介' },
  });
  assert.equal(MEMBER_RECENT_LINES, 3);
  assert.equal(GROUP_RECENT_LINES, 8);
  assert.match(context, /阿青（你自己）：缓存简介\n  最近发言：发言7 \/ 发言8 \/ 发言9/);
  assert.match(context, /小蓝：活泼 热心/);
  assert.match(context, /小红：群聊成员之一，称为「小红」。/);
  assert.match(context, /小蓝、小红 也会发言/);
  assert.doesNotMatch(context, /静态简介|内部消息|发言0|发言1|发言2/);
  const recent = historyMessages.filter(item => item && item.role !== 'system').slice(-GROUP_RECENT_LINES);
  assert.equal(context.split('最近对话：\n')[1], recent.map(item =>
    `${item.role === 'user' ? '用户' : '阿青'}：regex:media:${item.text}`
  ).join('\n'));
  assert.deepEqual(stubs.mediaCalls, recent);
  assert.deepEqual(stubs.regexCalls, recent.map(item => ({
    text: `media:${item.text}`, scripts: [scriptA, scriptB], placement: 1,
    options: { mode: 'prompt', depth: 0 },
  })));
  assert.equal(buildGroupContext({ characters: [] }), '');
  assert.match(buildGroupContext({ speaker: characters[0], characters: [characters[0]] }), /本群唯一的角色/);
});

test('群聊请求完整透传用户设定、预设、引用、摘要、插件和图片，返回管线原结果', () => {
  const requestResult = [{ role: 'system', content: 'pipeline result' }];
  const { buildGroupRequest } = loadGroupChat({ requestResult });
  const speaker = { id: 'a', name: '阿青' };
  const args = {
    speaker, characters: [speaker],
    historyMessages: [{ id: 'h', role: 'assistant', speakerName: '阿青', text: '之前的回答', extra: true }],
    userText: '  保留用户空白  ', userProfile: { userName: '小明', persona: '偏好简短' },
    globalPresets: ['中文'], quote: { name: '小蓝', text: '引用' },
    summaryText: '摘要', pluginContext: '联网资料', profiles: { a: '角色缓存简介' },
    imageMessages: [{ image: { uri: 'file:///photo.jpg' }, includeImage: false }],
  };
  const original = globalThis.structuredClone(args);
  assert.strictEqual(buildGroupRequest(args), requestResult);
  assert.equal(stubs.requestCalls.length, 1);
  const { groupContext, ...forwarded } = stubs.requestCalls[0];
  assert.deepEqual(forwarded, {
    character: speaker,
    historyMessages: [{ ...args.historyMessages[0], text: '阿青：之前的回答' }],
    userText: args.userText, userProfile: args.userProfile, globalPresets: args.globalPresets,
    quote: args.quote, summaryText: args.summaryText, pluginContext: args.pluginContext,
    imageMessages: args.imageMessages,
  });
  for (const key of ['userProfile', 'globalPresets', 'quote', 'imageMessages']) {
    assert.strictEqual(forwarded[key], args[key]);
  }
  assert.strictEqual(forwarded.character, speaker);
  assert.match(groupContext, /阿青（你自己）：角色缓存简介/);
  assert.match(groupContext, /阿青：之前的回答/);
  assert.deepEqual(args, original);
});

test('群像图片按 includeImage 控制附件，所有有效媒体文字均经正则处理', () => {
  const scripts = [{ id: 'a' }, { id: 'b' }];
  const { buildEnsemblePrompt } = loadGroupChat({
    mediaText: item => `media:${item.text}`,
    regexText: text => `regex:${text}`,
  });
  const characters = [
    { id: 'a', name: '阿青', regexScripts: [scripts[0]] },
    { id: 'b', name: '小蓝', regexScripts: [scripts[1]] },
  ];
  const imageMessages = [
    { text: '可见图片', dataUri: 'data:image/png;base64,AA==' },
    { text: '隐藏图片', dataUri: 'data:image/png;base64,AQ==', includeImage: false },
    { text: '本地图片', image: { uri: 'file:///photo.jpg' } },
    null,
    { text: '没有媒体' },
  ];
  const original = globalThis.structuredClone(imageMessages);
  const prompt = buildEnsemblePrompt({ characters, imageMessages, userText: '' });
  assert.deepEqual(prompt.slice(1), [
    { role: 'user', content: [
      { type: 'text', text: 'regex:media:可见图片' },
      { type: 'image_url', image_url: { url: imageMessages[0].dataUri } },
    ] },
    { role: 'user', content: 'regex:media:隐藏图片' },
    { role: 'user', content: 'regex:media:本地图片' },
  ]);
  assert.deepEqual(stubs.mediaCalls, imageMessages.slice(0, 3));
  assert.deepEqual(stubs.regexCalls, imageMessages.slice(0, 3).map(item => ({
    text: `media:${item.text}`, scripts, placement: 1, options: { mode: 'prompt', depth: 0 },
  })));
  assert.deepEqual(imageMessages, original);
});

test('群像历史取最近八条有效对话，保留角色标签并处理媒体文字', () => {
  const { buildEnsemblePrompt } = loadGroupChat({
    mediaText: item => `media:${item.text}`,
    regexText: text => `regex:${text}`,
  });
  const historyMessages = [
    { role: 'user', text: '窗口外' },
    ...Array.from({ length: 7 }, (_, index) => ({
      role: 'assistant', speakerId: 'a', text: `历史${index}`,
    })),
    { role: 'user', text: '图片说明', image: { uri: 'file:///photo.jpg' } },
    { role: 'system', text: '内部消息' },
    null,
  ];
  const prompt = buildEnsemblePrompt({
    characters: [{ id: 'a', name: '阿青' }], historyMessages, userText: '继续',
  });
  const recent = historyMessages.slice(1, 9);
  assert.equal(prompt[0].content.split('最近对话：\n')[1], recent.map(item =>
    `${item.role === 'user' ? '用户' : '阿青'}：regex:media:${item.text}`
  ).join('\n'));
  assert.doesNotMatch(prompt[0].content, /窗口外|内部消息/);
  assert.deepEqual(stubs.mediaCalls, recent);
  assert.deepEqual(stubs.regexCalls, recent.map(item => ({
    text: `media:${item.text}`, scripts: [], placement: 1, options: { mode: 'prompt', depth: 0 },
  })));
});

test('群像点名按 ID 映射，全体优先，空输入使用旁白续聊且空成员不请求', () => {
  const { buildEnsemblePrompt } = loadGroupChat();
  const characters = [{ id: 'a', name: '阿青' }, { id: 'b', name: '小蓝' }];
  const named = buildEnsemblePrompt({ characters, mentions: ['b', 'unknown'], userText: '  回答  ' });
  assert.match(named[0].content, /用户在本轮点名了：小蓝。/);
  assert.doesNotMatch(named[0].content, /unknown/);
  assert.deepEqual(named[1], { role: 'user', content: '回答' });
  const everyone = buildEnsemblePrompt({ characters, mentions: ['b'], everyone: true });
  assert.match(everyone[0].content, /用户在本轮点名了全体成员/);
  assert.doesNotMatch(everyone[0].content, /用户在本轮点名了：/);
  assert.deepEqual(everyone[1], {
    role: 'system', content: '（以上是当前场景的旁白，请让需要回应的角色自然发言。）',
  });
  const empty = buildEnsemblePrompt({ characters, userText: '  ', imageMessages: [null, { text: '无图' }] });
  assert.deepEqual(empty[1], everyone[1]);
  assert.equal(empty.length, 2);
  assert.deepEqual(buildEnsemblePrompt({ characters: [null], userText: '继续' }), []);
  assert.deepEqual(stubs.mediaCalls, []);
  assert.deepEqual(stubs.regexCalls, []);
});
