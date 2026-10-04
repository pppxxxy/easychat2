import test from 'node:test';
import assert from 'node:assert/strict';

import { GAMES } from '../src/games/games.js';
import GLOBAL_PRESETS, { GLOBAL_PRESETS as NAMED } from '../src/settings/presets.js';
import { isStaleReply } from '../src/chat/chatRace.js';

test('内置游戏表：id 唯一、字段齐全、HTML 可渲染', () => {
  const ids = GAMES.map(game => game.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(GAMES.length >= 5);
  for (const game of GAMES) {
    assert.ok(game.name && game.description, game.id);
    if (game.native) {
      // 原生游戏（如 daily-wife 需读角色库）走 RN 面板，无 HTML。
      assert.ok(!game.html, `${game.id} 原生游戏不应带 html`);
    } else {
      assert.ok(game.html.includes('<!DOCTYPE html>'), game.id);
    }
  }
  // 今日老婆：原生游戏，入口在游戏列表
  const dailyWife = GAMES.find(game => game.id === 'daily-wife');
  assert.ok(dailyWife);
  assert.equal(dailyWife.native, 'daily-wife');
});

test('全局预设：id 唯一、字段齐全、默认导出与具名导出一致', () => {
  assert.equal(GLOBAL_PRESETS, NAMED);
  const ids = GLOBAL_PRESETS.map(preset => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of GLOBAL_PRESETS) {
    assert.ok(preset.name && preset.description && preset.prompt, preset.id);
  }
});

test('isStaleReply：仅当发送角色与当前角色不一致时为过期', () => {
  assert.equal(isStaleReply('a', 'a'), false);
  assert.equal(isStaleReply('a', 'b'), true);
  assert.equal(isStaleReply(null, null), false);
  assert.equal(isStaleReply('a', null), true);
});
