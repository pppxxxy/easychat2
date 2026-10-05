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

test('定位滑块走 FlatList scrollToIndex，无任何布局测量补丁', () => {
  // 演进链：逐卡 offset 缓存（48 行补丁）→ 网格几何推导 → FlatList 虚拟化后
  // 直接用官方 scrollToIndex。任何手写布局测量都是结构错位的信号，不得回归。
  assert.equal(CHARACTER_SCREEN_SOURCE.includes('characterCardRelativeOffsetsRef'), false,
    '逐卡相对偏移缓存不得回归');
  assert.equal(CHARACTER_SCREEN_SOURCE.includes('characterCardOffsetsRef'), false,
    '逐卡绝对偏移缓存不得回归');
  assert.equal(CHARACTER_SCREEN_SOURCE.includes('updateCharacterCardOffsets'), false,
    '偏移重建函数不得回归');
  assert.equal(CHARACTER_SCREEN_SOURCE.includes('onCharacterItemLayout'), false,
    '逐卡 onLayout 测量不得回归');
  assert.equal(CHARACTER_SCREEN_SOURCE.includes('characterGridGeometryRef'), false,
    '网格几何推导也不得回归（已被 scrollToIndex 取代）');
  // 新链路：FlatList + scrollToIndex + 失败回退。
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('scrollToIndex'), '定位走 scrollToIndex');
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('onScrollToIndexFailed'), '必须有失败回退');
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('numColumns={2}'), '网格为 2 列 FlatList');
});
