import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STICKER_CHANCE,
  STICKER_POSITIONS,
  normalizeStickerChance,
  normalizeStickerPosition,
  shouldSendStickers,
} from '../src/chat/stickerPolicy.js';

test('normalizeStickerChance：缺失/非法回落默认，越界夹取到 [0,1]', () => {
  assert.equal(normalizeStickerChance(undefined), DEFAULT_STICKER_CHANCE);
  assert.equal(normalizeStickerChance('abc'), DEFAULT_STICKER_CHANCE);
  assert.equal(normalizeStickerChance(NaN), DEFAULT_STICKER_CHANCE);
  assert.equal(normalizeStickerChance(-1), 0);
  assert.equal(normalizeStickerChance(0), 0);
  assert.equal(normalizeStickerChance(2), 1);
  assert.equal(normalizeStickerChance(1), 1);
  assert.equal(normalizeStickerChance(0.25), 0.25);
  assert.equal(normalizeStickerChance('0.75'), 0.75);
});

test('normalizeStickerPosition：只认 above/below，其余回落 below', () => {
  assert.equal(normalizeStickerPosition('above'), 'above');
  assert.equal(normalizeStickerPosition('below'), 'below');
  assert.equal(normalizeStickerPosition('sideways'), 'below');
  assert.equal(normalizeStickerPosition(undefined), 'below');
  assert.deepEqual([...STICKER_POSITIONS], ['below', 'above']);
});

test('shouldSendStickers：关闭 / 无表情包 / 未命中 → 不发', () => {
  assert.equal(shouldSendStickers({ enabled: false, hasStickers: true, chance: 1, random: 0 }), false);
  assert.equal(shouldSendStickers({ enabled: true, hasStickers: false, chance: 1, random: 0 }), false);
  assert.equal(shouldSendStickers({ enabled: true, hasStickers: true, chance: 0, random: 0 }), false);
  assert.equal(shouldSendStickers({ enabled: true, hasStickers: true, chance: 0.5, random: 0.5 }), false);
  assert.equal(shouldSendStickers({ enabled: true, hasStickers: true, chance: 0.5, random: 0.9 }), false);
});

test('shouldSendStickers：命中 → 发；chance=1 恒真、chance=0 恒假', () => {
  assert.equal(shouldSendStickers({ enabled: true, hasStickers: true, chance: 0.5, random: 0.1 }), true);
  assert.equal(shouldSendStickers({ enabled: true, hasStickers: true, chance: 1, random: 0.999999 }), true);
  assert.equal(shouldSendStickers({ enabled: true, hasStickers: true, chance: 0, random: 0 }), false);
});

test('shouldSendStickers：random 缺省时使用 Math.random（返回布尔、不抛错）', () => {
  assert.equal(typeof shouldSendStickers({ enabled: true, hasStickers: true, chance: 1 }), 'boolean');
});
