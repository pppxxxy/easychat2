// 会话运行时登记表（L 系骨架）：准入、注销、取消、订阅的行为测试。
// 关键不变量：同会话不重复登记（准入）；取消必先 abort 控制器再注销（登记表与请求状态一致）；
// 监听者抛错不影响登记/取消；resetForTests 清干净。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionRunRegistry, sessionRuns, resetSessionRunsForTests } from '../src/agent/runtime/sessionRuns.js';

function fakeController() {
  return {
    aborted: false,
    abortCount: 0,
    abort() {
      this.aborted = true;
      this.abortCount += 1;
    },
  };
}

test('start：登记成功返回 run，空 sessionId 返回 null', () => {
  const reg = createSessionRunRegistry();
  assert.equal(reg.start('', { controller: fakeController() }), null);
  const token = { id: 7 };
  const run = reg.start('s1', { characterId: 'c1', controller: fakeController(), label: '小明', token });
  assert.ok(run);
  assert.equal(run.sessionId, 's1');
  assert.equal(run.characterId, 'c1');
  assert.equal(run.status, 'running');
  assert.equal(run.label, '小明');
  assert.equal(run.token, token);
  assert.equal(reg.has('s1'), true);
  assert.equal(reg.isRunning('s1'), true);
  assert.equal(reg.size(), 1);
});

test('start：同一会话不重复登记（准入闸门），返回 null 且不覆盖既有 run', () => {
  const reg = createSessionRunRegistry();
  const first = reg.start('s1', { controller: fakeController(), characterId: 'c1' });
  const second = reg.start('s1', { controller: fakeController(), characterId: 'c2' });
  assert.equal(second, null);
  assert.equal(reg.get('s1'), first);
  assert.equal(reg.size(), 1);
});

test('不同会话各自独立登记（为多会话并发留位）', () => {
  const reg = createSessionRunRegistry();
  reg.start('s1', { controller: fakeController() });
  reg.start('s2', { controller: fakeController() });
  assert.equal(reg.size(), 2);
  assert.deepEqual(reg.list().map(run => run.sessionId).sort(), ['s1', 's2']);
});

test('finish：注销存在项返回 true，重复注销返回 false', () => {
  const reg = createSessionRunRegistry();
  reg.start('s1', { controller: fakeController() });
  assert.equal(reg.finish('s1'), true);
  assert.equal(reg.finish('s1'), false);
  assert.equal(reg.has('s1'), false);
  assert.equal(reg.size(), 0);
});

test('cancel：先 abort 控制器再注销；对不存在的会话返回 false', () => {
  const reg = createSessionRunRegistry();
  const controller = fakeController();
  reg.start('s1', { controller });
  assert.equal(reg.cancel('s1'), true);
  assert.equal(controller.aborted, true);
  assert.equal(controller.abortCount, 1);
  assert.equal(reg.has('s1'), false);
  assert.equal(reg.cancel('s1'), false);
});

test('cancel：控制器 abort 抛错也要完成注销（登记表与请求状态不脱节）', () => {
  const reg = createSessionRunRegistry();
  const controller = { abort() { throw new Error('boom'); } };
  reg.start('s1', { controller });
  assert.equal(reg.cancel('s1'), true);
  assert.equal(reg.has('s1'), false);
});

test('start：控制器被中止时自动注销（防「登记表幽灵」泄漏）', () => {
  const reg = createSessionRunRegistry();
  const controller = new AbortController();
  reg.start('s1', { controller });
  assert.equal(reg.has('s1'), true);
  // 会话切换路径会直接 abort abortRef.current（不经 endSendOperation），
  // 登记表必须跟着清掉。
  controller.abort();
  assert.equal(reg.has('s1'), false);
  assert.equal(reg.size(), 0);
});

test('cancelAll：取消全部并返回条数', () => {
  const reg = createSessionRunRegistry();
  const a = fakeController();
  const b = fakeController();
  reg.start('s1', { controller: a });
  reg.start('s2', { controller: b });
  assert.equal(reg.cancelAll(), 2);
  assert.equal(a.aborted, true);
  assert.equal(b.aborted, true);
  assert.equal(reg.size(), 0);
});

test('list：按 startedAt 升序（先跑的先列）', () => {
  const reg = createSessionRunRegistry();
  const original = Date.now;
  let tick = 1000;
  Date.now = () => (tick += 10);
  try {
    reg.start('s2', { controller: fakeController() });
    reg.start('s1', { controller: fakeController() });
    assert.deepEqual(reg.list().map(run => run.sessionId), ['s2', 's1']);
  } finally {
    Date.now = original;
  }
});

test('subscribe：变更时收到快照，退订后不再收到；监听者抛错不影响主流程', () => {
  const reg = createSessionRunRegistry();
  const seen = [];
  const unsubscribe = reg.subscribe(snapshot => seen.push(snapshot.map(run => run.sessionId)));
  reg.subscribe(() => { throw new Error('listener boom'); });
  reg.start('s1', { controller: fakeController() });
  reg.finish('s1');
  assert.deepEqual(seen, [['s1'], []]);
  unsubscribe();
  reg.start('s2', { controller: fakeController() });
  assert.equal(seen.length, 2);
});

test('subscribe：非函数入参返回空退订函数，不抛', () => {
  const reg = createSessionRunRegistry();
  const unsubscribe = reg.subscribe(null);
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();
});

test('单例：sessionRuns 与 resetForTests 清干净', () => {
  resetSessionRunsForTests();
  sessionRuns.start('s1', { controller: fakeController() });
  assert.equal(sessionRuns.size(), 1);
  resetSessionRunsForTests();
  assert.equal(sessionRuns.size(), 0);
});
