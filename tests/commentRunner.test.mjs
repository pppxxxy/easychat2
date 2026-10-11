// 后台评论任务注册表：用户发完动态退出界面后，评论必须继续跑（不被组件卸载中止）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCommentingIds,
  isCommenting,
  resetCommentRunnerForTests,
  startCommentTask,
  stopCommentTask,
  subscribeCommentRunner,
} from '../src/moments/commentRunner.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('登记：启动即标记运行中，完成后自动注销', async () => {
  resetCommentRunnerForTests();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  assert.equal(startCommentTask('m1', () => gate), true);
  assert.equal(isCommenting('m1'), true);
  assert.deepEqual([...getCommentingIds()], ['m1']);
  release();
  await tick();
  await tick();
  assert.equal(isCommenting('m1'), false);
  assert.deepEqual([...getCommentingIds()], []);
});

test('同一动态重复启动会排队串行，不并发', async () => {
  resetCommentRunnerForTests();
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  startCommentTask('m1', async () => { order.push('a-start'); await gate; order.push('a-end'); });
  startCommentTask('m1', async () => { order.push('b'); });
  await tick();
  assert.deepEqual(order, ['a-start'], '第二条任务要等第一条结束');
  release();
  await tick();
  await tick();
  await tick();
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
  assert.equal(isCommenting('m1'), false);
});

test('停止：中止当前任务并丢弃排队任务', async () => {
  resetCommentRunnerForTests();
  const started = [];
  let aborted = false;
  startCommentTask('m1', ({ signal }) => new Promise(resolve => {
    started.push('a');
    signal.addEventListener('abort', () => {
      aborted = true;
      resolve();
    });
  }));
  startCommentTask('m1', () => { started.push('b'); });
  await tick();
  assert.equal(stopCommentTask('m1'), true);
  await tick();
  await tick();
  assert.equal(aborted, true, '当前任务应收到 abort');
  assert.deepEqual(started, ['a'], '排队任务应被丢弃');
  assert.equal(isCommenting('m1'), false);
  assert.equal(stopCommentTask('m1'), false, '没有任务时返回 false');
});

test('订阅：启动与完成都通知，退订后不再收到', async () => {
  resetCommentRunnerForTests();
  const seen = [];
  const unsubscribe = subscribeCommentRunner(() => seen.push([...getCommentingIds()]));
  startCommentTask('m1', async () => {});
  await tick();
  await tick();
  unsubscribe();
  startCommentTask('m2', async () => {});
  await tick();
  await tick();
  assert.deepEqual(seen, [['m1'], []]);
  assert.equal(isCommenting('m2'), false);
});

test('任务抛错不会卡住队列，后续任务照常跑', async () => {
  resetCommentRunnerForTests();
  const order = [];
  startCommentTask('m1', async () => { order.push('a'); throw new Error('boom'); });
  startCommentTask('m1', async () => { order.push('b'); });
  await tick();
  await tick();
  await tick();
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(isCommenting('m1'), false);
});

test('不同动态各自独立，互不阻塞', async () => {
  resetCommentRunnerForTests();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  startCommentTask('m1', () => gate);
  startCommentTask('m2', async () => {});
  await tick();
  await tick();
  assert.equal(isCommenting('m2'), false);
  assert.equal(isCommenting('m1'), true);
  release();
  await tick();
  await tick();
  assert.equal(isCommenting('m1'), false);
});

test('非法入参安全返回 false', () => {
  resetCommentRunnerForTests();
  assert.equal(startCommentTask('', () => {}), false);
  assert.equal(startCommentTask('m1', null), false);
  assert.equal(isCommenting(''), false);
});
