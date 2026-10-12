import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORGE_QUESTIONS,
  appendTranscript,
  buildAdvancedPrompt,
  buildEditPrompt,
  buildGeneratePrompt,
  buildJsonRepairPrompt,
  createForgeDraft,
  createForgeState,
  currentQuestion,
  draftFromCharacter,
  draftToCharacterPatch,
  buildEntryAssistPrompt,
  buildFieldAssistPrompt,
  buildTagsAssistPrompt,
  mergeEntryAssistPatch,
  parseEntryAssistPatch,
  FIELD_ASSIST_SYSTEM,
  hasCardContent,
  mergeDraft,
  parseCardPatch,
  parseFieldAssistText,
  projectForgeDraft,
  recordAnswer,
  requestedAdvancedSections,
  summarizeAnswers,
  // 问题 D/H：字段上限表与高级内容 sanitizer 现在都在 barrel（公共 API）里
  ENTRY_KEYS_MAX_COUNT,
  AVATAR_DIRECTORY,
  FORGE_MEDIA_DIRECTORY,
  buildForgeImageName,
  buildPromotedAvatarName,
  collapseOnlyFlags,
  entryFieldLimit,
  forgeImageExtension,
  forgeImageNamesToDelete,
  forgeMediaDirectory,
  avatarDirectory,
  isForgeMediaUri,
  isForgePayloadFileName,
  sanitizeAdvancedArray,
  sanitizePreset,
  sanitizeRegexScript,
  sanitizeWorldEntry,
} from '../src/cardForge/forge.js';
// 危险正则判定与聊天引擎共用同一份实现（问题 A）：这里直接引用引擎的纯函数，
// 断言「被标记的那条 == 引擎会跳过的那条」，而不是自己再写一遍启发式。
import { isUnsafeRegexPattern } from '../src/prompt/regexEngine.js';
// 参考实现：worldInfo 的 depth 口径以 cardParser 的 firstNumber 为准（问题 C）。
import { firstNumber } from '../src/character/cardParser/normalizeUtils.js';
import {
  buildPreviewDisplayTurns,
  buildPreviewOpeningTurns,
  buildPreviewSections,
  applyPreviewDisplay,
  capPreviewHistory,
  previewAdvancedCounts,
} from '../src/cardForge/preview.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { zhCN } from '../src/i18n/locales/zh-CN.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORGE_EDITOR_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'CardForgeEditor.js'), 'utf8');
const FORGE_SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'CardForgeScreen.js'), 'utf8');
const PREVIEW_MODAL_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'CardPreviewModal.js'), 'utf8');

test('新会话包含引导与第一题', () => {
  const state = createForgeState(1000);
  assert.equal(state.step, 0);
  assert.equal(state.transcript.length, 2);
  assert.equal(state.transcript[0].role, 'ai');
  assert.equal(state.transcript[1].questionId, FORGE_QUESTIONS[0].id);
  assert.equal(currentQuestion(state).id, 'name');
  assert.equal(hasCardContent(state.draft), false);
});

test('重复提交旧问题不会跳过当前问题', () => {
  let state = createForgeState(1000);
  state = recordAnswer(state, 'name', '晚星', 2000);
  const repeated = recordAnswer(state, 'name', '再次点击', 2001);
  assert.equal(repeated.step, 1);
  assert.equal(repeated.answers.name, '晚星');
});

test('大字段在制卡投影和 AI 合并中保持完整', () => {
  const firstMes = '开'.repeat(5000);
  const base = { ...createForgeDraft(), firstMes };
  const projected = projectForgeDraft(base);
  assert.equal(projected.firstMes, firstMes);
  const { draft } = mergeDraft(base, { personality: '温柔' });
  assert.equal(draft.firstMes, firstMes);
});

test('记录答案会推进到下一题，答完给出提示', () => {
  let state = createForgeState(1000);
  state = recordAnswer(state, 'name', '晚星', 2000);
  assert.equal(state.step, 1);
  assert.equal(state.answers.name, '晚星');
  assert.equal(state.transcript[state.transcript.length - 1].questionId, 'gender');

  // 一路答到底
  FORGE_QUESTIONS.slice(1).forEach((question, index) => {
    state = recordAnswer(state, question.id, `答案${index}`, 3000 + index);
  });
  assert.equal(state.step, FORGE_QUESTIONS.length);
  assert.equal(currentQuestion(state), null);
  const last = state.transcript[state.transcript.length - 1];
  assert.equal(last.role, 'note');
  assert.ok(last.text.includes('生成'));
});

test('解析模型回复：容忍代码块与前后文字，只取白名单字段', () => {
  const fenced = parseCardPatch('好的，这是结果：\n```json\n{"name":"晚星","personality":"温柔","未知字段":"忽略","tags":["治愈","日常"]}\n```\n希望满意');
  assert.deepEqual(Object.keys(fenced).sort(), ['name', 'personality', 'tags']);
  assert.equal(fenced.name, '晚星');
  assert.deepEqual(fenced.tags, ['治愈', '日常']);

  const bare = parseCardPatch('{"name":"晚星"}');
  assert.equal(bare.name, '晚星');

  const withProse = parseCardPatch('结果如下 {"firstMes":"你好呀"} 完毕');
  assert.equal(withProse.firstMes, '你好呀');
});

test('解析失败返回 null，不会抛异常', () => {
  assert.equal(parseCardPatch(''), null);
  assert.equal(parseCardPatch('完全没有 JSON'), null);
  assert.equal(parseCardPatch('{"unknown":1}'), null);
  assert.equal(parseCardPatch(null), null);
});

test('合并草稿只记有变化的字段', () => {
  const base = { ...createForgeDraft(), name: '晚星' };
  const { draft, changed } = mergeDraft(base, {
    name: '晚星',
    personality: '温柔体贴',
    description: '   ',
    tags: ['日常'],
  });
  assert.equal(draft.personality, '温柔体贴');
  assert.equal(draft.description, '');
  assert.deepEqual(draft.tags, ['日常']);
  assert.deepEqual(changed, ['性格', '标签']);
});

test('AI 可以用 null 哨兵显式清空文本字段和标签', () => {
  const base = {
    ...createForgeDraft(),
    description: '旧描述',
    personality: '旧性格',
    tags: ['旧标签'],
  };
  const { draft, changed } = mergeDraft(base, {
    description: null,
    personality: null,
    tags: null,
  });
  assert.equal(draft.description, '');
  assert.equal(draft.personality, '');
  assert.deepEqual(draft.tags, []);
  assert.deepEqual(changed, ['角色描述（已清空）', '性格（已清空）', '标签（已清空）']);
  // 已是空值的字段重复发 null 不再重复报告变更
  const again = mergeDraft(draft, { description: null, tags: null });
  assert.deepEqual(again.changed, []);
});

test('模型回全量空串 schema 不得清空已有字段', () => {
  const base = {
    ...createForgeDraft(),
    description: '用户辛苦写的长描述',
    personality: '旧性格',
    tags: ['治愈', '日常'],
  };
  const patch = parseCardPatch(JSON.stringify({
    name: '晚星',
    description: '',
    personality: '   ',
    scenario: '',
    tags: [],
  }));
  assert.ok(patch);
  const { draft, changed } = mergeDraft(base, patch);
  assert.equal(draft.description, '用户辛苦写的长描述');
  assert.equal(draft.personality, '旧性格');
  assert.deepEqual(draft.tags, ['治愈', '日常']);
  assert.deepEqual(changed, ['角色名']);
});

test('对话记录有上限，不会无限增长', () => {
  let state = createForgeState(1000);
  for (let index = 0; index < 260; index += 1) {
    state = appendTranscript(state, { role: 'note', text: `第${index}条` }, 2000 + index);
  }
  assert.equal(state.transcript.length, 200);
  assert.equal(state.transcript[199].text, '第259条');
});

