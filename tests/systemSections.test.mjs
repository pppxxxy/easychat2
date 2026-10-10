// 系统提示分节（Z 系采纳点 #1）：排序、稳定性标注、缓存断点计算。纯函数直测。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SECTION_CACHE,
  buildSystemSections,
  composeSystemText,
  planSystemCache,
  splitSystemForCache,
} from '../src/prompt/systemSections.js';

const FULL = {
  worldBeforeText: 'WB',
  locationText: 'LOC',
  scheduleText: 'SCH',
  timeText: 'TIME',
  baseText: 'BASE',
  personaText: 'PERSONA',
  exampleText: 'EXAMPLE',
  worldAfterText: 'WA',
  characterPresetText: 'CP',
  globalPresetText: 'GP',
  summaryText: 'SUM',
  memoryText: 'MEM',
  groupText: 'GRP',
  extraText: 'EXTRA',
  formatText: 'FMT',
};

test('排序与原实现一致：worldBefore 最前、format 最后', () => {
  const ids = buildSystemSections(FULL).map(s => s.id);
  assert.deepEqual(ids, [
    'worldBefore', 'location', 'schedule', 'time', 'base', 'persona', 'example',
    'worldAfter', 'characterPresets', 'globalPresets', 'summary', 'memory',
    'group', 'extra', 'format',
  ]);
});

test('空段被丢弃；带标题的段自动加标题行', () => {
  const sections = buildSystemSections({ baseText: 'BASE', personaText: 'P', formatText: 'FMT' });
  assert.deepEqual(sections.map(s => s.id), ['base', 'persona', 'format']);
  assert.equal(sections.find(s => s.id === 'persona').content, '[用户设定]\nP');
  assert.equal(sections.find(s => s.id === 'format').content, '[输出格式]\nFMT');
  // 无标题的段原样保留
  assert.equal(sections.find(s => s.id === 'base').content, 'BASE');
});

test('稳定性标注：base/persona/example/预设/format 为 stable，其余 dynamic', () => {
  for (const id of ['base', 'persona', 'example', 'characterPresets', 'globalPresets', 'format']) {
    assert.equal(SECTION_CACHE[id], 'stable', `${id} 应为 stable`);
  }
  for (const id of ['worldBefore', 'location', 'schedule', 'time', 'worldAfter', 'summary', 'memory', 'group', 'extra']) {
    assert.equal(SECTION_CACHE[id], 'dynamic', `${id} 应为 dynamic`);
  }
});

test('composeSystemText：段间空一行，空列表得空串', () => {
  const sections = buildSystemSections({ baseText: 'A', personaText: 'B' });
  assert.equal(composeSystemText(sections), 'A\n\n[用户设定]\nB');
  assert.equal(composeSystemText([]), '');
});

test('planSystemCache：全稳定时整段可缓存', () => {
  // base + persona + format 都是 stable → 断点落在末尾（整段系统提示可缓存）
  const sections = buildSystemSections({ baseText: 'A', personaText: 'B', formatText: 'C' });
  const plan = planSystemCache(sections);
  assert.equal(plan.breakIndex, 3);
  assert.equal(plan.cacheable, true);
  assert.equal(plan.stableChars, plan.totalChars);
});

test('planSystemCache：首段即动态时无可缓存前缀', () => {
  const sections = buildSystemSections({ timeText: 'T', baseText: 'A', formatText: 'C' });
  const plan = planSystemCache(sections);
  assert.equal(plan.breakIndex, 0);
  assert.equal(plan.cacheable, false);
});

test('planSystemCache：稳定段被动态段截断（只认前缀）', () => {
  // base(stable) → worldAfter(dynamic) → format(stable)：断点停在 base 之后
  const sections = buildSystemSections({ baseText: 'A', worldAfterText: 'W', formatText: 'C' });
  const plan = planSystemCache(sections);
  assert.equal(plan.breakIndex, 1);
  assert.equal(plan.cacheable, true);
});

test('splitSystemForCache：按断点切前缀与其余；断点 0 前缀为空', () => {
  const sections = buildSystemSections({ baseText: 'A', personaText: 'B', formatText: 'C' });
  const split = splitSystemForCache(sections, 2);
  assert.equal(split.prefixText, 'A\n\n[用户设定]\nB');
  assert.equal(split.restText, '[输出格式]\nC');
  const zero = splitSystemForCache(sections, 0);
  assert.equal(zero.prefixText, '');
  assert.equal(zero.restText, composeSystemText(sections));
});
