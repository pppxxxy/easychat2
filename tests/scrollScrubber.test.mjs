import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { getScrollRange, indexFromRatio } from '../src/chat/scrollScrubberMath.js';
import { localeSource } from './helpers/localeSource.mjs';

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
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('numColumns={CHARACTER_GRID_COLUMNS}'), '网格为 2 列 FlatList');
  // 回归：numColumns>1 时 scrollToIndex 的 index 是行号而非项序号，套用前必须折算，
  // 否则滑到下半部分会命中 VirtualizedList 越界 invariant 闪退。
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('gridRowIndex('), 'scrollToIndex 前应折算行号');
});

// ---- 书籍目录的竖向定位条（ChapterScrubber）----
//
// 它头注释自述「形态抄聊天页的 ScrollScrubber」，但只抄了形态没抄无障碍：声明了
// accessibilityRole="adjustable" 却没有 accessibilityActions/onAccessibilityAction。
// TalkBack/VoiceOver 会把该节点**当滑块播报**（含 min/max/now），读屏用户却既拖不动
// 也增减不了——角色承诺了能力却没实现，目录对读屏用户等于不可用。
// 对照：chat/ScrollScrubber.js:100-104（处理器）+ :179-183（声明），WorkspaceScreen 亦然。
const CHAPTER_SCRUBBER_SOURCE = readFileSync(
  path.join(HERE, '..', 'src', 'books', 'ChapterScrubber.js'),
  'utf8'
);

// 注释里会引用旧写法说明「为什么改」，先剥注释再断言（与 bookNoticeLinks.test.mjs 同机制）。
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('ChapterScrubber 声明 adjustable 就必须提供增减动作（不得只承诺不实现）', () => {
  const code = stripComments(CHAPTER_SCRUBBER_SOURCE);
  assert.ok(code.includes('accessibilityRole="adjustable"'), '前提：角色是滑块');
  assert.ok(
    code.includes('accessibilityActions={['),
    'adjustable 必须配 accessibilityActions（对照 chat/ScrollScrubber.js:179-183）',
  );
  assert.ok(
    /name:\s*'increment'/.test(code) && /name:\s*'decrement'/.test(code),
    'increment/decrement 两个动作名缺一不可',
  );
  assert.ok(
    code.includes('onAccessibilityAction={onAccessibilityAction}'),
    '光声明动作不够，必须挂 onAccessibilityAction 处理器',
  );
  // 处理器必须真的落到既有的 applyY + onSeek（拖动与读屏走同一条跳章链路）。
  const handler = code.slice(code.indexOf('const onAccessibilityAction'), code.indexOf('const panResponder'));
  assert.ok(handler.includes('applyY('), '动作处理器必须复用 applyY 摆滑块');
  assert.ok(handler.includes('onSeekRef.current'), '动作处理器必须触发跳章');
  // 只报 min/max/now 时读屏只会念数字，补 text 才听得出「第几章 / 共几章」。
  assert.ok(
    /accessibilityValue=\{\{[^}]*text:\s*`\$\{index \+ 1\} \/ \$\{count\}`/.test(code),
    'accessibilityValue 必须带 text（对照 chat/ScrollScrubber.js:173-178）',
  );
});

test('ChapterScrubber 的动作文案中英齐备', () => {
  for (const locale of ['zh-CN', 'en']) {
    const table = localeSource(`src/i18n/locales/${locale}`);
    for (const key of ['books.reader.chapter.next', 'books.reader.chapter.prev']) {
      assert.ok(table.includes(`'${key}'`), `${locale} 缺少文案键 ${key}`);
    }
  }
});
