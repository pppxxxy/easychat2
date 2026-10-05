// 设置搜索索引的纯函数回归：过滤行为 + 索引覆盖所有设置分组。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SETTINGS_SEARCH_INDEX,
  SETTINGS_SECTION_LABELS,
  searchSettings,
  settingsSectionLabel,
} from '../src/settings/searchIndex.js';

test('空查询返回空数组', () => {
  assert.deepEqual(searchSettings(''), []);
  assert.deepEqual(searchSettings('   '), []);
  assert.deepEqual(searchSettings(null), []);
  assert.deepEqual(searchSettings(undefined), []);
});

test('按中文关键词命中并归属正确分组', () => {
  const streaming = searchSettings('流式');
  assert.ok(streaming.some(item => item.sectionId === 'experience' && item.label.includes('流式')));
  const temp = searchSettings('温度');
  assert.ok(temp.some(item => item.sectionId === 'sampling'));
  const backup = searchSettings('备份');
  assert.ok(backup.some(item => item.sectionId === 'about'));
  const vector = searchSettings('向量');
  assert.ok(vector.every(item => item.sectionId === 'vector' || item.sectionId === 'extensions'));
});

test('大小写不敏感，支持英文关键词', () => {
  assert.deepEqual(searchSettings('TTS'), searchSettings('tts'));
  assert.ok(searchSettings('tts').some(item => item.sectionId === 'extensions'));
  assert.ok(searchSettings('WebView').length > 0);
  assert.ok(searchSettings('temperature').some(item => item.sectionId === 'sampling'));
});

test('未命中返回空数组', () => {
  assert.deepEqual(searchSettings('这个关键词肯定不存在xyz'), []);
});

test('索引覆盖全部分组，且条目结构合法', () => {
  const sectionIds = new Set(SETTINGS_SEARCH_INDEX.map(item => item.sectionId));
  Object.keys(SETTINGS_SECTION_LABELS).forEach(id => {
    assert.ok(sectionIds.has(id), `分组 ${id} 至少有一条索引`);
  });
  SETTINGS_SEARCH_INDEX.forEach(item => {
    assert.ok(SETTINGS_SECTION_LABELS[item.sectionId], `未知 sectionId: ${item.sectionId}`);
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 0);
    assert.ok(Array.isArray(item.keywords));
  });
});

test('settingsSectionLabel 返回中文分组名，未知 id 返回空串', () => {
  assert.equal(settingsSectionLabel('experience'), '对话体验');
  assert.equal(settingsSectionLabel('nope'), '');
});