test('角色 → 草稿 → 角色 往返保留内容', () => {
  const character = {
    id: 'card-abc',
    name: '晚星',
    description: '描述内容',
    personality: '温柔',
    scenario: '校园',
    firstMes: '你好',
    mesExample: '{{user}}：在吗\n晚星：在的',
    creatorNotes: '备注',
    postHistoryInstructions: '保持人设',
    tags: ['治愈', '日常'],
    systemPrompt: 'x',
    worldInfo: [{ id: 'w1' }],
    regexScripts: [{ id: 'r1' }],
  };
  const draft = draftFromCharacter(character);
  assert.equal(draft.name, '晚星');
  assert.equal(draft.description, '描述内容');
  assert.deepEqual(draft.tags, ['治愈', '日常']);

  const patch = draftToCharacterPatch(draft, { composedPrompt: '[角色描述]\n描述内容', now: 1 });
  assert.equal(patch.name, '晚星');
  assert.equal(draft.mesExample, '{{user}}：在吗\n晚星：在的');
  assert.equal(patch.systemPromptComposed, '[角色描述]\n描述内容');
  assert.deepEqual(patch.tags, ['治愈', '日常']);  // 世界书/正则现在会原样带走，避免"用制卡改一遍角色就把内容丢了"
  assert.deepEqual(patch.worldInfo, [{ id: 'w1' }]);
  assert.deepEqual(patch.regexScripts, [{ id: 'r1' }]);
  assert.ok(patch.id.startsWith('forge-'));
});

test('大角色卡载入制卡后保留长文本和完整集合', () => {
  const character = {
    name: '大卡',
    description: '描'.repeat(5000),
    systemPrompt: '系'.repeat(13000),
    alternateGreetings: Array.from({ length: 25 }, (_, index) => `开场${index}`),
    worldInfo: Array.from({ length: 120 }, (_, index) => ({ id: `w${index}` })),
    regexScripts: Array.from({ length: 120 }, (_, index) => ({ id: `r${index}` })),
    presets: Array.from({ length: 60 }, (_, index) => ({
      id: `p${index}`,
      name: `预设${index}`,
      prompt: `提示${index}`,
    })),
  };
  const draft = draftFromCharacter(character);
  const patch = draftToCharacterPatch(draft, { composedPrompt: '组合提示' });
  assert.equal(draft.description.length, 5000);
  assert.equal(draft.systemPrompt.length, 13000);
  assert.equal(draft.alternateGreetings.length, 25);
  assert.equal(draft.worldInfo.length, 120);
  assert.equal(draft.regexScripts.length, 120);
  assert.equal(draft.presets.length, 60);
  assert.equal(patch.description.length, 5000);
  assert.equal(patch.systemPrompt.length, 13000);
  assert.equal(patch.alternateGreetings.length, 25);
  assert.equal(patch.worldInfo.length, 120);
  assert.equal(patch.regexScripts.length, 120);
  assert.equal(patch.presets.length, 60);
});

test('草稿为空时给角色名兜底，且 hasCardContent 为假', () => {
  const patch = draftToCharacterPatch({});
  assert.equal(patch.name, '新角色');
  assert.equal(patch.firstMes, '');
  assert.equal(hasCardContent({}), false);
  assert.equal(hasCardContent({ name: '晚星' }), true);
});

test('制卡往返保留 AI 标识、语音形态与扩展字段', () => {
  const character = {
    name: 'AI 卡',
    voiceDisplay: 'voice',
    aigcMeta: { producer: 'EasyChat2', source: 'easychat2-card-forge', contentCode: 'AIGC-X' },
    cardExtensions: { talkativeness: 0.8 },
    cardExtra: { creator: '某作者' },
    alternateGreetings: ['备用 1'],
  };
  const draft = draftFromCharacter(character);
  assert.equal(draft.voiceDisplay, 'voice');
  assert.equal(draft.aigcMeta.contentCode, 'AIGC-X');
  assert.deepEqual(draft.cardExtensions, { talkativeness: 0.8 });
  assert.deepEqual(draft.cardExtra, { creator: '某作者' });
  const patch = draftToCharacterPatch(draft, { composedPrompt: '组合' });
  assert.equal(patch.voiceDisplay, 'voice');
  assert.equal(patch.aigcMeta.contentCode, 'AIGC-X');
  assert.deepEqual(patch.cardExtensions, { talkativeness: 0.8 });
  assert.deepEqual(patch.cardExtra, { creator: '某作者' });
});

test('hasCardContent 认备用开场白：只有备用开场白不算空', () => {
  assert.equal(hasCardContent({ alternateGreetings: ['只有这条'] }), true);
  assert.equal(hasCardContent({ alternateGreetings: [''] }), false);
});

test('提示词包含问答结果与硬性输出要求', () => {
  let state = createForgeState(1000);
  state = recordAnswer(state, 'name', '晚星', 2000);
  const generate = buildGeneratePrompt(state);
  assert.ok(generate.includes('晚星'));
  assert.ok(generate.includes('只输出一个 JSON 对象'));

  const edit = buildEditPrompt({
    draft: { name: '晚星' },
    request: '把性格改得更冷淡',
    answers: summarizeAnswers(state),
  });
  assert.ok(edit.includes('把性格改得更冷淡'));
  assert.ok(edit.includes('"name":"晚星"'));
});

test('往返保留系统提示、备用开场白、世界书与正则', () => {
  const character = {
    name: '晚星',
    systemPrompt: '保持冷淡的说话方式',
    alternateGreetings: ['换一个开场', '  '],
    worldInfo: [{ id: 'w1', keys: ['月'] }],
    regexScripts: [{ id: 'r1', pattern: 'x' }],
  };
  const draft = draftFromCharacter(character);
  assert.equal(draft.systemPrompt, '保持冷淡的说话方式');
  assert.deepEqual(draft.alternateGreetings, ['换一个开场']);
  assert.equal(draft.worldInfo.length, 1);
  assert.equal(draft.regexScripts.length, 1);

  const patch = draftToCharacterPatch(draft, { composedPrompt: '[系统提示]\n保持冷淡的说话方式' });
  assert.equal(patch.systemPrompt, '保持冷淡的说话方式');
  assert.equal(patch.systemPromptComposed, '[系统提示]\n保持冷淡的说话方式');
  assert.deepEqual(patch.alternateGreetings, ['换一个开场']);
  assert.deepEqual(patch.worldInfo, [{ id: 'w1', keys: ['月'] }]);
  assert.deepEqual(patch.regexScripts, [{ id: 'r1', pattern: 'x' }]);
});

test('AI 改写不会碰系统提示这类保留字段', () => {
  const base = { ...createForgeDraft(), systemPrompt: '原文', worldInfo: [{ id: 'w1' }] };
  const { draft } = mergeDraft(base, {
    systemPrompt: '模型想改掉的',
    worldInfo: [],
    personality: '温柔',
  });
  assert.equal(draft.systemPrompt, '原文');
  assert.deepEqual(draft.worldInfo, [{ id: 'w1' }]);
  assert.equal(draft.personality, '温柔');
});

test('提示词只带可改写字段，不泄露保留字段', () => {
  const base = {
    ...createForgeDraft(),
    name: '晚星',
    personality: '温柔',
    tags: ['治愈', ''],
    systemPrompt: '秘不外传的系统提示',
    alternateGreetings: ['备用开场白A'],
    worldInfo: [{ id: 'w1', keys: ['月'], content: '世界书正文' }],
    regexScripts: [{ id: 'r1', pattern: '机密正则' }],
  };
  const projected = projectForgeDraft(base);
  assert.equal(projected.name, '晚星');
  assert.deepEqual(projected.tags, ['治愈']);
  assert.equal('systemPrompt' in projected, false);
  assert.equal('alternateGreetings' in projected, false);
  assert.equal('worldInfo' in projected, false);
  assert.equal('regexScripts' in projected, false);

  const generate = buildGeneratePrompt({ ...createForgeState(1), draft: base });
  const edit = buildEditPrompt({ draft: base, request: '把性格改得更冷淡' });
  for (const prompt of [generate, edit]) {
    assert.equal(prompt.includes('秘不外传的系统提示'), false);
    assert.equal(prompt.includes('备用开场白A'), false);
    assert.equal(prompt.includes('世界书正文'), false);
    assert.equal(prompt.includes('机密正则'), false);
  }
});

