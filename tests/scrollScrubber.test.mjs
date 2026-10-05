import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { getScrollRange, indexFromRatio } from '../src/chat/scrollScrubberMath.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 2026-10-05 CharacterScreen 拆分为 CharacterStack + character/CharacterLibraryScreen.js
// （列表页，滚动定位/偏移缓存留在这里）与 character/CharacterDetailScreen.js（编辑表单）。
// 断言目标改指列表页，约束不变。
const CHARACTER_SCREEN_SOURCE = readFileSync(
  path.join(HERE, '..', 'src', 'character', 'CharacterLibraryScreen.js'),
  'utf8'
);

test('滑动比例映射到首尾索引', () => {
  assert.equal(indexFromRatio(-1, 5), 0);
  assert.equal(indexFromRatio(0.5, 5), 2);
  assert.equal(indexFromRatio(2, 5), 4);
  assert.equal(indexFromRatio(0.5, 0), 0);
});

test('角色网格滚动范围按顶部和底部对齐', () => {
  assert.deepEqual(getScrollRange({ top: 240, height: 900, viewport: 600 }), {
    start: 240,
    end: 540,
  });
  assert.deepEqual(getScrollRange({ top: 100, height: 200, viewport: 600 }), {
    start: 100,
    end: 0,
  });
});

test('定位滑块改由网格几何推导，不再逐卡缓存 offset', () => {
  // 原实现靠 characterCardRelativeOffsetsRef / characterCardOffsetsRef 逐卡记 y，
  // 再在 grid 布局变化时用 relative 缓存重建绝对偏移（约 48 行补丁）。
  // 卡片等高等距（封面固定 3:4 + 名称单行叠字），所以第 index 个 item 的行号
  // = floor(index / 2)，位置 = gridTop + 行号 × 行高 + 卡片上外边距——逐卡缓存
  // 整个删掉了。这条断言同时钉住「旧补丁不得回归」与「新链路必须在位」。
  assert.equal(CHARACTER_SCREEN_SOURCE.includes('characterCardRelativeOffsetsRef'), false,
    '逐卡相对偏移缓存不得回归');
  assert.equal(CHARACTER_SCREEN_SOURCE.includes('characterCardOffsetsRef'), false,
    '逐卡绝对偏移缓存不得回归');
  assert.equal(CHARACTER_SCREEN_SOURCE.includes('updateCharacterCardOffsets'), false,
    '偏移重建函数不得回归');
  assert.equal(CHARACTER_SCREEN_SOURCE.includes('onCharacterItemLayout'), false,
    '逐卡 onLayout 测量不得回归');
  // 新链路：只测量网格整体（top/height/rows），item 位置由行号线性推出。
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('characterGridGeometryRef'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('CHARACTER_CARD_MARGIN_TOP'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('onCharacterGridLayout'));
});
