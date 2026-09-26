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
  hasCardContent,
  mergeDraft,
  parseCardPatch,
  projectForgeDraft,
  recordAnswer,
  summarizeAnswers,
} from '../src/cardForge/forge.js';

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
