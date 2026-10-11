// 系统提示分节（Z 系采纳点 #1）：排序、稳定性标注、缓存断点计算。纯函数直测。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SECTION_CACHE,
  buildSystemChunks,
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

test('planSystemCache：首段即动态时，断点落在后面的 stable 段（不再放弃缓存）', () => {
  // time(dynamic) → base(stable) → format(stable)：旧行为 breakIndex=0 一个断点都不打；
  // 现在取最长 stable 连续段（base+format），断点在末尾。
  const sections = buildSystemSections({ timeText: 'T', baseText: 'A', formatText: 'C' });
  const plan = planSystemCache(sections);
  assert.equal(plan.breakIndex, 3);
  assert.equal(plan.cacheable, true, '有 stable 段就该打缓存断点');
  // 只统计稳定段自身的字符（含带标题段的标题行），不含动态的 time
  const stableOnly = sections
    .filter(section => section.cacheHint === 'stable')
    .reduce((sum, section) => sum + section.chars, 0);
  assert.equal(plan.stableChars, stableOnly);
  assert.ok(plan.stableChars < plan.totalChars, '动态段不计入 stableChars');
});

test('planSystemCache：取**最长** stable 连续段（不是第一段）', () => {
  // base(stable) → worldAfter(dynamic) → characterPresets+globalPresets+format(stable)
  const sections = buildSystemSections({
    baseText: 'A', worldAfterText: 'W', characterPresetText: 'CP', globalPresetText: 'GP', formatText: 'C',
  });
  const plan = planSystemCache(sections);
  assert.equal(plan.breakIndex, 5, '断点落在最长那段（3 段）的末尾，而不是第一段之后');
  assert.equal(plan.cacheable, true);
  const longestRun = sections.slice(2, 5);
  assert.equal(
    plan.stableChars,
    longestRun.reduce((sum, section) => sum + section.chars, 0),
    'stableChars 是这段的字符数（字符口径，不是段数）'
  );
  assert.ok(plan.stableChars > sections[0].chars, '取的是最长那段，不是第一段');
});

// P1 回归（2026-10-11）：**有世界书时断点仍要落在稳定段上**。
//
// 事故形态：worldBefore（世界书注入）是 dynamic 且排在系统提示最前，而旧判据只认
// 「从第 0 段起连续 stable」→ breakIndex === 0 → **一个断点都不打**：base / persona /
// 预设 / format 这些跨轮稳定的段永远进不了缓存前缀。而「有世界书」恰恰是长会话的常态。
test('P1 回归：有世界书（worldBefore 在最前）时断点仍落在稳定段上', () => {
  const sections = buildSystemSections({
    worldBeforeText: 'WB（世界书注入，逐轮可变）',
    baseText: 'BASE',
    personaText: 'PERSONA',
    formatText: 'FMT',
  });
  assert.equal(sections[0].id, 'worldBefore', '前置条件：世界书排在最前');
  const plan = planSystemCache(sections);
  assert.equal(plan.cacheable, true, '有稳定段就必须可缓存');
  assert.equal(plan.endIndex, sections.length, '断点落在最后一个稳定段之后');
  assert.ok(plan.stableChars > 0);
  // 断点处的段必须是 stable（这正是「断点落在稳定段上」的含义）
  const lastStable = sections[plan.endIndex - 1];
  assert.equal(lastStable.cacheHint, 'stable', `断点前一段应为 stable，实际 ${lastStable.id}`);
});

test('buildSystemChunks：连续同稳定性并块；拼起来逐字节等于 composeSystemText', () => {
  const sections = buildSystemSections({
    worldBeforeText: 'WB', baseText: 'BASE', personaText: 'P', worldAfterText: 'WA', formatText: 'FMT',
  });
  const chunks = buildSystemChunks(sections);
  // worldBefore(dyn) / base+persona(stable) / worldAfter(dyn) / format(stable)
  assert.deepEqual(chunks.map(chunk => chunk.stable), [false, true, false, true]);
  assert.equal(chunks[1].text, 'BASE\n\n[用户设定]\nP', '稳定段并成一块');
  assert.equal(
    chunks.map(chunk => chunk.text).join('\n\n'),
    composeSystemText(sections),
    '块间仍是空一行：逐字节等于原组装文本'
  );
  assert.deepEqual(buildSystemChunks([]), []);
  assert.deepEqual(buildSystemChunks(null), []);
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
