// 引擎状态派生（v5 Stage C，D5）行为测试：纯函数 + runtime 回退事件。
import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveEngineStatus, ENGINE_TONE, FALLBACK_NOTICE_DELAY_MS, FALLBACK_VISIBLE_MS } from '../src/localModel/engineStatus.js';
import {
  __resetRuntimeForTests,
  getRuntimeState,
  setRuntimeFallback,
  setRuntimeReady,
  clearRuntimeFallback,
} from '../src/localModel/runtime.js';

test('deriveEngineStatus：未启用或无活动模型时不显示', () => {
  assert.equal(deriveEngineStatus({ enabled: false, activeModelId: 'm', runtime: {} }).visible, false);
  assert.equal(deriveEngineStatus({ enabled: true, activeModelId: '', runtime: {} }).visible, false);
});

test('deriveEngineStatus：loading/ready/error/idle 分级', () => {
  const base = { enabled: true, activeModelId: 'm', activeModelName: 'Qwen' };
  const loading = deriveEngineStatus({ ...base, runtime: { status: 'loading', progress: 42 } });
  assert.equal(loading.tone, ENGINE_TONE.LOADING);
  assert.equal(loading.progress, 42);
  const ready = deriveEngineStatus({ ...base, runtime: { status: 'ready', ramEstimate: 2700 } });
  assert.equal(ready.tone, ENGINE_TONE.READY);
  assert.equal(ready.ramBytes, 2700);
  const error = deriveEngineStatus({ ...base, runtime: { status: 'error' } });
  assert.equal(error.tone, ENGINE_TONE.ERROR);
  const idle = deriveEngineStatus({ ...base, runtime: { status: 'idle' } });
  assert.equal(idle.tone, ENGINE_TONE.IDLE);
});

test('deriveEngineStatus：回退警告延时出现、到点停留、过期恢复常规状态', () => {
  const now = 1_000_000;
  const base = { enabled: true, activeModelId: 'm', activeModelName: 'Qwen', now };

  // 延时窗内：不提示（滤掉瞬时抖动），落回常规状态。
  const justFailed = deriveEngineStatus({ ...base, runtime: { status: 'ready' }, fallbackAt: now });
  assert.equal(justFailed.tone, ENGINE_TONE.READY, '刚降级时不立刻弹警告');
  const beforeDelay = deriveEngineStatus({
    ...base, runtime: { status: 'ready' }, fallbackAt: now - FALLBACK_NOTICE_DELAY_MS + 1,
  });
  assert.equal(beforeDelay.tone, ENGINE_TONE.READY, '延时差 1ms 仍不提示');

  // 到点：提示。
  const atDelay = deriveEngineStatus({
    ...base, runtime: { status: 'ready' }, fallbackAt: now - FALLBACK_NOTICE_DELAY_MS,
  });
  assert.equal(atDelay.tone, ENGINE_TONE.FALLBACK, '到延时点即提示');
  const inWindow = deriveEngineStatus({
    ...base, runtime: { status: 'ready' }, fallbackAt: now - FALLBACK_NOTICE_DELAY_MS - FALLBACK_VISIBLE_MS + 1,
  });
  assert.equal(inWindow.tone, ENGINE_TONE.FALLBACK, '停留窗内仍提示');

  // 过期：恢复常规状态。
  const expired = deriveEngineStatus({
    ...base, runtime: { status: 'ready' }, fallbackAt: now - FALLBACK_NOTICE_DELAY_MS - FALLBACK_VISIBLE_MS - 1,
  });
  assert.equal(expired.tone, ENGINE_TONE.READY, '停留窗过后恢复常规状态');
});

test('降级提示延时是「人类舒适」量级：≥2s 以滤掉抖动，≤5s 以免用户错过', () => {
  assert.ok(FALLBACK_NOTICE_DELAY_MS >= 2000, '延时太短等于没滤抖动');
  assert.ok(FALLBACK_NOTICE_DELAY_MS <= 5000, '延时太长用户会以为一直在用本地模型');
  assert.ok(FALLBACK_VISIBLE_MS >= FALLBACK_NOTICE_DELAY_MS, '停留时间不该短于延时');
});

test('runtime：setRuntimeFallback 记录时间戳并随快照广播', () => {
  __resetRuntimeForTests();
  assert.equal(getRuntimeState().fallbackAt, 0);
  setRuntimeFallback(12345);
  assert.equal(getRuntimeState().fallbackAt, 12345);
  clearRuntimeFallback();
  assert.equal(getRuntimeState().fallbackAt, 0);
});

test('runtime：ready 快照携带 fallbackAt=0（回退不被状态迁移冲掉）', () => {
  __resetRuntimeForTests();
  setRuntimeFallback(999);
  setRuntimeReady({ modelId: 'm', ramEstimate: 1 });
  const state = getRuntimeState();
  assert.equal(state.status, 'ready');
  assert.equal(state.fallbackAt, 999, '回退时间戳独立于状态机保留');
});
