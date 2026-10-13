// R4 回归：拉取控制器的状态机（模块级单例）。
//
// 钉住三件在真机上救过场的事：
//   ① 二次启动被拒（切标签重挂载后重入守卫不再归零 → 不会两个写入循环并发写同一 store）；
//   ② 进度/提示活在单例里（面板卸载不带走状态 → 重挂载即恢复，而不是显示「没在拉取」）；
//   ③ 「面板不在场时完成」被如实记下（区分「失明」与「真死」）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachPullPanel,
  beginPull,
  consumeFinishedWhileAway,
  endPull,
  getPullState,
  isPullCancelRequested,
  isPullRunning,
  pullPanelAttached,
  requestPullCancel,
  resetPullController,
  setPullNotice,
  setPullProgress,
  subscribePull,
} from '../src/workspace/screen/github/pullController.js';

test.beforeEach(() => resetPullController());

test('双写保护：running 期间再点一次被拒（且不副作用）', () => {
  assert.equal(isPullRunning(), false);
  assert.equal(beginPull({ at: 1000 }), true, '首次启动成功');
  assert.equal(isPullRunning(), true);

  setPullProgress({ done: 3, total: 10 }, 42);
  assert.equal(beginPull({ at: 2000 }), false, '已在拉取中 → 拒绝第二次启动');
  // 拒绝不得清掉正在跑的进度（旧实现静默 return，重挂载后还能再点一次）
  assert.deepEqual(getPullState().progress, { done: 3, total: 10 });
  assert.equal(getPullState().eta, 42);
});

test('进度/提示住在单例里：卸载重挂（重新订阅）仍读得到', () => {
  beginPull({ at: 0 });
  setPullProgress({ done: 7, total: 1066 }, 120);
  setPullNotice('检测到上次拉取未完成（目标 1066 个文件）——本次将覆盖重写。');

  // 模拟面板卸载 + 重新挂载：订阅者清空后重建，读的是模块级 state
  const seen = [];
  const unsubscribe = subscribePull(() => seen.push(getPullState().progress.done));
  setPullProgress({ done: 8, total: 1066 }, 118);
  unsubscribe();

  const state = getPullState();
  assert.equal(state.running, true, '重挂载后仍知道「在拉取中」');
  assert.deepEqual(state.progress, { done: 8, total: 1066 });
  assert.match(state.notice, /覆盖重写/);
  assert.deepEqual(seen, [8]);
});

test('订阅：可退订；订阅者抛错不影响主流程；坏订阅者被忽略', () => {
  beginPull();
  let good = 0;
  const bad = () => { throw new Error('boom'); };
  const offGood = subscribePull(() => { good += 1; });
  const offBad = subscribePull(bad);
  assert.doesNotThrow(() => setPullProgress({ done: 1, total: 2 }), '订阅者异常不得外抛');
  assert.equal(good, 1);
  offGood();
  offBad();
  setPullProgress({ done: 2, total: 2 });
  assert.equal(good, 1, '退订后不再收到通知');
  assert.deepEqual(subscribePull(null)(), undefined, '坏订阅者返回安全退订函数');
});

test('取消：只在运行时置位，收尾清空', () => {
  assert.equal(requestPullCancel(), false, '没在跑时取消是空操作');
  assert.equal(isPullCancelRequested(), false);

  beginPull();
  assert.equal(requestPullCancel(), true);
  assert.equal(isPullCancelRequested(), true);

  const summary = endPull({ result: 'cancelled', written: 12, at: 500 });
  assert.equal(isPullRunning(), false);
  assert.equal(isPullCancelRequested(), false, '收尾必须清取消位（否则下次拉取秒退）');
  assert.equal(summary.result, 'cancelled');
  assert.equal(summary.written, 12);
});

test('面板在场/不在场：finishedWhileAway 只在「离开时跑完」出现，且可消费一次', () => {
  // ① 面板在场：正常收尾，不留提示
  const detach = attachPullPanel();
  assert.equal(pullPanelAttached(), true);
  beginPull({ at: 100 });
  const here = endPull({ result: 'ok', written: 5, at: 600 });
  assert.equal(here.panelAttached, true);
  assert.equal(here.durationMs, 500, '起止时间如实记录（诊断用）');
  assert.equal(getPullState().finishedWhileAway, null, '在场完成不留「离开时跑完」提示');
  detach();

  // ② 面板不在场（切标签卸载）：收尾记下摘要，重挂载后可读
  assert.equal(pullPanelAttached(), false);
  beginPull({ at: 1000 });
  const away = endPull({ result: 'ok', written: 1066, at: 91000 });
  assert.equal(away.panelAttached, false);
  assert.equal(away.durationMs, 90000);
  assert.deepEqual(getPullState().finishedWhileAway, away, '「失明」被如实记下，而不是丢失');

  const consumed = consumeFinishedWhileAway();
  assert.deepEqual(consumed, away);
  assert.equal(consumeFinishedWhileAway(), null, '消费一次即清（不反复打扰）');
  assert.equal(getPullState().lastResult.result, 'ok', 'lastResult 仍保留供诊断');
});

test('挂载计数成对：多次挂载/卸载不会把「在场」判错', () => {
  const a = attachPullPanel();
  const b = attachPullPanel();
  assert.equal(pullPanelAttached(), true);
  a();
  assert.equal(pullPanelAttached(), true, '还有一个面板挂着');
  b();
  assert.equal(pullPanelAttached(), false);

  beginPull();
  const summary = endPull({ result: 'ok', written: 1 });
  assert.equal(summary.panelAttached, false);
  // 多余的 detach 不会把计数压成负数
  b();
  assert.equal(pullPanelAttached(), false);
});
