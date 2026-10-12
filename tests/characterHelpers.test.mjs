import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCharacterFormState,
  buildCharacterPatch,
  characterFormSignature,
  characterWithFormState,
  formatImportSize,
  getPickedAsset,
  gridRowIndex,
  hasCardContent,
  isLargeImport,
  isPngBuffer,
  placementText,
  worldEntryMeta,
  CHARACTER_LIST_COLLAPSE_LIMIT,
  LARGE_IMPORT_BYTES,
  MAX_IMPORT_BYTES,
  NO_CARD_DATA_MESSAGE,
} from '../src/character/cardHelpers.js';
// placementText 按**活动语言**取词条（tActive），所以这里用 setActiveLocale 切语言验证。
import { setActiveLocale } from '../src/i18n/index.js';

test('导入体积阈值与格式化', () => {
  assert.equal(LARGE_IMPORT_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_IMPORT_BYTES, 32 * 1024 * 1024);
  assert.equal(CHARACTER_LIST_COLLAPSE_LIMIT, 10);
  assert.ok(NO_CARD_DATA_MESSAGE.includes('角色卡'));
  assert.equal(isLargeImport(LARGE_IMPORT_BYTES + 1), true);
  assert.equal(isLargeImport(LARGE_IMPORT_BYTES), false);
  assert.equal(formatImportSize(0), '');
  assert.equal(formatImportSize(1024), '1 KB');
  assert.equal(formatImportSize(1024 * 1024), '1.0 MB');
});

test('getPickedAsset：兼容新的 assets 数组与旧单 uri', () => {
  assert.equal(getPickedAsset(null), null);
  assert.equal(getPickedAsset({ canceled: true }), null);
  assert.deepEqual(getPickedAsset({ assets: [{ uri: 'a' }] }), { uri: 'a' });
  assert.deepEqual(getPickedAsset({ uri: 'b' }), { uri: 'b' });
});