test('超过 10 个标签导入制卡草稿后 AI 往返不截断', () => {
  const manyTags = Array.from({ length: 20 }, (_, index) => `标签${index + 1}`);
  const draft = draftFromCharacter({ name: '多标签角色', tags: manyTags });
  assert.equal(draft.tags.length, 20);

  // AI 只改名字、未提及 tags 时，标签必须原样保留
  const { draft: merged } = mergeDraft(draft, { name: '新名字' });
  assert.equal(merged.name, '新名字');
  assert.deepEqual(merged.tags, manyTags);

  // 提示词投影同样不截断（上限统一为 100）
  const projected = projectForgeDraft(draft);
  assert.equal(projected.tags.length, 20);

  // 模型原样回传标签也不截断
  const patch = parseCardPatch(JSON.stringify({ name: '新名字', tags: manyTags }));
  assert.equal(patch.tags.length, 20);
});

test('高级内容选项决定要生成的世界书 / 正则 / 预设', () => {
  const build = answer => {
    let state = createForgeState(1);
    state = { ...state, answers: { ...state.answers, advanced: answer } };
    return requestedAdvancedSections(state);
  };
  assert.deepEqual(build(''), []);
  assert.deepEqual(build('暂时不要'), []);
  assert.deepEqual(build('生成世界书'), ['world']);
  assert.deepEqual(build('生成正则脚本'), ['regex']);
  assert.deepEqual(build('生成文本预设'), ['presets']);
  assert.deepEqual(build('全部生成'), ['world', 'regex', 'presets']);
});

test('要求生成时提示词包含对应高级字段的 schema', () => {
  let state = createForgeState(1);
  state = { ...state, answers: { ...state.answers, advanced: '生成世界书' } };
  const worldPrompt = buildGeneratePrompt(state);
  assert.ok(worldPrompt.includes('worldInfo'));
  assert.equal(worldPrompt.includes('regexScripts'), false);
  assert.equal(worldPrompt.includes('presets'), false);
  // 世界书要拆成「总览 + 具体条目」，不能只给一条笼统描述
  assert.ok(worldPrompt.includes('总览'));
  assert.ok(worldPrompt.includes('具体'));

  state = { ...state, answers: { ...state.answers, advanced: '全部生成' } };
  const allPrompt = buildGeneratePrompt(state);
  assert.ok(allPrompt.includes('worldInfo'));
  assert.ok(allPrompt.includes('regexScripts'));
  assert.ok(allPrompt.includes('presets'));
});

test('世界书条目辅助生成提示要求具体内容而非笼统概括', () => {
  const prompt = buildEntryAssistPrompt({
    kind: 'worldInfo',
    currentEntry: { comment: '等级', keys: ['魅魔'], content: '魅魔有等级' },
    request: '写详细一点',
  });
  assert.ok(prompt.includes('具体'));
  assert.ok(prompt.includes('等级'));
  assert.equal(prompt.includes('一句话笼统概括'), true);
});

test('模型返回的世界书 / 正则 / 预设被清洗成完整结构', () => {
  const patch = parseCardPatch(JSON.stringify({
    name: '晚星',
    worldInfo: [{ keys: '月亮, 夜晚', content: '月亮的设定', position: 'at_depth', depth: 3 }],
    regexScripts: [{ name: '隐藏心声', findRegex: '<心声>(.*?)</心声>', replaceString: '$1', placement: ['ai'] }],
    presets: [{ name: '语气', prompt: '保持温柔', enabled: false }, { prompt: '' }],
  }));
  assert.equal(patch.worldInfo.length, 1);
  const entry = patch.worldInfo[0];
  assert.deepEqual(entry.keys, ['月亮', '夜晚']);
  assert.equal(entry.content, '月亮的设定');
  assert.equal(entry.position, 4);
  assert.equal(entry.positionLabel, '按深度插入');
  assert.equal(entry.depth, 3);
  assert.equal(entry.enabled, true);

  assert.equal(patch.regexScripts.length, 1);
  assert.deepEqual(patch.regexScripts[0].placement, [2]);
  // 生成侧不再落盘中文文案（选法 a）：placement 是语言无关的数字，文案由渲染侧
  // 按当前语言现算（cardHelpers.js 的 placementText）。落盘文案会随导出/分享传播。
  assert.equal(patch.regexScripts[0].placementLabel, '');

  // 空 prompt 的预设被丢弃
  assert.equal(patch.presets.length, 1);
  assert.equal(patch.presets[0].name, '语气');
  assert.equal(patch.presets[0].enabled, false);
});

test('生成结果合并进草稿；模型未给出时不覆盖已有条目', () => {
  const base = {
    ...createForgeDraft(),
    worldInfo: [{ id: 'old', content: '旧条目' }],
  };
  const generated = mergeDraft(base, {
    name: '晚星',
    worldInfo: [{ keys: ['月'], content: '新条目' }],
  });
  assert.equal(generated.draft.worldInfo.length, 1);
  assert.equal(generated.draft.worldInfo[0].content, '新条目');
  assert.ok(generated.changed.some(item => item.includes('世界书')));

  // 模型没给 worldInfo 时，既有条目原样保留
  const untouched = mergeDraft(base, { name: '晚星' });
  assert.deepEqual(untouched.draft.worldInfo, [{ id: 'old', content: '旧条目' }]);
  // 空数组同样不构成清空
  const empty = mergeDraft(base, { worldInfo: [] });
  assert.deepEqual(empty.draft.worldInfo, [{ id: 'old', content: '旧条目' }]);
});

test('生成的世界书 / 正则 / 预设能进入角色结构', () => {
  let state = createForgeState(1);
  state = { ...state, answers: { ...state.answers, advanced: '全部生成' } };
  const patch = parseCardPatch(JSON.stringify({
    name: '晚星',
    worldInfo: [{ keys: ['月'], content: '月亮的设定' }],
    regexScripts: [{ name: '净化', findRegex: 'x', replaceString: 'y' }],
    presets: [{ name: '语气', prompt: '保持温柔' }],
  }));
  const { draft } = mergeDraft(state.draft, patch);
  const character = draftToCharacterPatch(draft, { composedPrompt: '组合提示' });
  assert.equal(character.worldInfo.length, 1);
  assert.equal(character.regexScripts.length, 1);
  assert.equal(character.presets.length, 1);
  assert.equal(character.name, '晚星');
});

test('辅助生成提示词包含当前值与要求，输出协议为纯文本', () => {
  const prompt = buildFieldAssistPrompt({
    fieldLabel: '角色名',
    currentValue: '晚星',
    request: '改成更古风一点的名字',
  });
  assert.ok(prompt.includes('当前「角色名」内容'));
  assert.ok(prompt.includes('晚星'));
  assert.ok(prompt.includes('用户要求：改成更古风一点的名字'));
  // 输出协议：不是 JSON，只要纯文本
  assert.ok(prompt.includes('不要任何解释、前后缀或代码块标记，不要输出 JSON'));
  assert.ok(FIELD_ASSIST_SYSTEM.includes('只输出改写后的字段内容本身'));
});

test('辅助生成回复解析：剥代码块围栏、限长、空文本为 null', () => {
  assert.equal(parseFieldAssistText('  \n'), null);
  assert.equal(parseFieldAssistText(''), null);
  assert.equal(parseFieldAssistText('直接的新内容'), '直接的新内容');
  assert.equal(parseFieldAssistText('```\n围栏里的新内容\n```'), '围栏里的新内容');
  assert.equal(parseFieldAssistText('```json\n{"name":"x"}\n```'), '{"name":"x"}');
  const long = 'x'.repeat(600000);
  assert.equal(parseFieldAssistText(long).length, 500000);
});

