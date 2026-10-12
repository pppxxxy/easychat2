// 设置搜索索引的纯函数回归：过滤行为 + 索引覆盖所有设置分组 + 与设置卡渲染顺序对账。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  SETTINGS_SEARCH_INDEX,
  SETTINGS_SEARCH_SECTION_IDS,
  SETTINGS_SECTION_LABELS,
  searchSettings,
  settingsSectionLabel,
} from '../src/settings/searchIndex.js';
import { SECTION_RENDER_ORDER } from '../src/settings/sectionOrder.js';

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

// 漂移守卫（第一道）：分区顺序的**唯一事实源**是 src/settings/sectionOrder.js 的
// SECTION_RENDER_ORDER，searchIndex.js 直接 import 它（同一个数组对象）。于是对账退化成
// 直接的数组比较，任何一侧想再抄一份都会在这里变红：
//   ① 分区名表与渲染顺序**逐条同序**（少一条 → 搜索结果的分组名是空串；换序 → 索引再抄一份就没人发现）；
//   ② 索引覆盖的分区**恰好等于**渲染顺序（少一个 = 有张卡搜不到；多一个 = 索引指向不存在的卡）。
test('漂移守卫：分区名表与搜索索引都对齐 SECTION_RENDER_ORDER（唯一事实源）', () => {
  const renderOrder = [...SECTION_RENDER_ORDER];
  assert.ok(renderOrder.length > 0, '渲染顺序不能为空');
  assert.equal(new Set(renderOrder).size, renderOrder.length, '渲染顺序里分区 id 不得重复');

  // ① 分区名表必须与渲染顺序逐条同序（这条同时覆盖「多一条」「少一条」「顺序变了」）
  assert.deepEqual(
    Object.keys(SETTINGS_SECTION_LABELS),
    renderOrder,
    'SETTINGS_SECTION_LABELS 的键顺序必须与 SECTION_RENDER_ORDER 完全一致'
  );

  // ② 索引覆盖的分区恰好等于渲染顺序（SETTINGS_SEARCH_SECTION_IDS 由 searchIndex.js 从
  //    同一份 SECTION_RENDER_ORDER 过滤派生，不是另抄的清单）
  assert.deepEqual(
    [...SETTINGS_SEARCH_SECTION_IDS],
    renderOrder,
    '每张设置卡都要有搜索条目，且每条索引都要指向真实的卡'
  );
  assert.ok(Object.isFrozen(SECTION_RENDER_ORDER), '唯一事实源必须冻结，防止被就地改写');
  assert.ok(Object.isFrozen(SETTINGS_SEARCH_SECTION_IDS), '派生清单必须冻结');
});

// 漂移守卫（第二道，结构层）：全仓**只许有一份** SECTION_RENDER_ORDER 的字面量数组定义。
// 光靠上面那条 import 对账还不够——有人完全可以再写一份字面量然后忘了用；
// 这条断言直接扫源码：SettingsScreen.js 必须只是 re-export，searchIndex.js 必须只是 import，
// 字面量定义只能出现在 sectionOrder.js 里。
test('漂移守卫：SECTION_RENDER_ORDER 的字面量定义全仓只有一份（在 sectionOrder.js）', () => {
  // 同时认 `= [` 与 `= Object.freeze([` 两种写法（唯一事实源现在是冻结数组）。
  const DEFINITION_RE = /(?:export\s+)?const\s+SECTION_RENDER_ORDER\s*=\s*(?:Object\.freeze\()?\s*\[/;
  const definitionFiles = [];
  const scan = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (entry.name.endsWith('.js')) {
        if (DEFINITION_RE.test(fs.readFileSync(full, 'utf8'))) {
          definitionFiles.push(path.relative(process.cwd(), full).split(path.sep).join('/'));
        }
      }
    }
  };
  scan(path.resolve('src'));
  assert.deepEqual(
    definitionFiles,
    ['src/settings/sectionOrder.js'],
    'SECTION_RENDER_ORDER 只许在 sectionOrder.js 里定义一次；其他地方只能 import / re-export',
  );

  // SettingsScreen.js 必须 re-export（既有 import 方与 settingsSectionLayout.test.mjs 依赖它）
  const screen = fs.readFileSync(path.resolve('src/SettingsScreen.js'), 'utf8');
  assert.ok(
    /export\s*\{\s*SECTION_RENDER_ORDER\s*\}/.test(screen),
    'SettingsScreen.js 必须 re-export SECTION_RENDER_ORDER（保持既有 import 方兼容）',
  );
  assert.ok(
    /import\s*\{[^}]*SECTION_RENDER_ORDER[^}]*\}\s*from\s*'\.\/settings\/sectionOrder\.js'/.test(screen),
    'SettingsScreen.js 必须从 settings/sectionOrder.js import（而不是自带一份）',
  );
  // searchIndex.js 必须 import 同一份，而不是自己再写一遍
  const index = fs.readFileSync(path.resolve('src/settings/searchIndex.js'), 'utf8');
  assert.ok(
    /import\s*\{\s*SECTION_RENDER_ORDER\s*\}\s*from\s*'\.\/sectionOrder\.js'/.test(index),
    'searchIndex.js 必须从 ./sectionOrder.js import 同一份顺序',
  );
});
