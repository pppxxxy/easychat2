// FEAT-AC12 P1：文件面板搜索防抖。
//
// 来源：AC12 挂账项。AC12 P0-1 把文件面板改成单层按需加载（depth:1）之后，搜索路径
// 还留着两个**每击键成本**：
//   ① 全量加载在**首个字符**就触发（onChangeText 里第一个非空字符立刻全树 refresh）；
//   ② 每击键同步全量扫描 + 重渲（fileQuery 直接进 useMemo 依赖）。
//
// 本文件测**纯调度器**（注入假时钟，不依赖渲染器）——四条验收判据逐条落成断言。
// 接线那一层（FilesPanel / hook）另有一条源码契约，理由见文末：仓库没有
// react-test-renderer，hook 在 Node 里跑不起来，而「消费点用没用防抖值」这类
// **接线回归**必须被钉住（它是本类缺陷最容易复发的地方）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEBOUNCE_DECISIONS,
  SEARCH_DEBOUNCE_MS,
  createSearchDebouncer,
  shouldLoadFullList,
} from '../src/workspace/fileSearchDebounce.js';

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

// 假时钟：setTimer/clearTimer 可注入，advance 按到期时间顺序触发。
// 这样「连发只消费一次」「超窗口各消费一次」是**真跑**出来的，不是靠 sleep 猜的。
function createFakeClock() {
  let nextId = 1;
  let now = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (let guard = 0; guard < 1000; guard += 1) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
    pendingCount: () => timers.size,
  };
}

