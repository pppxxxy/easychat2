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

// ---------------------------------------------------------------------------
// 游戏 HTML 内联脚本的健壮性。这些是独立 WebView 文档（内联脚本拿不到模块作用域，
// 无法从外面直测），故照本文件既有手法做**源码级**断言；脚本里的中文是 WebView
// 界面文案，不经 RN 的 t()，不按 i18n 规则报。
// ---------------------------------------------------------------------------

const HTML_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'games', 'html');
const readGameHtml = name => readFileSync(path.join(HTML_DIR, name), 'utf8');
// 剥行注释：说明「为什么不能这么写」的注释本身会命中字面量断言（照 vectorMemory.test.mjs 的先例）。
const stripLineComments = source => source.replace(/\/\/[^\n]*/g, '');

test('贪吃蛇：食物落点必须是有界重试，棋盘填满不得死循环', () => {
  const source = readGameHtml('SNAKE_HTML.js');
  const start = source.indexOf('function placeFood()');
  assert.ok(start > 0, '未找到 placeFood');
  const body = source.slice(start, source.indexOf('function start()', start));
  // 原始缺陷：无界 do/while。tick 吃到食物只 unshift 不 pop ⇒ 蛇长单调 +1，长到
  // COUNT*COUNT = 20*20 = 400 格全占满时随机候选集为空 ⇒ 循环永不退出 ⇒ WebView 冻结。
  assert.ok(!/\bdo\s*\{/.test(body), 'placeFood 不得再用无界 do/while 重试');
  // 有界重试：照同目录 SNAKE_BATTLE_HTML.js 的 safeSpawn（for(t<30) + 兜底返回）。
  assert.ok(/for\s*\(\s*var t = 0; t < \d+; t\+\+\)/.test(body), 'placeFood 必须有显式重试上限');
  assert.ok(/food = null/.test(body), '棋盘填满（候选集为空）时必须判定不放食物');
  // 填满后 food 为 null，tick 与 draw 都必须判空，否则读 food.x 直接抛错。
  assert.ok(source.includes('if (food && head.x === food.x'), 'tick 必须判空 food');
  assert.ok(source.includes('if (food) ctx.fillRect'), 'draw 必须判空 food');
});

test('战机：一颗子弹只结算一个目标（内层碰撞循环命中即 break）', () => {
  const source = readGameHtml('THUNDER_HTML.js');
  const start = source.indexOf('bullets.forEach(b => {');
  const end = source.indexOf('bullets = bullets.filter(b => !b.hit);', start);
  assert.ok(start > 0 && end > start, '未找到子弹碰撞段');
  const block = source.slice(start, end);
  // forEach 无法 break ⇒ 同一颗子弹会对本帧重叠到的每个目标各扣一次血、各加一次分。
  assert.ok(!/\.forEach\(e => \{/.test(block), '内层不得用无法 break 的 forEach');
  assert.ok(
    /for \(const e of \[\.\.\.enemies, \.\.\.bosses\]\)/.test(block),
    '内层应改成 for 循环（先例：SNAKE_BATTLE_HTML.js 命中即 break）'
  );
  assert.ok(block.includes('break;'), '命中后必须 break');
  // 同帧内被前一颗子弹打死的目标仍留在数组（`enemies = enemies.filter(e => e.hp > 0)`
  // 在本段之后才执行）⇒ 内层循环必须先跳过已死目标，否则后续子弹会再结算一次伤害与分数。
  assert.ok(
    /if \(e\.hp <= 0\) continue;/.test(block),
    '内层循环必须在结算前跳过已死目标（一次命中只许结算一次）'
  );
});

test('打砖块：球拍目标不得再用假值兜底（画布最左缘的 0 是合法坐标）', () => {
  const code = stripLineComments(readGameHtml('BREAKOUT_HTML.js'));
  assert.ok(!/touchX\s*\|\|/.test(code), 'touchX 为 0（clientX === rect.left）时不得被当成假值');
  assert.ok(
    code.includes('Number.isFinite(touchX) ? touchX : W / 2'),
    '应改成显式的有限性判定，与同文件的显式夹取一致'
  );
});

test('游戏 HTML：只写不读/不可达的死代码不得再出现', () => {
  const breakout = readGameHtml('BREAKOUT_HTML.js');
  const snakeBattle = readGameHtml('SNAKE_BATTLE_HTML.js');
  // 关卡过场计时：三处赋值（过关、startGame、advanceLevel）之后全文件零读取，
  // 过场实际靠玩家点击 advanceLevel 推进。
  assert.ok(!breakout.includes('levelTransitionTimer'), '关卡过场计时变量只写不读');
  // 暂停态常量：从未被赋值给 gameState（无暂停入口）。
  assert.ok(!/\bPAUSED\b/.test(breakout), '暂停态常量从未被赋值给 gameState');
  // damageBrick 的 else 分支：hp = maxHp = 1，且钢砖在 createBrick 开头被强制转普通砖，
  // respawnBrick 也只还原成 maxHp ⇒ hp-- 后必然 <= 0，else 恒不可达。
  const damageStart = breakout.indexOf('function damageBrick(brick)');
  assert.ok(damageStart > 0, '未找到 damageBrick');
  const damageBody = stripLineComments(
    breakout.slice(damageStart, breakout.indexOf('function destroyBrick(brick)', damageStart))
  );
  assert.ok(!damageBody.includes('else'), 'damageBrick 的不可达 else 分支应已删除');
  assert.ok(!damageBody.includes('#cccccc'), '不可达分支里的受损特效应一并删除');
  // 音效静音标志：从未被置 true，也没有任何静音入口。
  assert.ok(!snakeBattle.includes('muted'), '音效静音标志从未被置 true');
  assert.ok(snakeBattle.includes('if(!audioCtx) return;'), '删除后只按音频上下文判断');
  // 键盘加速位：声明后全文件零读写（加速实际走 input.boost）。
  assert.ok(!snakeBattle.includes('keyBoost'), '键盘加速位声明后零读写');
});
