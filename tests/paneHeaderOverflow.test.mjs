// PaneHeader 溢出守卫（2026-10-06「教学按钮被挤出屏幕」修复）。
// 根因：41ed1fa 给 8 个子屏统一 PaneHeader 后，返回键+标题新增 ~68px 固定
// 占用，而 right 插槽内容（图像生成的「服务商 · 模型名」动态长文本）无收缩
// 约束——RN row 子项默认 flexShrink:0，长内容直接把排在后面的按钮整颗推出
// 屏幕右缘；制卡工坊则是三按钮组把标题挤到归零。
// 本守卫钉住组件层契约：back 永不收缩、title/right 双向可收缩协商、
// right 靠 auto margin 右对齐（替代 flex:1 撑满）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...segments) => readFileSync(path.join(HERE, '..', 'src', ...segments), 'utf8');

const HEADER = read('ui', 'PaneHeader.js');

// 拓展 Stack 全部 10 个子面板（首页是 Tab 根，无返回栏，不在本表）
const PANELS = [
  ['extension/GamesView.js', 'ext.home.games'],
  ['ImageGenScreen.js', 'ext.home.image'],
  ['CardForgeScreen.js', 'forge.screen.title'],
  ['MomentsView.js', 'moments.title'],
  ['screenWatch/ScreenWatchScreen.js', 'screenWatch.title'],
  ['music/MusicScreen.js', 'music.title'],
  ['books/BookScreen.js', 'books.title'],
  ['MapPanel.js', 'map.title'],
  ['ProactivePanel.js', 'proactive.title'],
  ['DiaryPanel.js', 'diary.title'],
];

test('PaneHeader 组件层收缩契约：back 永不缩、title/right 双向协商、auto 右对齐', () => {
  // backButton 显式 flexShrink: 0（返回是逃生通道）
  const backLine = HEADER.slice(HEADER.indexOf('backButton: {'), HEADER.indexOf('backButtonText:'));
  assert.ok(backLine.includes('flexShrink: 0'), '返回键必须显式 flexShrink: 0');
  // title 收缩（不是 flex:1 撑满——撑满在 right 长内容时会把 title 顶到 0 且不参与协商）
  const titleLine = HEADER.slice(HEADER.indexOf('title: {'), HEADER.indexOf('right: {'));
  assert.ok(titleLine.includes('flexShrink: 1'), 'title 必须可收缩');
  assert.ok(!titleLine.includes('flex: 1'), 'title 不得再用 flex:1（basis 0 导致过载时标题归零）');
  // right：auto margin 右对齐 + 可收缩
  const rightLine = HEADER.slice(HEADER.indexOf('right: {'), HEADER.indexOf('});'));
  assert.ok(rightLine.includes("marginLeft: 'auto'"), 'right 靠 auto margin 右对齐');
  assert.ok(rightLine.includes('flexShrink: 1'), 'right 必须可收缩参与协商');
});

test('拓展 Stack 十个子面板全部经 PaneHeader 渲染（含此前未覆盖的主动/日记）', () => {
  for (const [file, titleKey] of PANELS) {
    const source = read(file);
    assert.ok(
      source.includes("from '../ui/PaneHeader.js'") || source.includes("from './ui/PaneHeader.js'"),
      `${file} 未引入 PaneHeader`
    );
    // 边界锚定：裸 '<PaneHeader' 会被 <PaneHeaderX 误命中（substring 陷阱）
    assert.ok(/<PaneHeader[\s>]/.test(source), `${file} 未渲染 PaneHeader`);
    assert.ok(source.includes(titleKey), `${file} 返回栏标题键应为 ${titleKey}`);
  }
});
