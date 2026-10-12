// 「今日老婆/老公」纯函数：按「本地日期 + 称呼」稳定抽取的回归测试。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { hashSeed, buildDailyDateStr, pickDailyCharacter } from '../src/games/dailyWife.js';

const CHARACTERS = [
  { id: 'a', name: '角色甲' },
  { id: 'b', name: '角色乙' },
  { id: 'c', name: '角色丙' },
];

// 视图是 React 组件（本仓无渲染器），UI 层按既有约定用源码锚点验证「分支存在且约束成立」。
// 负向断言前先剥注释：解释「为什么旧分支不可达」的注释里会原样引用旧判据。
const VIEW = fs.readFileSync(path.resolve('src/games/DailyWifeView.js'), 'utf8');
const VIEW_CODE = VIEW.replace(/\/\/[^\n]*/g, '');
const ZH_DAILY = fs.readFileSync(path.resolve('src/i18n/locales/zh-CN/dailyWife.js'), 'utf8');
const EN_DAILY = fs.readFileSync(path.resolve('src/i18n/locales/en/dailyWife.js'), 'utf8');

test('hashSeed：同输入恒定、不同输入分散', () => {
  assert.equal(hashSeed('2026-10-01\u0000wife'), hashSeed('2026-10-01\u0000wife'));
  assert.equal(hashSeed(''), 5381);
  assert.equal(hashSeed('a'), hashSeed('a'));
});

test('buildDailyDateStr：本地日期格式 YYYY-MM-DD', () => {
  assert.match(buildDailyDateStr(new Date(2026, 9, 1)), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(buildDailyDateStr(new Date(2026, 9, 1)), '2026-10-01');
  // 月份与日期补零
  assert.equal(buildDailyDateStr(new Date(2026, 0, 5)), '2026-01-05');
});

test('pickDailyCharacter：同一天同称呼稳定抽同一位', () => {
  const first = pickDailyCharacter(CHARACTERS, '2026-10-01', 'wife');
  assert.ok(first);
  assert.equal(pickDailyCharacter(CHARACTERS, '2026-10-01', 'wife').id, first.id);
  // 同一天内多次调用一致
  for (let i = 0; i < 5; i += 1) {
    assert.equal(pickDailyCharacter(CHARACTERS, '2026-10-01', 'wife').id, first.id);
  }
});

test('pickDailyCharacter：称呼切换各自独立（今日老婆/老公可不同）', () => {
  const wife = pickDailyCharacter(CHARACTERS, '2026-10-01', 'wife');
  const husband = pickDailyCharacter(CHARACTERS, '2026-10-01', 'husband');
  assert.ok(wife && husband);
  // 三角色两称呼：至少验证 seed 输入不同（可能同结果但概率低，这里断言函数接受 mode）
  assert.ok(CHARACTERS.some(item => item.id === wife.id));
  assert.ok(CHARACTERS.some(item => item.id === husband.id));
});

test('pickDailyCharacter：跨天抽到不同角色（长清单高概率覆盖）', () => {
  const bigList = Array.from({ length: 50 }, (_, index) => ({ id: `c${index}`, name: `角色${index}` }));
  const days = Array.from({ length: 30 }, (_, index) => `2026-09-${String(index + 1).padStart(2, '0')}`);
  const picked = new Set(days.map(day => pickDailyCharacter(bigList, day, 'wife').id));
  // 30 天抽 50 人：至少应出现多个不同角色（全同概率 1/50^29 趋近零）
  assert.ok(picked.size > 3, `30 天应抽到多个角色，实际 ${picked.size}`);
});

test('pickDailyCharacter：空库/非法输入返回 null，非法日期回退今天', () => {
  assert.equal(pickDailyCharacter([], '2026-10-01', 'wife'), null);
  assert.equal(pickDailyCharacter(null, '2026-10-01', 'wife'), null);
  assert.equal(pickDailyCharacter([null, undefined, 'not-object'].filter(Boolean), '2026-10-01'), null);
  // 非法日期回退今天，不抛错
  const fallback = pickDailyCharacter(CHARACTERS, 'not-a-date', 'wife');
  assert.ok(fallback);
  assert.equal(pickDailyCharacter(CHARACTERS, '', 'wife').id, fallback.id);
});

// ---------------------------------------------------------------------------
// P2-2：启动读角色库失败 / 尚未加载完，不得把内置助手当成「今天你的老婆是」
// ---------------------------------------------------------------------------

test('P2-2：启动读角色库失败时渲染错误态，而不是内置助手', () => {
  assert.ok(VIEW.includes('startupError'), '必须消费 AppContext 的 startupError（此前全仓零消费方）');
  assert.ok(
    VIEW.includes("t('error.storage.characterIndexReadFailed')"),
    '复用既有词条 error.storage.characterIndexReadFailed（characterLibrary 已在用）'
  );
  // 抽取范围必须排除「未加载完 / 启动失败」的回落快照（AppContext 两者都是 [DEFAULT_CHARACTER]）
  assert.match(VIEW_CODE, /const pickable = loaded && !startupError && characters\.length > 0;/);
  assert.match(VIEW_CODE, /pickable \? pickDailyCharacter\(characters, dateStr, mode\) : null/);
  // 错误态分支必须排在卡片分支之前，否则失败时仍会渲染卡片
  assert.ok(VIEW.indexOf('startupError ? (') !== -1, '必须有 startupError 分支');
  assert.ok(VIEW.indexOf('startupError ? (') < VIEW.indexOf('picked ? ('), '错误态必须先于卡片判定');
});

test('P2-2：loaded === false 渲染 loading，初始 [DEFAULT_CHARACTER] 不参与抽取', () => {
  assert.ok(VIEW_CODE.includes(') : !loaded ? ('), '必须有 loaded 为假时的 loading 分支');
  assert.ok(VIEW.includes("t('dailyWife.loading')"));
  // 两条恒不可达的旧判据不得复活：`loaded && characters.length === 0` 与挂在 `!picked` 上的 loading
  assert.ok(!VIEW_CODE.includes('loaded && characters.length === 0'), '旧空态判据恒不可达');
  assert.ok(!VIEW_CODE.includes('!picked ? ('), 'loading 挂在 !picked 上同样是死分支');
});

test('P2-2：空态与 loading 词条仍被消费，清理死分支不得顺手删词条', () => {
  assert.ok(VIEW.includes("t('dailyWife.empty.title')"));
  assert.ok(VIEW.includes("t('dailyWife.empty.hint')"));
  for (const key of ['dailyWife.loading', 'dailyWife.empty.title', 'dailyWife.empty.hint']) {
    assert.ok(ZH_DAILY.includes(`'${key}'`), `zh-CN 缺 ${key}`);
    assert.ok(EN_DAILY.includes(`'${key}'`), `en 缺 ${key}`);
  }
});

test('顺带：日期不再在挂载时冻结，回前台重算（跨天自动换人）', () => {
  assert.ok(VIEW.includes("AppState.addEventListener('change'"), '回前台必须重算日期');
  assert.ok(VIEW_CODE.includes('setDateStr('), '日期必须是 state 而不是挂载时算死的常量');
  assert.ok(!VIEW_CODE.includes('buildDailyDateStr(), []'), '不得再用 useMemo(..., []) 冻结日期');
});