function makeHarness() {
  const clock = createFakeClock();
  const commits = [];
  const debouncer = createSearchDebouncer({
    delayMs: SEARCH_DEBOUNCE_MS,
    commit: value => commits.push(value),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, commits, debouncer };
}

// ---------- 判据 1：连发（间隔 < 窗口）只触发一次消费 ----------

test('P1 防抖：连打 buildTree（每击键 80ms < 窗口）只消费一次，且是最后一次的值', () => {
  const { clock, commits, debouncer } = makeHarness();
  let text = '';
  for (const ch of 'buildTree') {
    text += ch;
    const decision = debouncer.push(text);
    assert.equal(decision, DEBOUNCE_DECISIONS.SCHEDULED, '非空输入应排入窗口');
    clock.advance(80); // 人类连续击键间隔普遍 <150ms
  }
  assert.deepEqual(commits, [], '窗口内不该有任何消费（这正是要消灭的每击键成本）');
  assert.equal(clock.pendingCount(), 1, '同一时刻只应有一个挂起的定时器（前一个被取消）');

  clock.advance(SEARCH_DEBOUNCE_MS);
  assert.deepEqual(commits, ['buildTree'], '连打 9 次只消费 1 次，且消费最后的值');
});

// ---------- 判据 2：间隔超过窗口的两次输入各触发一次 ----------

test('P1 防抖：停手超过窗口的两次输入各消费一次（不吞输入）', () => {
  const { clock, commits, debouncer } = makeHarness();
  debouncer.push('a');
  clock.advance(SEARCH_DEBOUNCE_MS + 50);
  assert.deepEqual(commits, ['a'], '第一次窗口结束就该消费');

  debouncer.push('ab');
  clock.advance(SEARCH_DEBOUNCE_MS + 50);
  assert.deepEqual(commits, ['a', 'ab'], '第二次也要各消费一次（防抖不是节流，不能漏）');
});

test('P1 防抖：间隔恰好等于窗口时消费（边界含等于）', () => {
  const { clock, commits, debouncer } = makeHarness();
  debouncer.push('x');
  clock.advance(SEARCH_DEBOUNCE_MS);
  assert.deepEqual(commits, ['x']);
});

// ---------- 判据 3：清零路径立即触发，不等窗口 ----------

test('P1 防抖：清空**立即**生效（零延迟回目录树，不先闪旧结果）', () => {
  const { clock, commits, debouncer } = makeHarness();
  debouncer.push('abc');
  assert.equal(clock.pendingCount(), 1, '前提：非空输入已排入窗口');

  const decision = debouncer.push('');
  assert.equal(decision, DEBOUNCE_DECISIONS.IMMEDIATE, '清空应走立即路径');
  assert.deepEqual(commits, [''], '清空必须立刻消费，不能等窗口');
  assert.equal(clock.pendingCount(), 0, '清空要撤掉挂起的定时器（否则窗口到点又消费一次）');
  // 再推进时间也不该有第二次消费
  clock.advance(SEARCH_DEBOUNCE_MS * 3);
  assert.deepEqual(commits, [''], '撤掉的定时器不得再触发');
});

test('P1 防抖：清空后再输入，窗口照常重新计时', () => {
  const { clock, commits, debouncer } = makeHarness();
  debouncer.push('abc');
  debouncer.push('');
  debouncer.push('z');
  clock.advance(SEARCH_DEBOUNCE_MS);
  assert.deepEqual(commits, ['', 'z'], '清空立即 + 新输入照常防抖');
});

// ---------- 判据 4：计时器可被清理（无悬挂） ----------

test('P1 防抖：cancel 清掉挂起计时器，之后不再消费（卸载不泄漏）', () => {
  const { clock, commits, debouncer } = makeHarness();
  debouncer.push('pending');
  assert.equal(debouncer.hasPendingTimer(), true);
  assert.equal(debouncer.pendingValue(), 'pending');

  assert.equal(debouncer.cancel(), true, 'cancel 应报告确实取消了');
  assert.equal(debouncer.hasPendingTimer(), false, 'cancel 后不该再认为有挂起计时器');
  assert.equal(debouncer.pendingValue(), '', 'cancel 要清掉挂起值');
  assert.equal(clock.pendingCount(), 0, '注入时钟里也不该留计时器（否则卸载后仍会触发）');

  clock.advance(SEARCH_DEBOUNCE_MS * 5);
  assert.deepEqual(commits, [], '取消之后绝不能再消费（否则卸载后仍会写状态）');
  assert.equal(debouncer.cancel(), false, '没有挂起时 cancel 报告 false（便于断言）');
});

test('P1 防抖：连续 push 不累积计时器（每次都替换，不泄漏）', () => {
  const { clock, debouncer } = makeHarness();
  for (let i = 0; i < 20; i += 1) debouncer.push(`v${i}`);
  assert.equal(clock.pendingCount(), 1, '20 次输入只该有 1 个挂起计时器');
  assert.equal(debouncer.pendingValue(), 'v19');
});

// ---------- 边界 ----------

test('P1 防抖：windowMs 非法值回落到默认，0 是合法值（等于不防抖）', () => {
  const clock = createFakeClock();
  const opts = { commit: () => {}, setTimer: clock.setTimer, clearTimer: clock.clearTimer };
  assert.equal(createSearchDebouncer({ ...opts, delayMs: NaN }).windowMs, SEARCH_DEBOUNCE_MS);
  assert.equal(createSearchDebouncer({ ...opts, delayMs: -5 }).windowMs, SEARCH_DEBOUNCE_MS);
  assert.equal(createSearchDebouncer({ ...opts, delayMs: undefined }).windowMs, SEARCH_DEBOUNCE_MS);
  assert.equal(createSearchDebouncer({ ...opts, delayMs: 0 }).windowMs, 0, '0 有意合法（测试/降级用）');
  assert.equal(createSearchDebouncer({ ...opts, delayMs: 1000 }).windowMs, 1000);
});

test('P1 防抖：commit 抛错不影响后续调度（UI setState 真抛了也不该失去响应）', () => {
  const clock = createFakeClock();
  let calls = 0;
  const debouncer = createSearchDebouncer({
    delayMs: 100,
    commit: () => { calls += 1; throw new Error('boom'); },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  assert.throws(() => { debouncer.push('a'); clock.advance(100); }, /boom/);
  assert.equal(calls, 1);
  // 时钟已被清空（fire 先置空 timer 再 commit），所以下一个输入仍能排程
  assert.equal(debouncer.hasPendingTimer(), false);
});

test('P1 防抖：null/undefined 归一成空串（走立即路径，不炸）', () => {
  const { commits, debouncer } = makeHarness();
  assert.equal(debouncer.push(null), DEBOUNCE_DECISIONS.IMMEDIATE);
  assert.equal(debouncer.push(undefined), DEBOUNCE_DECISIONS.IMMEDIATE);
  assert.deepEqual(commits, ['', '']);
});

// ---------- 全量升级判据（行为测试，替代原先只能做源码断言的写法） ----------
//
// 这条判据原先散在搜索框的 onChangeText 里，只能靠源码字符串断言。注入验证证明了
// 那种断言的弱点：把调用改成死代码（`const load = null; load(...)`）后字符串仍在，
// 测试照样全绿。抽成纯函数后，三条判据都能真跑。

test('P1 全量升级判据：窗口结束后、查询非空、且清单还不是全量时才拉', () => {
  assert.equal(shouldLoadFullList({ query: 'buildTree', alreadyFull: false }), true,
    '非空查询 + 尚未全量 → 该拉');
  assert.equal(shouldLoadFullList({ query: 'buildTree', alreadyFull: true }), false,
    '已经是全量就不得重复拉（防重复全量）');
  assert.equal(shouldLoadFullList({ query: '', alreadyFull: false }), false,
    '空查询不拉（清空不该触发全树 walk）');
  assert.equal(shouldLoadFullList({ query: '   ', alreadyFull: false }), false,
    '纯空白不算查询');
  assert.equal(shouldLoadFullList({ query: null, alreadyFull: false }), false);
  assert.equal(shouldLoadFullList({}), false, '无参数不炸、也不拉');
  assert.equal(shouldLoadFullList(), false);
});

// ---------- 接线契约（源码断言；理由见文件头） ----------

test('P1 接线：消费点只认防抖值，onChangeText 不再逐键发起全量加载', () => {
  const panel = read('src/workspace/screen/FilesPanel.js');
  const hook = read('src/workspace/screen/useWorkspaceFileSearch.js');

  // ① 搜索扫描不再用即时值（否则每个字符仍各扫一遍全量清单）
  assert.equal(/searchWorkspaceFiles\(files,\s*fileQuery\)/.test(panel), false,
    '搜索不该再直接用即时 fileQuery');
  // ② 搜索态/空态提示跟着防抖值（否则界面切换与数据不同拍）
  assert.match(panel, /if \(debouncedQuery\.trim\(\)\) return renderSearchResults\(\)/,
    '搜索态判据必须用防抖值');
  assert.match(panel, /emptyHint', \{ query: debouncedQuery\.trim\(\) \}/,
    '空结果提示要报**实际搜过的**那个词');
  // ③ onChangeText 里不得再直接发起全量加载（这是 P0-1 刚优化掉的重 IO）
  const handler = panel.slice(
    panel.indexOf('onChangeText={text =>'),
    panel.indexOf('placeholder={t(\'workspace.panel.search.placeholder\')}')
  );
  assert.ok(handler.length > 0, '前提：找到搜索框的 onChangeText');
  assert.equal(/refresh\(/.test(handler), false,
    'onChangeText 里不得发起请求（全量升级已挪到防抖窗口结束后）');
  // ④ 全量升级与结果扫描都在 hook 的处理里，且「该不该拉」走共用纯函数
  //   （判据本身由上面的行为测试覆盖；这里只钉「hook 确实用了它」，防两处各判一套）
  assert.match(hook, /createSearchDebouncer\(/, 'hook 必须用共用调度器');
  assert.match(hook, /shouldLoadFullList\(\{ query: next, alreadyFull \}\)/,
    '「该不该拉全量」必须走共用纯函数（否则又变回只能源码断言的状态）');
  assert.match(hook, /load\(undefined, \{ full: true \}\)/, '全量升级挂在窗口结束之后');
  // ⑤ 卸载要清计时器（禁止泄漏）
  assert.match(hook, /return \(\) => debouncerRef\.current\.cancel\(\)/,
    'effect 清理必须取消挂起计时器');
});

test('P1 接线：FilesPanel 不再自行 import searchWorkspaceFiles（扫描已收进 hook）', () => {
  const panel = read('src/workspace/screen/FilesPanel.js');
  assert.equal(/import \{ searchWorkspaceFiles \}/.test(panel), false,
    '扫描逻辑收进 hook 后，面板不该再直接依赖它（避免两处各扫一遍）');
});
