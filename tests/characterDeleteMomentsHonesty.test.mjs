// 「仅删角色」文案的**诚实性**回归测试（2026-10-12）。
//
// 缺陷：确认框的「仅删角色 / Character only」暗示动态会被保留，实际
// src/storage/moments.js:285 注册的 onCharacterDeleted 钩子在**每次**删角色时按 characterId
// 清动态，且钩子拿不到「用户选了什么」（src/storage/characterState.js:59-60 跑钩子时不带意图位）
// ⇒ 用户明确选「仅删角色」，动态仍被静默删除，无任何提示；文案承诺与行为不一致。
//
// 为什么修文案（选 (b)）而不是修行为（选 (a)）：让钩子知道用户意图，需要改
// onCharacterDeleted 的签名或 runCharacterCleanup 的载荷，而注册方共 9 个
// （affinity / characterEditDraft / characterRuntimeOverrides / worldMap / agentTasks /
// characterSchedule / security / diary / moments），远超「注册方 ≤3 个才改签名」的门槛；
// 且 moments 侧那一行在 src/storage/moments.js——本批次所有权之外（另一批次刚改过）。
// 因此最小且合格的交付是让文案如实说明行为。
//
// 断言直接读词条源文件（沿用 tests/cardShareFlow.test.mjs 对文案的既有断言手法：
// 那批同样是「文案必须如实」的诚实性检查）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(path.join(HERE, '..', rel), 'utf8');

const ONLY_CHARACTER = 'character.library.delete.onlyCharacter';
const WITH_LINKED = 'character.library.delete.withLinked';

// 取出某个词条的**值字面量**（含引号与尾逗号，便于和旧文案精确比对）。
// 词条文件是纯对象字面量、一行一个 key，所以按行找 key 即可。
function localeValue(source, key) {
  const marker = `'${key}':`;
  const line = source.split('\n').find(item => item.trimStart().startsWith(marker));
  assert.ok(line, `词条缺失：${key}`);
  return line.slice(line.indexOf(marker) + marker.length).trim();
}

test('「仅删角色」按钮如实说明动态会一并删除（中英都要点明）', () => {
  const zh = localeValue(read('src/i18n/locales/zh-CN/character.js'), ONLY_CHARACTER);
  const en = localeValue(read('src/i18n/locales/en/character.js'), ONLY_CHARACTER);
  assert.ok(zh.includes('动态'), `中文「仅删角色」必须点明动态会删，实际：${zh}`);
  assert.ok(/moments/i.test(en), `英文 "Character only" 必须点明 moments 会删，实际：${en}`);
});

test('关联数据确认框如实说明「仅删角色」也会删除动态', () => {
  const zh = localeValue(read('src/i18n/locales/zh-CN/character.js'), WITH_LINKED);
  const en = localeValue(read('src/i18n/locales/en/character.js'), WITH_LINKED);
  assert.ok(zh.includes('动态'), `中文确认框必须点明动态，实际：${zh}`);
  assert.ok(/moments/i.test(en), `英文确认框必须点明 moments，实际：${en}`);
  // 占位符不能丢：CharacterLibraryScreen.showDeleteChoice 按 {intro}/{details} 传参
  // （少一个占位符会让用户在确认框里看到原始 key 或 undefined）。
  for (const [name, value] of [['zh', zh], ['en', en]]) {
    assert.ok(value.includes('{intro}'), `${name} 必须保留 {intro} 占位符`);
    assert.ok(value.includes('{details}'), `${name} 必须保留 {details} 占位符`);
  }
});

test('回归钉住：不得退回暗示「动态会被保留」的旧文案', () => {
  const zh = localeValue(read('src/i18n/locales/zh-CN/character.js'), ONLY_CHARACTER);
  const en = localeValue(read('src/i18n/locales/en/character.js'), ONLY_CHARACTER);
  assert.notEqual(zh, "'仅删角色',", '纯「仅删角色」会误导用户以为动态能留下——正是本次修的缺陷');
  assert.notEqual(en, "'Character only',", '裸 "Character only" 会误导用户以为 moments 能留下');
});
