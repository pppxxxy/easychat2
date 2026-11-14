// 桌面外壳结构守卫（S25）：角色详情其余编辑区块的逐控件比对。
//
// 手机侧的编辑器在 character/editors.js（WorldEntryEditor / RegexEntryEditor），
// 字段清单与「何时显示哪个字段」都是有语义的，不是可随意省略的装饰：
//   · world.depth 只在 position=4（按深度插入）时有意义；
//   · world.order 决定同等命中时的注入先后；
//   · world.secondaryKeys 是 SillyTavern 的 secondary_keys；
//   · regex.markdownOnly / promptOnly 决定这条正则在哪些通道生效；
//   · regex.placement 是**数组**（一条正则可同时作用于 AI 输出与用户输入）。
//
// 本轮查出的缺口：
//   1. 桌面正则缺 markdownOnly / promptOnly（正常则被误用到不该生效的通道）；
//   2. 桌面正则的 placement 写成单选，选第二项会把第一项丢掉；
//   3. 桌面世界书缺 order / depth / secondaryKeys（值只能保持默认，用户无法调整）；
//   4. 两个编辑器的标签是硬编码英文（label="enabled" / "position" / "find"…），
//      违反 i18n 纪律，且手机端这些字段都有正式词条。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(DESKTOP, ...parts), 'utf8');
const readRoot = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

const EDIT = read('src', 'character', 'CharacterEditScreen.jsx');
const EDITORS = readRoot('src', 'character', 'editors.js');

// ---------------------------------------------------------------------------
// 区块清单：手机角色详情/编辑页的每一个可编辑块 → 桌面结论
// ---------------------------------------------------------------------------
const CHARACTER_BLOCKS = Object.freeze([
  { id: 'persona', mobile: 'buildPersonaFields', status: 'done' },
  { id: 'avatar-bg', mobile: 'ImagePickerRow ×2', status: 'done' },
  { id: 'greetings', mobile: 'GreetingList', status: 'done' },
  { id: 'tags', mobile: 'TagEditor', status: 'done' },
  { id: 'voice', mobile: 'VoiceSelector', status: 'done' },
  { id: 'world', mobile: 'WorldEntryEditor', status: 'ported' },
  { id: 'regex', mobile: 'RegexEntryEditor', status: 'ported' },
  { id: 'presets', mobile: 'characterPresets', status: 'done' },
  { id: 'overrides', mobile: 'CharacterOverridesSection', status: 'done' },
]);

test('角色详情的每个编辑块都有明确归属，且桌面有对应实现', () => {
  for (const block of CHARACTER_BLOCKS) {
    if (block.id === 'overrides') {
      // 专属配置在独立卡片里。
      assert.ok(read('src', 'character', 'CharacterOverrideCard.jsx').includes('CharacterOverridesSection'.slice(0, 0) || 'getCharacterOverridesStatus'),
        '专属配置卡片未接共享存储');
      continue;
    }
    const marker = {
      persona: 'character.fields.name.label',
      'avatar-bg': 'character.fields.image.pick',
      greetings: 'character.fields.greetings.add',
      tags: 'TagsEditor',
      voice: 'character.fields.voice.label',
      world: 'WorldEntryEditor',
      regex: 'RegexEditor',
      presets: 'character.detail.presets.character',
    }[block.id];
    assert.ok(EDIT.includes(marker), `${block.id} 在桌面缺失（找不到 ${marker}）`);
  }
});

test('世界书：字段与手机逐项对应（含 order/depth/secondaryKeys）', () => {
  // 手机端的字段（同一文件的标记）作为权威清单。
  for (const marker of ['character.editor.world.keysLabel', 'character.editor.world.contentLabel',
    'character.editor.world.constant', 'character.editor.world.position',
    'character.editor.world.role', 'character.editor.order', 'character.editor.depth']) {
    assert.ok(EDITORS.includes(marker), `手机端应仍有 ${marker}（基准漂移，请复核）`);
    assert.ok(EDIT.includes(marker), `桌面世界书缺 ${marker}`);
  }
  // 次要关键词（SillyTavern secondary_keys）：桌面必须有写回。
  assert.ok(/entry\.secondaryKeys/.test(EDIT), '缺 secondaryKeys 字段');
  // depth 只在 position===4 时显示（与手机同一可见性判据）。
  assert.ok(/position === 4/.test(EDIT), 'depth 的显示条件应与手机一致');
  // 危险关键词提示（空/通配/纯符号会让条目永不或总是触发）。
  assert.ok(EDIT.includes('getUnsafeWorldEntryKeys'), '缺危险关键词判据');
  assert.ok(EDIT.includes('character.editor.world.unsafeKeys'), '缺危险关键词提示');
});

