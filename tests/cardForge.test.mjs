import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORGE_QUESTIONS,
  appendTranscript,
  buildEditPrompt,
  buildGeneratePrompt,
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
} from '../src/cardForge/forge.js';
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

  state = { ...state, answers: { ...state.answers, advanced: '全部生成' } };
  const allPrompt = buildGeneratePrompt(state);
  assert.ok(allPrompt.includes('worldInfo'));
  assert.ok(allPrompt.includes('regexScripts'));
  assert.ok(allPrompt.includes('presets'));
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
  assert.equal(patch.regexScripts[0].placementLabel, 'AI 输出');

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
  // 三个集合都有编辑区与添加入口
  ['世界书条目', '正则脚本', '角色预设'].forEach(label => {
    assert.ok(FORGE_EDITOR_SOURCE.includes(`label="${label}"`), label);
  });
  assert.ok(FORGE_EDITOR_SOURCE.includes("addWorldEntry"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("addRegexScript"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("addPreset"));
  // 删除与编辑单条（keys/内容/启用开关）
  assert.ok(FORGE_EDITOR_SOURCE.includes("removeEntry('worldInfo', index)"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("removeEntry('regexScripts', index)"));
  assert.ok(FORGE_EDITOR_SOURCE.includes("removeEntry('presets', index)"));
  assert.ok(FORGE_EDITOR_SOURCE.includes('触发关键词（逗号分隔）'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('命中后注入的内容'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('预设内容（注入提示词）'));
});

test('制卡编辑器每个字段提供辅助生成', () => {
  // 字段旁的辅助生成按钮 + 描述弹窗 + 生成动作
  assert.ok(FORGE_EDITOR_SOURCE.includes('辅助生成'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('openAssist'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('submitAssist'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('描述想修改的地方'));
  assert.ok(FORGE_EDITOR_SOURCE.includes("title=\"生成\""));
  // 生成走 Screen 提供的发送通道（含 API 配置指纹保护），结果写回对应字段
  assert.ok(FORGE_EDITOR_SOURCE.includes('onAssistPrompt(prompt, controller.signal)'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('[appliedKey]: text'));
  assert.ok(FORGE_SCREEN_SOURCE.includes('sendAssistPrompt'));
  assert.ok(FORGE_SCREEN_SOURCE.includes('FIELD_ASSIST_SYSTEM'));
  assert.ok(FORGE_SCREEN_SOURCE.includes('onAssistPrompt={sendAssistPrompt}'));
});

test('标签/世界书/正则/预设都能辅助生成', () => {
  // 标签：文本协议 → 顿号拆分
  assert.ok(FORGE_EDITOR_SOURCE.includes("openAssist({ kind: 'tags', label: '标签' })"));
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
  assert.ok(FORGE_EDITOR_SOURCE.includes('不建议依赖 AI 编写正则'));
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
  assert.ok(FORGE_EDITOR_SOURCE.includes('关键词：'));
  assert.ok(FORGE_EDITOR_SOURCE.includes('查找：'));
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
  // 只投影白名单字段：位置/深度不出现在提示词里（保留不改）
  assert.ok(entryPrompt.includes('"keys"'));
  assert.equal(entryPrompt.includes('"position"'), false);
  assert.equal(entryPrompt.includes('"depth"'), false);
  assert.ok(entryPrompt.includes('只包含这些字段：comment、keys、content'));

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
  assert.ok(FORGE_EDITOR_SOURCE.includes('previewActionText}>预览'));
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
  assert.ok(PREVIEW_MODAL_SOURCE.includes('清空模拟对话'));
  assert.ok(PREVIEW_MODAL_SOURCE.includes('不会写入角色库或聊天记录'));
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