test('isPngBuffer：识别 PNG 魔数', () => {
  assert.equal(isPngBuffer([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), true);
  assert.equal(isPngBuffer([0x89, 0x50]), false);
  assert.ok(!isPngBuffer(null));
});

test('hasCardContent：有任一内容字段即视为有内容', () => {
  assert.equal(hasCardContent({ name: '甲' }), true);
  assert.equal(hasCardContent({ worldInfo: [1] }), true);
  assert.equal(hasCardContent({ fields: { description: 'x' } }), true);
  assert.equal(hasCardContent({ name: '', fields: {} }), false);
  assert.equal(hasCardContent(null), false);
});

test('buildCharacterPatch：字段缺省填默认并生成唯一 id', () => {
  const patch = buildCharacterPatch({ name: '角色', fields: { firstMes: 'hi' } });
  assert.equal(patch.name, '角色');
  assert.equal(patch.firstMes, 'hi');
  assert.ok(patch.id.startsWith('card-'));
  assert.deepEqual(patch.alternateGreetings, []);
  assert.deepEqual(patch.worldInfo, []);
  const empty = buildCharacterPatch({});
  assert.equal(empty.name, '导入角色');
});

test('buildCharacterFormState / characterFormSignature：稳定序列化', () => {
  const form = buildCharacterFormState({ name: '甲', tags: ['a'] });
  assert.equal(form.name, '甲');
  assert.deepEqual(form.tags, ['a']);
  // worldInfo/regexScripts 经 ensureUniqueIds 补 id
  const form2 = buildCharacterFormState({ worldInfo: [{ keys: ['k'] }] });
  assert.equal(form2.worldInfo[0].id, 'entry-0');
  const form3 = buildCharacterFormState({
    worldInfo: [{}, { id: 'entry-0' }, { id: '' }],
    regexScripts: [{}, { id: 'regex-1' }, { id: 'regex-1' }],
  });
  assert.deepEqual(form3.worldInfo.map(item => item.id), ['entry-0', 'entry-1', 'entry-2']);
  assert.deepEqual(form3.regexScripts.map(item => item.id), ['regex-0', 'regex-1', 'regex-2']);
  assert.equal(characterFormSignature({ name: '甲' }), characterFormSignature({ name: '甲' }));
  assert.notEqual(characterFormSignature({ name: '甲' }), characterFormSignature({ name: '乙' }));
});

test('characterWithFormState：以表单态覆盖并重算 systemPromptComposed', () => {
  const merged = characterWithFormState({ id: 'c1', postHistoryInstructions: 'X' }, {
    name: '乙',
    description: 'desc',
    personality: '',
    scenario: '',
    systemPrompt: '',
  });
  assert.equal(merged.id, 'c1');
  assert.equal(merged.name, '乙');
  assert.equal(typeof merged.systemPromptComposed, 'string');
  assert.ok(merged.systemPromptComposed.includes('desc'));
  assert.ok(merged.systemPromptComposed.includes('X'));
});

test('worldEntryMeta：常驻 / 关键词 / 内容摘要 / 未设置', () => {
  assert.equal(worldEntryMeta({ constant: true }), '常驻');
  assert.equal(worldEntryMeta({ keys: ['a', 'b'] }), '关键词：a、b');
  assert.equal(worldEntryMeta({ content: '  一段内容  ' }), '一段内容');
  assert.equal(worldEntryMeta({}), '未设置关键词');
});

// 界面必须把 strings 传进来：不传就走上面那些中文兜底，英文界面会漏中文。
// 常驻用的是早已写好却零消费的 character.editor.world.constant。
test('worldEntryMeta：传 strings 时三条分支都走词条，不再漏中文兜底', () => {
  const strings = { constant: 'Always on', keywords: 'Keys: {keys}', noKeys: 'No keys' };
  assert.equal(worldEntryMeta({ constant: true }, strings), 'Always on');
  assert.equal(worldEntryMeta({ keys: ['a', 'b'] }, strings), 'Keys: a、b');
  assert.equal(worldEntryMeta({}, strings), 'No keys');
  // 内容摘要本来就是数据本身，与语言无关，传 strings 也不该被替换
  assert.equal(worldEntryMeta({ content: '  body  ' }, strings), 'body');
});

// ---- 正则作用范围文案：修复「英文界面仍显示中文」----
//
// 背景：placement 是语言无关的数字（1/2/3/5/6），但文案此前硬编码在
// cardParser/forge 的中文常量表里、且被写进卡片数据（regexScripts[].placementLabel）。
// 英文界面因此长期显示「用户输入 / AI 输出」。修复后由 placementText 按活动语言取词条。
test('placementText：按活动语言取词条，英文界面不再漏中文', () => {
  try {
    setActiveLocale('en');
    assert.equal(placementText([1]), 'User input');
    assert.equal(placementText([1, 2]), 'User input、AI output');
    assert.equal(placementText([3, 5, 6]), 'Quick command、World info、Reasoning');
    // 认不出的数字逐项走调用方给的兜底模板（不静默丢弃、不显示空白）
    assert.equal(
      placementText([99], { scopeFallback: 'Scope {key}' }),
      'Scope 99'
    );
    // 部分认得出：认得出的给词条，认不出的给兜底
    assert.equal(
      placementText([2, 99], { scopeFallback: 'Scope {key}' }),
      'AI output、Scope 99'
    );

    setActiveLocale('zh-CN');
    assert.equal(placementText([1, 2]), '用户输入、AI 输出');
  } finally {
    // 活动语言是模块级状态，别污染同进程的其它测试
    setActiveLocale('zh-CN');
  }
});

test('placementText：兼容性——旧卡的中文 placementLabel 仍能优雅渲染（不变空白）', () => {
  try {
    setActiveLocale('en');
    // 老卡只有 placementLabel、没有可用的 placement（历史数据/第三方卡）：
    // 必须回落到旧中文文案，而不是空白。
    assert.equal(
      placementText([], { legacyLabel: 'AI 输出' }),
      'AI 输出',
      'placement 缺失时回落到旧 placementLabel'
    );
    // 认不出的 placement 同样回落（老卡可能存了非标准数字）
    assert.equal(
      placementText([42], { legacyLabel: '用户输入、AI 输出' }),
      '用户输入、AI 输出'
    );
    // 有可识别的 placement 时以 placement 为准（新文案随语言），旧值只是兜底
    assert.equal(
      placementText([2], { legacyLabel: '用户输入' }),
      'AI output',
      'placement 可识别时不使用旧值'
    );
    // 旧值也是空 → 走 scopeFallback，不能变成空串
    assert.equal(placementText([], { legacyLabel: '', scopeFallback: 'Scope {key}' }), '');
    assert.equal(placementText([7], { legacyLabel: '   ', scopeFallback: 'Scope {key}' }), 'Scope 7');
  } finally {
    setActiveLocale('zh-CN');
  }
});

test('gridRowIndex：网格定位按行号折算（回归：numColumns 下半部分越界闪退）', () => {
  // 2 列：项序号 0..9 折成行 0..4；越界区（项序号 ≥ 行数）必须落在合法行内
  assert.equal(gridRowIndex(0, 2), 0);
  assert.equal(gridRowIndex(1, 2), 0);
  assert.equal(gridRowIndex(2, 2), 1);
  assert.equal(gridRowIndex(9, 2), 4);
  // 20 项 2 列 → 最多 9 行；原先直接传项序号 11 会命中越界 invariant
  assert.equal(gridRowIndex(11, 2), 5);
  assert.equal(gridRowIndex(19, 2), 9);
  // 单列等价于原值
  assert.equal(gridRowIndex(7, 1), 7);
  // 非法输入安全兜底
  assert.equal(gridRowIndex(-3, 2), 0);
  assert.equal(gridRowIndex(5, 0), 5);
  assert.equal(gridRowIndex(NaN, 2), 0);
});
