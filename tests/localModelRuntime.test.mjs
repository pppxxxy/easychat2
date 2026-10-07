// 本地模型运行时状态（v5 Stage A）行为测试：状态机迁移 + 订阅广播 + 快照隔离。
// 纯模块单例，无 RN/Expo 依赖，直接 Node 测试。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetRuntimeForTests,
  getRuntimeState,
  setRuntimeError,
  setRuntimeIdle,
  setRuntimeLoading,
  setRuntimeProgress,
  setRuntimeReady,
  subscribeRuntime,
} from '../src/localModel/runtime.js';

test('runtime：idle → loading → ready 迁移与进度夹取', () => {
  __resetRuntimeForTests();
  assert.equal(getRuntimeState().status, 'idle');
  setRuntimeLoading('m1', 0);
  assert.equal(getRuntimeState().status, 'loading');
  assert.equal(getRuntimeState().modelId, 'm1');
  setRuntimeProgress(45);
  assert.equal(getRuntimeState().progress, 45);
  setRuntimeProgress(999);
  assert.equal(getRuntimeState().progress, 100);
  setRuntimeReady({ modelId: 'm1', ramEstimate: 2_700_000_000, support: { vision: true, audio: false } });
  const ready = getRuntimeState();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.progress, 100);
  assert.equal(ready.ramEstimate, 2_700_000_000);
  assert.deepEqual(ready.support, { vision: true, audio: false });
});

test('runtime：error 记录 message，idle 清空', () => {
  __resetRuntimeForTests();
  setRuntimeLoading('m2', 10);
  setRuntimeError(new Error('加载失败'), 'm2');
  const errored = getRuntimeState();
  assert.equal(errored.status, 'error');
  assert.equal(errored.error, '加载失败');
  assert.equal(errored.modelId, 'm2');
  setRuntimeIdle();
  assert.equal(getRuntimeState().status, 'idle');
  assert.equal(getRuntimeState().error, '');
  assert.equal(getRuntimeState().ramEstimate, 0);
});

test('runtime：订阅者收到每次迁移，退订后不再收到', () => {
  __resetRuntimeForTests();
  const seen = [];
  const unsubscribe = subscribeRuntime(state => seen.push(state.status));
  setRuntimeLoading('m3', 0);
  setRuntimeProgress(50);
  setRuntimeReady({ modelId: 'm3' });
  unsubscribe();
  setRuntimeIdle();
  assert.deepEqual(seen, ['loading', 'loading', 'ready']);
});

test('runtime：快照隔离——订阅者拿到的状态不被后续变更污染', () => {
  __resetRuntimeForTests();
  let captured = null;
  const unsubscribe = subscribeRuntime(state => { captured = state; });
  setRuntimeReady({ modelId: 'm4', ramEstimate: 100, support: { vision: true, audio: true } });
  unsubscribe();
  setRuntimeIdle();
  assert.equal(captured.status, 'ready');
  assert.equal(captured.ramEstimate, 100);
  assert.deepEqual(captured.support, { vision: true, audio: true });
});

test('runtime：订阅者抛错不影响其他订阅者与状态', () => {
  __resetRuntimeForTests();
  let secondSeen = 0;
  const good = subscribeRuntime(() => { secondSeen += 1; });
  const bad = subscribeRuntime(() => { throw new Error('listener boom'); });
  setRuntimeLoading('m5', 0);
  assert.equal(secondSeen, 1);
  assert.equal(getRuntimeState().status, 'loading');
  good();
  bad();
});
