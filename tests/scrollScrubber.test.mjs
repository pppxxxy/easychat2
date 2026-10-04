import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { getScrollRange, indexFromRatio } from '../src/chat/scrollScrubberMath.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHARACTER_SCREEN_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'CharacterScreen.js'), 'utf8');

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

test('展开列表不清空卡片偏移缓存', () => {
  // 清空缓存后指望 onLayout 回填是错的：布局未变的卡片（折叠态就存在的
  // 前 10 张）不触发 onLayout，导致定位滑块上半段指向它们时静默不滚动。
  // 位置变化的卡片由 onLayout 自然覆盖，保留旧值是安全的。
  assert.equal(CHARACTER_SCREEN_SOURCE.includes('characterCardOffsetsRef.current = {};'), false);
  // 回填与重建链路必须保留：条目 onLayout 记录偏移、grid 布局变化重建全部
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('characterCardRelativeOffsetsRef.current[id] = offset;'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('characterCardOffsetsRef.current[id] = characterGridLayoutRef.current.top + offset;'));
  assert.ok(CHARACTER_SCREEN_SOURCE.includes('updateCharacterCardOffsets'));
});
