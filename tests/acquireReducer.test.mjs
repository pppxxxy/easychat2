// 获取域状态机（useReducer 改造）行为测试：纯函数直测，钉死与旧 useState 版一致的语义。
// 关键不变量：函数式更新兼容、两份草稿互不影响、同值不换引用（避免无谓重渲染）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { acquireReducer, IDLE_TASK, nextValue } from '../src/localModel/panel/acquireReducer.js';

const initial = () => ({
  tab: 'download',
  downloadDraft: { modelId: 'a' },
  importDraft: { sourceUri: 'file:///x.gguf' },
  task: IDLE_TASK,
});

test('tab：同值不换引用，异值切新对象', () => {
  const state = initial();
  assert.equal(acquireReducer(state, { type: 'tab', value: 'download' }), state);
  const next = acquireReducer(state, { type: 'tab', value: 'import' });
  assert.equal(next.tab, 'import');
  assert.notEqual(next, state);
});

test('草稿：值与函数式更新都支持，两份草稿互不影响', () => {
  const state = initial();
  const byValue = acquireReducer(state, { type: 'downloadDraft', value: { modelId: 'b' } });
  assert.equal(byValue.downloadDraft.modelId, 'b');
  assert.equal(byValue.importDraft, state.importDraft, '改下载草稿不得动导入草稿');

  const byFn = acquireReducer(state, {
    type: 'importDraft',
    value: current => ({ ...current, name: '模型' }),
  });
  assert.equal(byFn.importDraft.name, '模型');
  assert.equal(byFn.importDraft.sourceUri, 'file:///x.gguf', '函数式更新基于当前值');
  assert.equal(byFn.downloadDraft, state.downloadDraft, '改导入草稿不得动下载草稿');
});

test('task：单对象任务态，进度走函数式更新，收起回 IDLE_TASK', () => {
  const state = initial();
  const running = acquireReducer(state, {
    type: 'task',
    value: { kind: 'download', progress: 0, writtenBytes: 0, totalBytes: 100 },
  });
  assert.equal(running.task.kind, 'download');

  const progressed = acquireReducer(running, {
    type: 'task',
    value: current => ({ ...current, progress: 42, writtenBytes: 42, totalBytes: 100 }),
  });
  assert.equal(progressed.task.progress, 42);
  assert.equal(progressed.task.writtenBytes, 42);

  const idle = acquireReducer(progressed, { type: 'task', value: IDLE_TASK });
  assert.equal(idle.task.kind, '', 'kind 为空即「没有任务在跑」，不存在 busy 孤儿态');
});

test('未知 action 与空 action：原样返回（reducer 稳定）', () => {
  const state = initial();
  assert.equal(acquireReducer(state, { type: 'nope' }), state);
  assert.equal(acquireReducer(state, null), state);
  assert.equal(acquireReducer(state, undefined), state);
});

test('nextValue：值与函数二选一', () => {
  assert.equal(nextValue(1, 2), 2);
  assert.equal(nextValue(1, current => current + 1), 2);
});
