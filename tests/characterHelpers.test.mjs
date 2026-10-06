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
  worldEntryMeta,
  CHARACTER_LIST_COLLAPSE_LIMIT,
  LARGE_IMPORT_BYTES,
  MAX_IMPORT_BYTES,
  NO_CARD_DATA_MESSAGE,
} from '../src/character/cardHelpers.js';

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
