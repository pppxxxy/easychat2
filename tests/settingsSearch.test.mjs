// 设置搜索索引的纯函数回归：过滤行为 + 索引覆盖所有设置分组。
//
// 2026-10-12 起索引里的 label 是 i18n key（labelKey），所以过滤与分区名都要注入 t——
// 测试用真实 translate(zh-CN) 当 t，既覆盖「译名命中」也覆盖「分区名取自卡片键」。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SETTINGS_SEARCH_INDEX,
  SETTINGS_SECTION_LABEL_KEYS,
  searchSettings,
  settingsSectionLabel,
} from '../src/settings/searchIndex.js';
import { translate } from '../src/i18n/index.js';

const t = key => translate('zh-CN', key);
const search = query => searchSettings(query, { t });

test('空查询返回空数组', () => {
  assert.deepEqual(searchSettings(''), []);
  assert.deepEqual(searchSettings('   '), []);
  assert.deepEqual(searchSettings(null), []);
  assert.deepEqual(searchSettings(undefined), []);
});

test('按中文关键词命中并归属正确分组', () => {
  const streaming = search('流式');
  assert.ok(streaming.some(item => item.sectionId === 'experience' && t(item.labelKey).includes('流式')));
  const temp = search('温度');
  assert.ok(temp.some(item => item.sectionId === 'sampling'));
  const backup = search('备份');
  assert.ok(backup.some(item => item.sectionId === 'about'));
  const vector = search('向量');
  assert.ok(vector.every(item => item.sectionId === 'vector' || item.sectionId === 'extensions'));
});

test('大小写不敏感，支持英文关键词', () => {
  assert.deepEqual(search('TTS'), search('tts'));
  assert.ok(search('tts').some(item => item.sectionId === 'extensions'));
  assert.ok(search('WebView').length > 0);
  assert.ok(search('temperature').some(item => item.sectionId === 'sampling'));
});

test('英文界面：英文译名也能命中（labelKey 真的被翻译，不是原始 key）', () => {
  const en = key => translate('en', key);
  const hits = searchSettings('Temperature', { t: en });
  assert.ok(hits.some(item => item.sectionId === 'sampling'), '英文译名应命中采样分区');
  assert.deepEqual(searchSettings('zzz-no-such-setting', { t: en }), []);
});

test('未命中返回空数组', () => {
  assert.deepEqual(search('这个关键词肯定不存在xyz'), []);
});

test('索引覆盖全部分组，且条目结构合法', () => {
  const sectionIds = new Set(SETTINGS_SEARCH_INDEX.map(item => item.sectionId));
  Object.keys(SETTINGS_SECTION_LABEL_KEYS).forEach(id => {
    assert.ok(sectionIds.has(id), `分组 ${id} 至少有一条索引`);
  });
  SETTINGS_SEARCH_INDEX.forEach(item => {
    assert.ok(SETTINGS_SECTION_LABEL_KEYS[item.sectionId], `未知 sectionId: ${item.sectionId}`);
    assert.equal(typeof item.labelKey, 'string', '条目必须用 labelKey（不再硬编码 label）');
    assert.ok(item.labelKey.length > 0);
    assert.equal(item.label, undefined, '不得再留硬编码中文 label');
    assert.ok(Array.isArray(item.keywords));
  });
});

test('每个 labelKey 都能翻出非 key 原文的文案（漏登记词条会让界面显示原始 key）', () => {
  for (const item of SETTINGS_SEARCH_INDEX) {
    assert.notEqual(t(item.labelKey), item.labelKey, `${item.labelKey} 缺 zh-CN 词条`);
    assert.notEqual(translate('en', item.labelKey), item.labelKey, `${item.labelKey} 缺 en 词条`);
  }
  for (const [sectionId, key] of Object.entries(SETTINGS_SECTION_LABEL_KEYS)) {
    assert.notEqual(t(key), key, `${sectionId} 的分区名词条 ${key} 缺失`);
  }
});

test('settingsSectionLabel 返回译名，未知 id 返回空串', () => {
  assert.equal(settingsSectionLabel('experience', t), '对话体验');
  assert.equal(settingsSectionLabel('nope', t), '');
  // 默认 t 是恒等：本模块不持有「当前语言」，语言由调用方给（纯函数可直测）。
  assert.equal(settingsSectionLabel('experience'), 'settings.experience.title');
});
