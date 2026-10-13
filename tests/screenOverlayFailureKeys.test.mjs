// FIX-3 / FIX-4 的 **JS 纯逻辑**回归：启动链幂等、失败档位映射、原因码映射、打点解析。
//
// 为什么这些要单独测：它们都是**纯函数/纯状态机**，能在 Node 里直接执行（原生部分只能靠
// screenOverlayLifecycle.test.mjs 的源码结构断言）。真机上那几个 bug 的 JS 侧成因——
// 「两个入口行为不一致」「失败文案分不清原因」「连点弹两个授权窗」——都在这一层。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPTURE_FAILURE_KEYS,
  captureFailureKey,
  overlayStartFailureAlert,
  parseTraceEvent,
  OVERLAY_EVENT_TRACE,
  START_FAILURE_ALERTS,
} from '../src/screenWatch/overlayEvents.js';

// ---------- FIX-4：原因码 → 文案 ----------

test('captureFailureKey：授权类原因都指向「重新授权」文案', () => {
  for (const reason of ['no-projection', 'projection-denied', 'projection-invalid', 'no-manager']) {
    assert.equal(captureFailureKey(reason), 'screenWatch.overlay.captureFailed.permission', reason);
  }
});

test('captureFailureKey：no-frame 与 timeout 各有专属文案（笼统的「请重试」帮不上忙）', () => {
  // 这两条是本次新增：前者要用户让画面动一下，后者要用户去关电池优化。
  assert.equal(captureFailureKey('no-frame'), 'screenWatch.overlay.captureFailed.noFrame');
  assert.equal(captureFailureKey('timeout'), 'screenWatch.overlay.captureFailed.timeout');
  // 与授权类**必须不同**，否则又回到「所有失败一句话」
  assert.notEqual(captureFailureKey('timeout'), captureFailureKey('no-projection'));
  assert.notEqual(captureFailureKey('no-frame'), captureFailureKey('no-projection'));
});

test('captureFailureKey：未知/空原因回落到通用文案（不把内部码甩给用户）', () => {
  const fallback = 'screenWatch.overlay.captureFailed';
  assert.equal(captureFailureKey('whatever'), fallback);
  assert.equal(captureFailureKey(''), fallback);
  assert.equal(captureFailureKey(null), fallback);
  assert.equal(captureFailureKey(undefined), fallback);
  // 回落值本身不能是「未定义」之类的内部串
  assert.ok(fallback.startsWith('screenWatch.'));
});

test('captureFailureKey：所有映射值都是 screenWatch.overlay.* 词条（不漏到别的域）', () => {
  for (const [reason, key] of Object.entries(CAPTURE_FAILURE_KEYS)) {
    assert.ok(key.startsWith('screenWatch.overlay.captureFailed'), `${reason} → ${key} 越域`);
  }
});

// ---------- FIX-3：启动失败档位 ----------

test('overlayStartFailureAlert：四档各有映射，且权限两档文案不同', () => {
  const overlay = overlayStartFailureAlert('overlay-permission');
  const capture = overlayStartFailureAlert('capture-permission');
  assert.equal(overlay.titleKey, 'screenWatch.overlay.permission.title');
  assert.equal(capture.titleKey, 'screenWatch.overlay.capturePerm.title');
  // 关键：把这两种混成一句会让用户去改错的地方（分别是「显示在其他应用上层」与「允许录屏」）
  assert.notEqual(overlay.bodyKey, capture.bodyKey);
});

test('overlayStartFailureAlert：unsupported/start-failed 有正文，未知档回落 start-failed', () => {
  assert.equal(overlayStartFailureAlert('unsupported').bodyKey, 'screenWatch.overlay.unsupported');
  assert.equal(overlayStartFailureAlert('start-failed').bodyKey, 'screenWatch.overlay.startFailed');
  assert.deepEqual(overlayStartFailureAlert('nope'), START_FAILURE_ALERTS['start-failed']);
  assert.deepEqual(overlayStartFailureAlert(undefined), START_FAILURE_ALERTS['start-failed']);
  // unsupported 与 start-failed 都没有专门标题（复用通用标题），但必须有正文
  assert.equal(overlayStartFailureAlert('unsupported').titleKey, null);
  for (const value of Object.values(START_FAILURE_ALERTS)) {
    assert.ok(value.bodyKey, '每一档都要有正文 key');
  }
});

// ---------- FIX-4：打点解析 ----------

test('parseTraceEvent：正常解析 stage/detail/at', () => {
  const parsed = parseTraceEvent({ stage: 'capture-saved', detail: '412ms', at: 1700000000000 });
  assert.deepEqual(parsed, { stage: 'capture-saved', detail: '412ms', at: 1700000000000 });
});

test('parseTraceEvent：stage 为空视为无效（没有阶段名就没有诊断价值）', () => {
  assert.equal(parseTraceEvent({ stage: '' }), null);
  assert.equal(parseTraceEvent({ detail: 'x' }), null);
  assert.equal(parseTraceEvent(null), null);
  assert.equal(parseTraceEvent(undefined), null);
  assert.equal(parseTraceEvent({}), null);
});

test('parseTraceEvent：detail/at 缺失时给安全默认（不产出 undefined/NaN）', () => {
  const parsed = parseTraceEvent({ stage: 'fgs-fallback' });
  assert.equal(parsed.stage, 'fgs-fallback');
  assert.equal(parsed.detail, '');
  assert.equal(typeof parsed.at, 'number');
  assert.ok(Number.isFinite(parsed.at) && parsed.at > 0);
  // at 传垃圾值也要回落成数字
  const junk = parseTraceEvent({ stage: 'x', at: 'not-a-number' });
  assert.ok(Number.isFinite(junk.at));
});

test('parseTraceEvent：stage 两端空白被裁掉（避免同阶段出现两种 key）', () => {
  assert.equal(parseTraceEvent({ stage: '  timeout  ' }).stage, 'timeout');
  assert.equal(parseTraceEvent({ stage: '   ' }), null);
});

test('打点事件名与原生常量同值（Kotlin 侧另有静态断言，这里钉 JS 常量本身）', () => {
  assert.equal(OVERLAY_EVENT_TRACE, 'ScreenOverlay:onTrace');
  // 命名空间前缀：事件要走 ScreenOverlay: 通道，否则 RN 侧监听不到
  assert.ok(OVERLAY_EVENT_TRACE.startsWith('ScreenOverlay:'));
});
