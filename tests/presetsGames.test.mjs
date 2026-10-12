import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GAMES } from '../src/games/games.js';
import GLOBAL_PRESETS, {
  GLOBAL_PRESETS as NAMED,
  builtinGlobalPresets,
  builtinPresetPrompts,
} from '../src/settings/presets.js';
import { isStaleReply } from '../src/chat/chatRace.js';
import { localeSource } from './helpers/localeSource.mjs';
import { zhCN } from '../src/i18n/locales/zh-CN.js';

test('内置游戏表：id 唯一、字段齐全、HTML 可渲染', () => {
  const ids = GAMES.map(game => game.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(GAMES.length >= 5);
  for (const game of GAMES) {
    assert.ok(game.nameKey && game.descriptionKey, game.id);
    assert.equal(game.name, undefined, `${game.id} 不应把名称硬编码在导出常量里`);
    assert.equal(game.description, undefined, `${game.id} 不应把描述硬编码在导出常量里`);
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

test('游戏清单：两款抽象名是刻意命名（规避版权风险），不得当作占位符改动', () => {
  // 审查侧两轮误报为「占位符」。这是刻意的抽象化命名：用测试钉住名称本身，
  // 并确认 games.js 顶部保留意图说明——「修正」成具体作品名会先让这里变红。
  const snakeBattle = GAMES.find(game => game.id === 'snake-battle');
  const thunder = GAMES.find(game => game.id === 'thunder-fighter');
  assert.equal(zhCN[snakeBattle.nameKey], '蛇蛇蛇蛇蛇蛇蛇蛇');
  assert.equal(zhCN[thunder.nameKey], '战机战机战机战机');
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'games', 'games.js'),
    'utf8'
  );
  assert.ok(source.includes('刻意抽象化的名字'), 'games.js 顶部应保留命名意图说明');
});

test('全局预设：id 唯一、成品字段齐全、默认导出与具名导出一致', () => {
  assert.equal(GLOBAL_PRESETS, NAMED);
  const ids = GLOBAL_PRESETS.map(preset => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const preset of builtinGlobalPresets()) {
    assert.ok(preset.name && preset.description && preset.prompt, preset.id);
  }
});

test('内置预设的文案走 i18n，提示词不进词条表（模型输入不翻译）', () => {
  // 导出常量只带 key：名称/描述是用户可见文案，必须随语言切换。
  for (const def of GLOBAL_PRESETS) {
    assert.ok(def.nameKey && def.descriptionKey, `${def.id} 需要 nameKey/descriptionKey`);
    assert.equal(def.name, undefined, `${def.id} 不应把名称硬编码在导出常量里`);
    assert.equal(def.prompt, undefined, `${def.id} 的提示词不得放进导出常量（会被当成待迁移文案）`);
  }
  // 提示词仍在（只是搬到了未导出的表里），且**不得**出现在任何语言包里。
  const prompts = builtinPresetPrompts();
  assert.equal(Object.keys(prompts).length, GLOBAL_PRESETS.length, '每条预设都要有提示词');
  const zh = localeSource('src/i18n/locales/zh-CN');
  const en = localeSource('src/i18n/locales/en');
  assert.ok(!zh.includes(prompts.immersive), '提示词不得进 zh-CN 词条表');
  assert.ok(!en.includes(prompts.immersive), '提示词不得进 en 词条表');
  assert.ok(!en.includes(prompts.kaomoji.slice(0, 24)), '长提示词同样不得进词条表');
  // 名称/描述则必须在两个语言包里都有（漏译会退回中文 key）。
  const zhPreset = readFileSync(path.resolve('src/i18n/locales/zh-CN/preset.js'), 'utf8');
  const enPreset = readFileSync(path.resolve('src/i18n/locales/en/preset.js'), 'utf8');
  for (const def of GLOBAL_PRESETS) {
    assert.ok(zhPreset.includes(`'${def.nameKey}'`), `zh-CN 缺 ${def.nameKey}`);
    assert.ok(enPreset.includes(`'${def.nameKey}'`), `en 缺 ${def.nameKey}`);
    assert.ok(enPreset.includes(`'${def.descriptionKey}'`), `en 缺 ${def.descriptionKey}`);
  }
});

test('isStaleReply：仅当发送角色与当前角色不一致时为过期', () => {
  assert.equal(isStaleReply('a', 'a'), false);
  assert.equal(isStaleReply('a', 'b'), true);
  assert.equal(isStaleReply(null, null), false);
  assert.equal(isStaleReply('a', null), true);
});