test('制卡编辑器支持世界书/正则/预设的增删改', () => {
  // 三个集合都有编辑区与添加入口（i18n 键引用 + 语言包中文值）
  [['forge.world.groupLabel', '世界书条目'], ['forge.regex.groupLabel', '正则脚本'], ['forge.preset.groupLabel', '角色预设']].forEach(([key, label]) => {
    assert.ok(FORGE_EDITOR_SOURCE.includes(`label={t('${key}')}`), key);
    assert.equal(zhCN[key], label, '语言包中文值正确');
  });
  assert.ok(FORGE_EDITOR_SOURCE.includes("addWorldEntry"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("addRegexScript"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("addPreset"));
  // 删除与编辑单条（keys/内容/启用开关）
  assert.ok(FORGE_EDITOR_SOURCE.includes("removeEntry('worldInfo', index)"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("removeEntry('regexScripts', index)"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("removeEntry('presets', index)"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("t('forge.world.keysPlaceholder')"), '应引用触发关键词占位符的 i18n 键');
  assert.equal(zhCN['forge.world.keysPlaceholder'], '触发关键词（逗号分隔）', '语言包中文值正确');
  assert.ok(FORGE_EDITOR_SOURCE.includes("t('forge.world.contentPlaceholder')"), '应引用注入内容占位符的 i18n 键');
  assert.equal(zhCN['forge.world.contentPlaceholder'], '命中后注入的内容', '语言包中文值正确');
  assert.ok(FORGE_EDITOR_SOURCE.includes("t('forge.preset.contentPlaceholder')"), '应引用预设内容占位符的 i18n 键');
  assert.equal(zhCN['forge.preset.contentPlaceholder'], '预设内容（注入提示词）', '语言包中文值正确');
});

test('制卡编辑器每个字段提供辅助生成', () => {
  // 字段旁的辅助生成按钮 + 描述弹窗 + 生成动作
  assert.ok(FORGE_EDITOR_SOURCE.includes("t('forge.assist.button')"), '应引用辅助生成按钮的 i18n 键');
  assert.equal(zhCN['forge.assist.button'], '辅助生成', '语言包中文值正确');
  assert.ok(FORGE_EDITOR_SOURCE.includes('openAssist'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('submitAssist'));
  assert.ok(FORGE_EDITOR_SOURCE.includes("t('forge.assist.placeholder')"), '应引用描述输入占位符的 i18n 键');
  assert.ok(zhCN['forge.assist.placeholder'].includes('描述想修改的地方'), '语言包中文值正确');
  assert.ok(FORGE_EDITOR_SOURCE.includes("title={t('forge.generate')}"), '应引用生成按钮的 i18n 键');
  assert.equal(zhCN['forge.generate'], '生成', '语言包中文值正确');
  // 生成走 Screen 提供的发送通道（含 API 配置指纹保护），结果写回对应字段
  assert.ok(FORGE_EDITOR_SOURCE.includes('onAssistPrompt(prompt, controller.signal)'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('[appliedKey]: text'));
  assert.ok(FORGE_SCREEN_SOURCE.includes('sendAssistPrompt'));
  assert.ok(FORGE_SCREEN_SOURCE.includes('FIELD_ASSIST_SYSTEM'));
  assert.ok(FORGE_SCREEN_SOURCE.includes('onAssistPrompt={sendAssistPrompt}'));
});

test('标签/世界书/正则/预设都能辅助生成', () => {
  // 标签：文本协议 → 顿号拆分
  assert.ok(FORGE_EDITOR_SOURCE.includes("openAssist({ kind: 'tags', label: t('forge.tags.label') })"), '标签辅助生成应引用 i18n 标签键');
  assert.equal(zhCN['forge.tags.label'], '标签', '语言包中文值正确');
  assert.ok(FORGE_EDITOR_SOURCE.includes('buildTagsAssistPrompt'));
  assert.ok(FORGE_EDITOR_SOURCE.includes("setTagText(list.join('、'))"));
  // 三个集合条目：JSON 协议 + 白名单合并，每类都有按钮
  assert.ok(FORGE_EDITOR_SOURCE.includes("kind: 'entry', listKey: 'worldInfo'"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("kind: 'entry', listKey: 'regexScripts'"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("kind: 'entry', listKey: 'presets'"));
  assert.ok(FORGE_EDITOR_SOURCE.includes('buildEntryAssistPrompt'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('parseEntryAssistPatch'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('mergeEntryAssistPatch'));
});

test('正则条目的辅助生成有「AI 能力有限、不建议用正则」提示', () => {
  assert.ok(FORGE_EDITOR_SOURCE.includes('isRegexAssist'));
  assert.ok(FORGE_EDITOR_SOURCE.includes("assistTarget.listKey === 'regexScripts'"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("t('forge.assist.regexWarning')"), '应引用正则辅助生成警示的 i18n 键');
  assert.ok(zhCN['forge.assist.regexWarning'].includes('不建议依赖 AI 编写正则'), '语言包中文值正确');
  assert.ok(FORGE_EDITOR_SOURCE.includes('assistWarning'));
});

test('集合条目可折叠：默认折叠、点标题展开、新增自动展开', () => {
  assert.ok(FORGE_EDITOR_SOURCE.includes('const [expandedEntries, setExpandedEntries] = useState(() => new Set())'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('toggleEntry'));
  assert.ok(FORGE_EDITOR_SOURCE.includes("expandEntry(`worldInfo:${id}`)"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("expandEntry(`regexScripts:${id}`)"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("expandEntry(`presets:${id}`)"));
  // 折叠时显示摘要行（世界书关键词/正则查找替换/预设内容）
  assert.ok(FORGE_EDITOR_SOURCE.includes('entrySummary'));
  assert.ok(FORGE_EDITOR_SOURCE.includes("t('forge.world.keywords'"), '应引用世界书摘要关键词的 i18n 键');
  assert.ok(zhCN['forge.world.keywords'].includes('关键词：'), '语言包中文值正确');
  assert.ok(FORGE_EDITOR_SOURCE.includes("t('forge.regex.summary'"), '应引用正则摘要查找替换的 i18n 键');
  assert.ok(zhCN['forge.regex.summary'].includes('查找：'), '语言包中文值正确');
});

test('标签与集合条目的辅助生成协议纯函数', () => {
  const tagsPrompt = buildTagsAssistPrompt({ currentTags: ['治愈', '日常'], request: '更偏奇幻' });
  assert.ok(tagsPrompt.includes('当前标签：治愈、日常'));
  assert.ok(tagsPrompt.includes('用户要求：更偏奇幻'));
  assert.ok(tagsPrompt.includes('只输出标签本身，用顿号分隔'));

  const entryPrompt = buildEntryAssistPrompt({
    kind: 'worldInfo',
    currentEntry: { comment: '旧名', keys: ['a'], content: '旧内容', position: 4, depth: 2 },
    request: '改得更神秘',
  });
  assert.ok(entryPrompt.includes('世界书条目'));
  assert.ok(entryPrompt.includes('旧名'));
  // 白名单已放开 constant/position/depth：这些字段要投影进提示词并可被 AI 改写
  assert.ok(entryPrompt.includes('"keys"'));
  assert.ok(entryPrompt.includes('"constant"'));
  assert.ok(entryPrompt.includes('"position"'));
  assert.ok(entryPrompt.includes('"depth"'));
  assert.ok(entryPrompt.includes('只包含这些字段：comment、keys、content、constant、position、depth'));

  // 宽松解析：代码块/前后文字容错
  assert.deepEqual(parseEntryAssistPatch('```json\n{"comment":"新名"}\n```'), { comment: '新名' });
  assert.deepEqual(parseEntryAssistPatch('说明文字 {"name":"新预设","prompt":"内容"} 结尾'), { name: '新预设', prompt: '内容' });
  assert.equal(parseEntryAssistPatch('不是 JSON'), null);
  assert.equal(parseEntryAssistPatch(''), null);

  // 白名单合并：非白名单字段被忽略，空值不覆盖，keys 支持字符串拆分
  const merged = mergeEntryAssistPatch(
    { id: 'w1', comment: '旧', keys: ['a'], content: '旧内容', position: 4, enabled: false },
    'worldInfo',
    { comment: '新', keys: 'b、c', content: '新内容', position: 99, enabled: true, extra: 'x' }
  );
  assert.equal(merged.comment, '新');
  assert.deepEqual(merged.keys, ['b', 'c']);
  assert.equal(merged.content, '新内容');
  assert.equal(merged.position, 4);      // 非白名单保留原值
  assert.equal(merged.enabled, false);   // AI 不参与开关
  assert.equal(merged.id, 'w1');
  assert.equal(merged.extra, undefined);
  // 空串不清空已有字段
  const kept = mergeEntryAssistPatch({ comment: '旧', content: '旧内容' }, 'worldInfo', { comment: '', content: '  ' });
  assert.equal(kept.comment, '旧');
  assert.equal(kept.content, '旧内容');
});

test('预览展示分区过滤空字段并保留顺序', () => {
  const sections = buildPreviewSections({
    name: '晚星',
    description: '  来自北境  ',
    personality: '',
    scenario: '雪山',
    systemPrompt: '   ',
    mesExample: '{{user}}：在吗\n晚星：在的',
  });
  assert.deepEqual(sections.map(item => item.label), ['描述', '场景', '对话示例']);
  assert.equal(sections[0].text, '来自北境');
  assert.equal(buildPreviewSections(null).length, 0);
});

test('预览开场轮次来自开场白，历史上限生效', () => {
  assert.deepEqual(buildPreviewOpeningTurns({ firstMes: '' }), []);
  const opening = buildPreviewOpeningTurns({ firstMes: '你好呀' }, 500);
  assert.equal(opening.length, 1);
  assert.equal(opening[0].role, 'assistant');
  assert.equal(opening[0].text, '你好呀');
  assert.equal(opening[0].id, 'preview-open-500');

  // 只保留最近 N 轮，且过滤非对话角色
  const turns = [];
  for (let i = 0; i < 40; i += 1) turns.push({ id: `t${i}`, role: i % 2 ? 'assistant' : 'user', text: `${i}` });
  turns.push({ id: 'note', role: 'note', text: '忽略' });
  const capped = capPreviewHistory(turns, 5);
  assert.equal(capped.length, 5);
  assert.equal(capped[capped.length - 1].text, '39');
});

test('预览显示高级内容计数', () => {
  assert.deepEqual(previewAdvancedCounts({}), []);
  assert.deepEqual(
    previewAdvancedCounts({ worldInfo: [{}, {}], regexScripts: [{}], presets: [{}, {}, {}] }),
    ['世界书 2', '正则 1', '预设 3']
  );
});

test('制卡编辑器卡片里有预览按钮并接入模拟对话', () => {
  assert.ok(FORGE_EDITOR_SOURCE.includes("previewActionText}>{t('forge.preview.button')}"), '应引用预览按钮的 i18n 键');
  assert.equal(zhCN['forge.preview.button'], '预览', '语言包中文值正确');
  assert.ok(FORGE_EDITOR_SOURCE.includes('<CardPreviewModal'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('onSendTurn={handlePreviewTurn}'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('onSimulateChat'));
  // 用 ref 取当前表单，避免回调里读到旧快照
  assert.ok(FORGE_EDITOR_SOURCE.includes('formRef.current = form'));
});

test('预览弹窗支持多轮模拟对话、清空且不落库', () => {
  assert.ok(PREVIEW_MODAL_SOURCE.includes('buildPreviewOpeningTurns'));
  assert.ok(PREVIEW_MODAL_SOURCE.includes('capPreviewHistory'));
  assert.ok(PREVIEW_MODAL_SOURCE.includes('onSendTurn(history, text, controller.signal)'));
  assert.ok(PREVIEW_MODAL_SOURCE.includes("t('forge.preview.clear')"), '应引用清空模拟对话的 i18n 键');
  assert.ok(zhCN['forge.preview.clear'].includes('清空'), '语言包中文值正确');
  assert.ok(PREVIEW_MODAL_SOURCE.includes("t('forge.preview.chatHint')"), '应引用不落库提示的 i18n 键');
  assert.ok(zhCN['forge.preview.chatHint'].includes('不会写入角色库或聊天记录'), '语言包中文值正确');
  assert.ok(PREVIEW_MODAL_SOURCE.includes('abort'));
});

test('模拟对话经真实聊天管道组装并受配置指纹保护', () => {
  assert.ok(FORGE_SCREEN_SOURCE.includes('buildRequestMessages'));
  assert.ok(FORGE_SCREEN_SOURCE.includes('const character = draftToCharacterPatch(draft, { composedPrompt })'));
  assert.ok(FORGE_SCREEN_SOURCE.includes('onSimulateChat={simulateChat}'));
  assert.ok(FORGE_SCREEN_SOURCE.includes('expectedConfigFingerprint'));
});

test('预览应用展示正则：角色走 AI 输出、用户走用户输入', () => {
  const scripts = [
    { name: '高亮', findRegex: '秘密', replaceString: '<b>$&</b>', flags: 'g', placement: [2], enabled: true },
    { name: '去括号', findRegex: '（[^）]*）', replaceString: '', flags: 'g', placement: [1], enabled: true },
  ];
  // AI 输出：placement 2 生效
  assert.equal(applyPreviewDisplay('这是秘密', scripts, 'assistant'), '这是<b>秘密</b>');
  // 用户输入：placement 1 生效，placement 2 不生效
  assert.equal(applyPreviewDisplay('（小声）你好', scripts, 'user'), '你好');
  assert.equal(applyPreviewDisplay('这是秘密', scripts, 'user'), '这是秘密');
  // 未启用脚本跳过
  assert.equal(
    applyPreviewDisplay('秘密', [{ findRegex: '秘密', replaceString: 'X', placement: [2], enabled: false }], 'assistant'),
    '秘密'
  );
  // 灾难性回溯模式被引擎跳过，不影响整条链路
  assert.equal(
    applyPreviewDisplay('aaaa', [{ findRegex: '(a+)+$', replaceString: 'X', placement: [2], enabled: true }], 'assistant'),
    'aaaa'
  );
});

test('预览轮次批量套用展示正则', () => {
  const draft = {
    regexScripts: [
      { findRegex: '星', replaceString: '★', flags: 'g', placement: [1, 2], enabled: true },
    ],
  };
  const turns = [
    { id: 'a', role: 'assistant', text: '晚星' },
    { id: 'b', role: 'user', text: '星你好' },
  ];
  const rendered = buildPreviewDisplayTurns(turns, draft);
  assert.equal(rendered[0].display, '晚★');
  assert.equal(rendered[1].display, '★你好');
  // 原文保留，便于继续作为对话历史
  assert.equal(rendered[0].text, '晚星');
});

test('预览正则兜底：缺 placement 视为 1/2、enabled 缺省视为开启', () => {
  // 编辑器没有 placement 编辑入口，条目可能缺 placement 数组（AI 辅助合并、旧卡、手改）；
  // applyRegexScripts 遇到非数组会整条跳过，预览里就永远看不到效果。这里必须兜底。
  assert.equal(
    applyPreviewDisplay('这是秘密', [{ findRegex: '秘密', replaceString: '<b>$&</b>', flags: 'g' }], 'assistant'),
    '这是<b>秘密</b>'
  );
  // placement: [] 同样视为默认 1/2
  assert.equal(
    applyPreviewDisplay('秘密', [{ findRegex: '秘密', replaceString: 'X', flags: 'g', placement: [] }], 'assistant'),
    'X'
  );
  // enabled 缺省视为开启
  assert.equal(
    applyPreviewDisplay('秘密', [{ findRegex: '秘密', replaceString: 'X', flags: 'g', placement: [2] }], 'assistant'),
    'X'
  );
});

test('预览弹窗用共享渲染管线呈现正则效果', () => {
  assert.ok(PREVIEW_MODAL_SOURCE.includes('AssistantMessageBody'));
  assert.ok(PREVIEW_MODAL_SOURCE.includes('buildPreviewDisplayTurns'));
});

test('生成与条目辅助提示词给出可用的正则写法约定', () => {
  // 直接构造带「高级内容=全部」的问答结果（requestedAdvancedSections 读 answers.advanced）
  const state = { ...createForgeState(1000), answers: { advanced: '全部' } };
  const prompt = buildGeneratePrompt(state);
  assert.ok(prompt.includes('regexScripts'));
  // 关键约定：不带斜杠/修饰符、$1/$&、转义、markdownOnly/promptOnly、placement
  assert.ok(prompt.includes('不要带首尾斜杠'));
  assert.ok(prompt.includes('$1'));
  assert.ok(prompt.includes('markdownOnly'));
  assert.ok(prompt.includes('promptOnly'));
  assert.ok(prompt.includes('placement'));

  const entryPrompt = buildEntryAssistPrompt({
    kind: 'regexScripts',
    currentEntry: { name: '高亮', findRegex: 'foo', replaceString: 'bar' },
    request: '把重点词高亮',
  });
  assert.ok(entryPrompt.includes('JavaScript 正则的源码'));
  assert.ok(entryPrompt.includes('不要带首尾斜杠'));
  assert.ok(entryPrompt.includes('$1'));
});

test('整卡生成可只出基础字段，高级内容由第二步补写', () => {
  const state = { ...createForgeState(1), answers: { advanced: '全部' } };
  const baseOnly = buildGeneratePrompt(state, { includeAdvanced: false });
  assert.equal(baseOnly.includes('worldInfo'), false);
  assert.equal(baseOnly.includes('regexScripts'), false);
  assert.equal(baseOnly.includes('presets'), false);
  // 默认（不传选项）仍包含高级内容，保持既有调用语义
  assert.ok(buildGeneratePrompt(state).includes('worldInfo'));

  const advanced = buildAdvancedPrompt(state, { draft: { name: '晚星', description: '北境少女' } });
  assert.ok(advanced.includes('已生成的角色卡'));
  assert.ok(advanced.includes('北境少女'));
  assert.ok(advanced.includes('worldInfo'));
  assert.ok(advanced.includes('regexScripts'));
  assert.ok(advanced.includes('presets'));
  assert.ok(advanced.includes('只包含本次要求的这些'));

  const onlyWorld = buildAdvancedPrompt({ ...state, answers: { advanced: '生成世界书' } }, {});
  assert.ok(onlyWorld.includes('worldInfo'));
  assert.equal(onlyWorld.includes('regexScripts'), false);
});

test('世界书提示词教模型输出常驻总览与具体触发条目', () => {
  const state = { ...createForgeState(1), answers: { advanced: '生成世界书' } };
  const prompt = buildGeneratePrompt(state);
  assert.ok(prompt.includes('constant:true'));
  assert.ok(prompt.includes('position:0'));
  assert.ok(prompt.includes('世界观总览'));
  assert.ok(prompt.includes('禁止使用'));
});

test('条目辅助提示注入角色卡背景与正则样本文本', () => {
  const prompt = buildEntryAssistPrompt({
    kind: 'worldInfo',
    currentEntry: { comment: '等级', keys: ['魅魔'], content: '魅魔有等级' },
    request: '写详细一点',
    characterContext: '角色名：莉莉\n角色描述：北境魅魔',
  });
  assert.ok(prompt.includes('角色卡背景（改写时必须与之保持一致）'));
  assert.ok(prompt.includes('北境魅魔'));

  const regexPrompt = buildEntryAssistPrompt({
    kind: 'regexScripts',
    currentEntry: { name: '高亮', findRegex: 'foo', replaceString: 'bar' },
    request: '忽略大小写',
    sampleText: 'Foo foo FOO',
  });
  assert.ok(regexPrompt.includes('需要匹配/处理的样本文本'));
  assert.ok(regexPrompt.includes('Foo foo FOO'));
  assert.ok(regexPrompt.includes('JavaScript 正则的源码'));
});

test('JSON 解析失败的重试提示带原始输出前 500 字', () => {
  const raw = 'x'.repeat(600);
  const prompt = buildJsonRepairPrompt(raw);
  assert.ok(prompt.includes('无法解析'));
  assert.ok(prompt.includes('x'.repeat(500)));
  assert.equal(prompt.includes('x'.repeat(501)), false);
});

test('条目辅助可改世界书的 constant/position/depth', () => {
  const base = { id: 'w1', comment: '旧', keys: ['a'], content: '旧', constant: false, position: 1, depth: 4, enabled: true };
  const merged = mergeEntryAssistPatch(base, 'worldInfo', {
    constant: true,
    position: 4,
    depth: 6,
    keys: ['b'],
  });
  assert.equal(merged.constant, true);
  assert.equal(merged.position, 4);
  assert.equal(merged.depth, 6);
  assert.equal(merged.positionLabel, '按深度插入');
  assert.deepEqual(merged.keys, ['b']);
  // 非法 position 不采纳；非布尔 constant 不采纳
  const rejected = mergeEntryAssistPatch(base, 'worldInfo', { position: 99, constant: 'yes' });
  assert.equal(rejected.position, 1);
  assert.equal(rejected.constant, false);
});

test('条目辅助可改正则 flags/placement/两种 Only，且不再落盘中文 placementLabel', () => {
  const base = {
    id: 'r1',
    name: '高亮',
    findRegex: 'foo',
    replaceString: 'bar',
    flags: 'g',
    placement: [2],
    // 老卡形态：数据里带着中文派生文案。合并后必须清掉，否则英文界面会显示它。
    placementLabel: 'AI 输出',
    markdownOnly: false,
    promptOnly: false,
    enabled: true,
  };
  const merged = mergeEntryAssistPatch(base, 'regexScripts', {
    flags: 'gi',
    placement: [1, 2],
    markdownOnly: true,
    promptOnly: false,
  });
  assert.equal(merged.flags, 'gi');
  assert.deepEqual(merged.placement, [1, 2]);
  // 不落盘文案：placement 已改，旧中文派生值必须清空（否则与 placement 错配）
  assert.equal(merged.placementLabel, '');
  assert.equal(merged.markdownOnly, true);
  // placement 只接受 1/2；全非法时保留原值
  const kept = mergeEntryAssistPatch(base, 'regexScripts', { placement: [3, 9] });
  assert.deepEqual(kept.placement, [2]);
  // ⚠️ 即便 placement 未变，旧中文派生值也要清掉（2026-10-12）：本函数是**保存路径**，
  // 任何一次保存都该把卡片归一成新格式 —— placement 才是权威（语言无关），placementLabel
  // 是渲染侧按当前语言现算的派生物（cardHelpers.placementText）。留着旧值会让它随导出/
  // 分享传播（英文界面显示中文），这正是本次要根除的；老卡兼容在**读取侧**回落，不在保存侧保留。
  assert.equal(kept.placementLabel, '', '保存路径必须清掉中文派生值，兼容由读取侧回落负责');
});

// ================= 问题 A：生成路径必须筛查危险正则 =================
test('危险正则（灾难性回溯）在生成路径被标记，而不是静默入库', () => {
  const patch = parseCardPatch(JSON.stringify({
    name: '晚星',
    regexScripts: [
      { name: '会挂死', findRegex: '(a+)+$', replaceString: 'X' },
      { name: '正常', findRegex: 'foo', replaceString: 'bar' },
    ],
  }));
  // 标记而不是丢弃：丢了用户连改的机会都没有，且条数会无声变少
  assert.equal(patch.regexScripts.length, 2);
  assert.equal(patch.regexScripts[0].unsafe, true);
  assert.equal(patch.regexScripts[1].unsafe, false);
  // 复用引擎那一份启发式：被标记的那条 == regexEngine 会 continue 的那条
  assert.equal(isUnsafeRegexPattern(patch.regexScripts[0].findRegex), true);
  assert.equal(isUnsafeRegexPattern(patch.regexScripts[1].findRegex), false);
  // 有界嵌套量词不该被误伤（与引擎同一口径）
  assert.equal(sanitizeRegexScript({ findRegex: '(a{2,3})+' }, 0).unsafe, false);
  // 编辑器必须在脚本列表里给出可见告警（照 character/editors.js:233 的写法）
  assert.ok(FORGE_EDITOR_SOURCE.includes('isUnsafeRegexPattern'), '编辑器复用同一份判定，不另写');
  assert.ok(FORGE_EDITOR_SOURCE.includes("t('forge.regex.unsafeHint')"), '展开时的详细告警');
  assert.ok(FORGE_EDITOR_SOURCE.includes("t('forge.regex.unsafeBadge')"), '折叠时列表里的可见标记');
  assert.ok(zhCN['forge.regex.unsafeHint'].includes('灾难性回溯'), '语言包中文值正确');
  assert.ok(zhCN['forge.regex.unsafeBadge'].includes('危险正则'), '语言包中文值正确');
});

// ================= 问题 B：markdownOnly / promptOnly 互斥收口 =================
test('markdownOnly / promptOnly 互斥收口：both-true 不再等于「全量生效」', () => {
  // 引擎语义：两个 skip 条件都不成立 → 两边都生效，与 both-false 等价。
  // 辅助生成路径（mergeEntryAssistPatch）必须收口，否则本应只改展示的正则开始改发给模型的内容。
  const merged = mergeEntryAssistPatch(
    { id: 'r1', name: '高亮', findRegex: 'foo', replaceString: 'bar', markdownOnly: false, promptOnly: false },
    'regexScripts',
    { markdownOnly: true, promptOnly: true }
  );
  assert.equal(merged.markdownOnly, true);
  assert.equal(merged.promptOnly, false, 'both-true 必须被收口成一个');
  // 原本就是 promptOnly 的条目：保留用户原有的那一侧，不被模型的 both-true 冲成全量生效
  const keptPrompt = mergeEntryAssistPatch(
    { id: 'r2', findRegex: 'foo', markdownOnly: false, promptOnly: true },
    'regexScripts',
    { markdownOnly: true }
  );
  assert.equal(keptPrompt.promptOnly, true);
  assert.equal(keptPrompt.markdownOnly, false);
  // 生成路径（sanitizeRegexScript）走同一口径
  const generated = parseCardPatch(JSON.stringify({
    regexScripts: [{ name: 'x', findRegex: 'foo', markdownOnly: true, promptOnly: true }],
  })).regexScripts[0];
  assert.equal(generated.markdownOnly, true);
  assert.equal(generated.promptOnly, false);
  // 单一实现：收口函数在 shared.js，两条路径共用
  const collapsed = collapseOnlyFlags({ markdownOnly: true, promptOnly: true }, {});
  assert.deepEqual([collapsed.markdownOnly, collapsed.promptOnly], [true, false]);
});

// ================= 问题 C：depth 的 null / '' 视为缺省 =================
test('世界书 depth：null / 空串视为缺省 4，而不是被存成 0', () => {
  const [nullDepth] = parseCardPatch(JSON.stringify({
    worldInfo: [{ keys: ['月'], content: '月亮的设定', position: 4, depth: null }],
  })).worldInfo;
  assert.equal(nullDepth.position, 4);
  // Number(null) === 0 且过 Number.isFinite：旧实现存 0，chatPipeline 会把条目
  // 注入到最末一条消息旁，而不是提示词承诺的「倒数第 4 条」。
  assert.equal(nullDepth.depth, 4);

  const [blankDepth] = parseCardPatch(JSON.stringify({
    worldInfo: [{ keys: ['月'], content: 'x', depth: '' }],
  })).worldInfo;
  assert.equal(blankDepth.depth, 4);

  const [explicit] = parseCardPatch(JSON.stringify({
    worldInfo: [{ keys: ['月'], content: 'x', depth: 2 }],
  })).worldInfo;
  assert.equal(explicit.depth, 2, '显式给了深度就照用');
  assert.equal(sanitizeWorldEntry({ keys: ['月'], content: 'x', depth: '3' }, 0).depth, 3);

  // 与参考实现同口径：cardParser 的 firstNumber 也把 null / '' 当缺省
  assert.equal(firstNumber([{ depth: null }], ['depth'], 4), 4);
  assert.equal(firstNumber([{ depth: '' }], ['depth'], 4), 4);
  assert.equal(firstNumber([{ depth: 2 }], ['depth'], 4), 2);
});

// ================= 问题 D：字段上限的单一来源 =================
test('同一字段两条写入路径共用一张上限表（生成路径 == 辅助生成路径）', () => {
  const longComment = '标'.repeat(300);
  const [generated] = parseCardPatch(JSON.stringify({
    worldInfo: [{ keys: ['月'], content: 'x', comment: longComment }],
  })).worldInfo;
  assert.equal(generated.comment.length, 120);
  // 辅助生成过去一律按 MAX_PRESERVED_TEXT 截断：能落一条 50 万字的 comment
  const assisted = mergeEntryAssistPatch({ id: 'w1' }, 'worldInfo', { comment: longComment });
  assert.equal(assisted.comment.length, 120, '两条路径必须同一口径');

  const [script] = parseCardPatch(JSON.stringify({
    regexScripts: [{ findRegex: 'x', flags: 'g'.repeat(30) }],
  })).regexScripts;
  assert.equal(script.flags.length, 10);
  const assistedScript = mergeEntryAssistPatch({ id: 'r1' }, 'regexScripts', { flags: 'g'.repeat(30) });
  assert.equal(assistedScript.flags.length, 10);

  const [preset] = parseCardPatch(JSON.stringify({
    presets: [{ prompt: 'x', name: '名'.repeat(300) }],
  })).presets;
  assert.equal(preset.name.length, 120);
  const assistedPreset = mergeEntryAssistPatch({ id: 'p1' }, 'presets', { name: '名'.repeat(300) });
  assert.equal(assistedPreset.name.length, 120);

  // 关键词条数上限同样单一来源
  const manyKeys = Array.from({ length: 80 }, (unused, index) => `键${index}`);
  assert.equal(sanitizeWorldEntry({ keys: manyKeys, content: 'x' }, 0).keys.length, ENTRY_KEYS_MAX_COUNT);
  assert.equal(
    mergeEntryAssistPatch({ id: 'w2' }, 'worldInfo', { keys: manyKeys }).keys.length,
    ENTRY_KEYS_MAX_COUNT
  );

  // 表就是那张表：两个模块都从这里查，不再各写一份
  assert.equal(entryFieldLimit('worldInfo', 'comment'), 120);
  assert.equal(entryFieldLimit('regexScripts', 'flags'), 10);
  assert.equal(entryFieldLimit('presets', 'name'), 120);
  assert.equal(entryFieldLimit('presets', '没登记的字段'), 500000, '未登记字段回退默认值而不是 0');
});

// ================= 问题 G：实质为空的条目统一返回 null =================
test('实质为空的条目 / 脚本被丢弃，不再产生「看着生成了、实际不生效」的静默条目', () => {
  const patch = parseCardPatch(JSON.stringify({
    name: '晚星',
    worldInfo: [
      { comment: '空条目', keys: [], content: '' },
      { keys: ['月'], content: '' },
      { comment: '只有次要关键词', secondaryKeys: ['月'], content: '' },
    ],
    regexScripts: [
      { name: '空脚本', findRegex: '', replaceString: 'x' },
      { name: '正常', findRegex: 'foo' },
    ],
  }));
  assert.equal(patch.worldInfo.length, 2, '空 content + 空 keys 的条目被丢弃');
  assert.equal(patch.regexScripts.length, 1, '空 findRegex 的脚本被丢弃');

  // 三个 sanitizer 口径统一（sanitizePreset 本来就返回 null）
  assert.equal(sanitizePreset({ prompt: '   ' }, 0), null);
  assert.equal(sanitizeWorldEntry({ content: '  ', keys: [] }, 0), null);
  assert.equal(sanitizeRegexScript({ findRegex: '  ' }, 0), null);
  assert.equal(sanitizeRegexScript({ findRegex: 'x' }, 0) === null, false, '非空脚本照常保留');
  // 整组都是空条目 → 不构成清空指令（mergeDraft 只在拿到非空数组时才替换）
  assert.equal(sanitizeAdvancedArray([{ content: '' }], sanitizeWorldEntry), null);
  assert.equal(sanitizeAdvancedArray([], sanitizeWorldEntry), null);
});

// ================= 问题 H：barrel 就是公共 API =================
test('forge.js barrel 收录高级内容 sanitizer 与图片路径规则', () => {
  const barrel = readFileSync(path.join(HERE, '..', 'src', 'cardForge', 'forge.js'), 'utf8');
  assert.ok(barrel.includes("from './forge/advanced.js'"), 'sanitizer 必须从 barrel 可取');
  assert.ok(barrel.includes("from './mediaPaths.js'"), '图片路径规则必须从 barrel 可取');
  assert.ok(barrel.includes('ENTRY_FIELD_LIMITS'), '字段上限表也是公共 API');
  // 从 barrel 拿到的必须真的可用（不是 undefined）
  assert.equal(FORGE_MEDIA_DIRECTORY, 'card-forge');
  assert.equal(AVATAR_DIRECTORY, 'avatars');
  assert.equal(forgeMediaDirectory('file:///doc/'), 'file:///doc/card-forge/');
  assert.equal(avatarDirectory('file:///doc/'), 'file:///doc/avatars/');
  assert.equal(isForgeMediaUri('file:///doc/card-forge/a.jpg', 'file:///doc/'), true);
  assert.equal(forgeImageExtension('image/png', ''), '.png');
  assert.equal(buildForgeImageName({ key: 'bgUri', now: 1, random: () => 0 }), 'bg-1-0.jpg');
  assert.match(buildPromotedAvatarName({ now: 1, random: () => 0 }), /^forge-1-0\.jpg$/);
  assert.equal(isForgePayloadFileName('a.json'), true);
  assert.deepEqual(forgeImageNamesToDelete(['a.jpg', 'b.json']), ['a.jpg']);
  [sanitizeWorldEntry, sanitizeRegexScript, sanitizePreset, sanitizeAdvancedArray, entryFieldLimit, collapseOnlyFlags]
    .forEach(fn => assert.equal(typeof fn, 'function'));
});

// ================= 问题 I：两个提示词构造函数的第二参语义统一 =================
test('buildAdvancedPrompt 与 buildGeneratePrompt 的第二参统一为选项对象', () => {
  const state = { ...createForgeState(1), answers: { advanced: '全部' } };
  // draft 选项生效；sections 由调用方传入（它为了提前 return 已经算过），不再重算
  const advanced = buildAdvancedPrompt(state, {
    draft: { name: '晚星', description: '北境少女' },
    sections: ['world'],
  });
  assert.ok(advanced.includes('北境少女'), 'draft 选项必须生效（旧签名下这个参数是无效的）');
  assert.ok(advanced.includes('worldInfo'));
  assert.equal(advanced.includes('regexScripts'), false, '传入的 sections 直接生效，不重算');

  // 单参调用仍可用：draft 回落 state.draft
  const fallback = buildAdvancedPrompt({ ...state, draft: { name: '回落的卡' } });
  assert.ok(fallback.includes('回落的卡'));

  // 与 buildGeneratePrompt 同一形态：第二参都是选项对象
  assert.ok(buildGeneratePrompt(state, { includeAdvanced: false }).includes('当前草稿'));
  // 调用方（CardForgeScreen 的补写高级内容步骤）也按新语义传参
  assert.ok(
    FORGE_SCREEN_SOURCE.includes('buildAdvancedPrompt(baseState, { draft: baseState && baseState.draft, sections })'),
    '调用方必须把已算好的 sections 传进来'
  );
});

// ================= 问题 J：零引用导出与过度导出 =================
test('mediaPaths：删掉零引用的 FORGE_IMAGE_KEYS，imageKeyLabel 不再过度导出', () => {
  const source = readFileSync(path.join(HERE, '..', 'src', 'cardForge', 'mediaPaths.js'), 'utf8');
  assert.equal(source.includes('FORGE_IMAGE_KEYS'), false, '全仓零引用的常量必须删除');
  assert.equal(/export\s+function\s+imageKeyLabel/.test(source), false, '只被本文件调用，不做公共导出');
  assert.ok(/function\s+imageKeyLabel\s*\(/.test(source), '函数本体保留（buildForgeImageName 还在用）');
});

// ================= placementLabel 不再落盘中文（i18n 修复）=================
//
// 背景：placement 是语言无关的数字，但 3 个生成点过去把**当时语言的中文文案**
// 写进 regexScripts[].placementLabel，随卡片导出/分享传播，英文界面因此显示中文。
// 选法 (a)：生成侧不再产生中文文案，渲染侧（cardHelpers.placementText）按当前
// 语言现算。下面用源码级断言钉住「不再有中文表 / 不再生成中文文案」。
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const FORGE_ADVANCED_SOURCE = readFileSync(
  path.join(HERE, '..', 'src', 'cardForge', 'forge', 'advanced.js'), 'utf8'
);
const FORGE_ASSIST_SOURCE = readFileSync(
  path.join(HERE, '..', 'src', 'cardForge', 'forge', 'assist.js'), 'utf8'
);
const FORGE_SHARED_SOURCE = readFileSync(
  path.join(HERE, '..', 'src', 'cardForge', 'forge', 'shared.js'), 'utf8'
);
const CARD_PARSER_REGEX_SOURCE = readFileSync(
  path.join(HERE, '..', 'src', 'character', 'cardParser', 'regexScripts.js'), 'utf8'
);

test('生成侧不再产生中文 placementLabel（剥注释后无中文文案赋值）', () => {
  // 3 个生成点：regexScripts.js 的 normalizeRegexScript、advanced.js 的
  // sanitizeRegexScript、assist.js 的 mergeEntryAssistPatch。
  // 判据用「placementLabel 的值里出现中文」而不是「出现了 placementLabel 这个键」——
  // 保留字段本身（写 ''）是刻意的：老卡透传与形状稳定都靠它。
  for (const [name, source] of [
    ['cardParser/regexScripts.js', CARD_PARSER_REGEX_SOURCE],
    ['cardForge/forge/advanced.js', FORGE_ADVANCED_SOURCE],
    ['cardForge/forge/assist.js', FORGE_ASSIST_SOURCE],
  ]) {
    const code = stripComments(source);
    const chinese = /placementLabel\s*[:=][^,;\n]*[\u4e00-\u9fff]/.exec(code);
    assert.equal(chinese, null, `${name} 仍在生成中文 placementLabel：${chinese && chinese[0]}`);
  }
  // 反向对照：剥注释的判据确实能抓到旧形态（否则上面是空转）
  assert.ok(
    /placementLabel\s*:[^,;\n]*[\u4e00-\u9fff]/.test("placementLabel: 'AI 输出',"),
    '判据必须能命中旧的中文字面量赋值'
  );
});

test('中文 placement 常量表已收敛为 1 份，forge 侧只留语言无关取值', () => {
  // 此前 regexScripts.js 与 forge/shared.js 各有一份逐字相同的中文表（两个真相源）。
  const chineseTable = /['"]用户输入['"]/;
  assert.ok(chineseTable.test(CARD_PARSER_REGEX_SOURCE), 'cardParser 保留唯一的中文兜底表');
  assert.equal(
    chineseTable.test(stripComments(FORGE_SHARED_SOURCE)),
    false,
    'forge/shared.js 不得再复制中文文案表'
  );
  // forge 侧改为语言无关的合法取值清单 + 校验函数（advanced.js 的清洗查它）
  assert.ok(FORGE_SHARED_SOURCE.includes('export const REGEX_PLACEMENT_KEYS'));
  assert.ok(FORGE_SHARED_SOURCE.includes('export function isValidRegexPlacement'));
  assert.ok(FORGE_ADVANCED_SOURCE.includes('isValidRegexPlacement(item)'));
});

test('渲染侧兜底分支存在：老卡的中文 placementLabel 不会变空白', () => {
  // 行为级断言在 tests/characterHelpers.test.mjs（placementText 可直测）；
  // 这里钉住接线：两个渲染点必须把旧 placementLabel 作为回落传进去。
  const helpers = readFileSync(path.join(HERE, '..', 'src', 'character', 'cardHelpers.js'), 'utf8');
  assert.ok(helpers.includes('strings.legacyLabel'), 'placementText 必须支持旧值回落');
  assert.ok(helpers.includes('character.editor.regex.scope.userInput'), '已知范围走词条 key');
  const detail = readFileSync(path.join(HERE, '..', 'src', 'character', 'CharacterDetailScreen.js'), 'utf8');
  assert.ok(detail.includes('legacyLabel: script.placementLabel'), '详情页渲染必须传旧值兜底');
});
