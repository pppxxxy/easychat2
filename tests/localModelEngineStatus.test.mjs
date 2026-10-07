// 引擎状态派生（v5 Stage C，D5）行为测试：纯函数 + runtime 回退事件。
import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveEngineStatus, ENGINE_TONE, FALLBACK_VISIBLE_MS } from '../src/localModel/engineStatus.js';
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

test('deriveEngineStatus：回退警告优先且在时间窗内过期', () => {
  const now = 1_000_000;
  const base = { enabled: true, activeModelId: 'm', activeModelName: 'Qwen', now };
  const inWindow = deriveEngineStatus({ ...base, runtime: { status: 'ready' }, fallbackAt: now - FALLBACK_VISIBLE_MS + 1 });
  assert.equal(inWindow.tone, ENGINE_TONE.FALLBACK, '窗口内回退警告优先');
  const expired = deriveEngineStatus({ ...base, runtime: { status: 'ready' }, fallbackAt: now - FALLBACK_VISIBLE_MS - 1 });
  assert.equal(expired.tone, ENGINE_TONE.READY, '窗口外恢复常规状态');
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
