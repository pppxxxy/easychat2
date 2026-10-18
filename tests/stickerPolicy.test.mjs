import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STICKER_CHANCE,
  STICKER_POSITIONS,
  chanceToWording,
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

// —— 2026-10-18 语义变更 ——
// shouldSendStickers 不再掷骰子。原因见 stickerPolicy.js：模型已经写出 [[表情包:x]]
// 时，app 侧再用硬币丢掉它，会让指令被静默吞掉（正文已剥离、表情包不生成、无提示），
// 用户看到的就是「从来没见过表情包」且无从归因。概率改由提示词控制。
test('shouldSendStickers：只看开关与清单，不再掷骰子（chance/random 均不影响结果）', () => {
  // 关闭 / 无表情包 → 不发
  assert.equal(shouldSendStickers({ enabled: false, hasStickers: true, chance: 1, random: 0 }), false);
  assert.equal(shouldSendStickers({ enabled: true, hasStickers: false, chance: 1, random: 0 }), false);
  assert.equal(shouldSendStickers({}), false, '缺省两项都视为关');
  assert.equal(shouldSendStickers(), false, '无参数也不抛');

  // 开启且有表情包 → 恒发，与 chance / random 完全无关（这是新语义的核心）
  for (const chance of [0, 0.5, 1, undefined]) {
    for (const random of [0, 0.5, 0.999]) {
      assert.equal(
        shouldSendStickers({ enabled: true, hasStickers: true, chance, random }),
        true,
        `chance=${chance}, random=${random} 时仍应放行（app 侧不再二次否决）`
      );
    }
  }
});

test('shouldSendStickers 返回严格布尔（不漏 undefined/truthy）', () => {
  assert.equal(typeof shouldSendStickers({ enabled: true, hasStickers: true }), 'boolean');
  assert.equal(shouldSendStickers({ enabled: 1, hasStickers: 'yes' }), true, '真值归一为 true');
  assert.equal(shouldSendStickers({ enabled: 1, hasStickers: '' }), false, '空清单为否');
});

// —— 概率档位 → 提示词措辞（替代旧的概率门）——

test('chanceToWording：档位边界说对，且 0 与 1 是明确的极端', () => {
  // 0 → 明确「不要用」（这个档位下教学根本不注入，此处是单独调用时的兜底措辞）
  assert.match(chanceToWording(0), /不要.*表情包/);
  // 1 → 「每条都可以」，不能仍写成「偶尔」（旧模板写死「偶尔」会反向压制 100% 档）
  assert.match(chanceToWording(1), /每条/);
  assert.equal(/偶尔/.test(chanceToWording(1)), false, '100% 档不该出现「偶尔」');
  // 50% → 「大约一半」
  assert.match(chanceToWording(0.5), /一半/);
  // 低档 → 「偶尔」
  assert.match(chanceToWording(0.1), /偶尔/);
  // 非法值走 normalize 的默认（0.5）
  assert.match(chanceToWording(undefined), /一半/);
  assert.match(chanceToWording('abc'), /一半/);
});

test('chanceToWording：四档措辞互不相同（防止改动时两档说成一样）', () => {
  const wordings = [0, 0.1, 0.5, 1].map(chanceToWording);
  assert.equal(new Set(wordings).size, 4, `四档应产出四段不同措辞，实际：${JSON.stringify(wordings)}`);
});