test('世界书：positionLabel 不得写死文案（否则导出后是旧语言）', () => {
  // 手机注释明确：只改 position，清空 positionLabel，渲染侧按当前语言现算。
  assert.ok(/positionLabel: ''/.test(EDIT), '改 position 时应清空 positionLabel');
  assert.ok(!/positionLabel: WORLD_POSITION_LABELS\[/.test(EDIT),
    '不得把当前语言文案写进 positionLabel');
});

test('正则：markdownOnly / promptOnly 两个通道开关都要在', () => {
  for (const marker of ['character.editor.regex.markdownOnly', 'character.editor.regex.promptOnly']) {
    assert.ok(EDITORS.includes(marker), `手机端应仍有 ${marker}`);
    assert.ok(EDIT.includes(marker), `桌面正则缺 ${marker}`);
  }
  assert.ok(/script\.markdownOnly/.test(EDIT), '未写回 markdownOnly');
  assert.ok(/script\.promptOnly/.test(EDIT), '未写回 promptOnly');
});

test('正则：placement 是数组（多选），不是单选', () => {
  // 手机端 togglePlacement 做的是增删集合；桌面若写成 [Number(value)] 会丢掉已选项。
  assert.ok(/Array\.isArray\(script\.placement\)/.test(EDIT), 'placement 应按数组处理');
  assert.ok(/togglePlacement/.test(EDIT), '缺多选切换');
  assert.ok(!/patch\(\{ placement: \[Number\(value\)\] \}\)/.test(EDIT),
    '不得用单选覆盖 placement');
  // 改 placement 必须清 placementLabel（同一「不写死语言」纪律）。
  assert.ok(/placementLabel: ''/.test(EDIT), '改 placement 时应清空 placementLabel');
});

test('正则：不安全表达式在输入时就提示（灾难性回溯会卡死渲染）', () => {
  assert.ok(EDIT.includes('isUnsafeRegexPattern'), '缺不安全正则判据');
  assert.ok(EDIT.includes('character.editor.regex.unsafeHint'), '缺不安全提示');
});

test('两个编辑器的标签走 i18n，不得硬编码英文', () => {
  // 旧实现是 label="enabled" / "position" / "role" / "find" / "replace" / "flags" / "placement"。
  // 例外：`flags` 在手机端也是裸文本（`<Text>flags</Text>`）——它是正则的通用术语，
  // 两端都没有对应词条。要求桌面凭空造一条词条会让两端文案漂移，所以不列入。
  for (const hardcoded of ['label="enabled"', 'label="constant"', 'label="position"',
    'label="role"', 'label="find"', 'label="replace"', 'label="placement"']) {
    assert.ok(!EDIT.includes(hardcoded), `仍有硬编码标签 ${hardcoded}`);
  }
  // 关键标签确实用了词条。
  for (const key of ['character.editor.enabled', 'character.editor.delete',
    'character.editor.regex.findLabel', 'character.editor.regex.scopeLabel']) {
    assert.ok(EDIT.includes(key), `缺词条 ${key}`);
  }
});

test('语音形态与预设：三选 chip 与预设块都在（呈现可不同，语义须一致）', () => {
  for (const key of ['character.fields.voice.text', 'character.fields.voice.voiceText',
    'character.fields.voice.voice']) {
    assert.ok(EDIT.includes(key), `语音形态缺 ${key}`);
  }
  assert.ok(EDIT.includes('makeCharacterPresetId'), '预设未复用共享 id 生成');
  assert.ok(EDIT.includes('character.detail.presets.hint'), '预设块缺说明');
});