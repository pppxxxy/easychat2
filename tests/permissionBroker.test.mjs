// 权限 broker（Z 系采纳 #3）：请求生命周期与「谁来答」解耦。
// 关键不变量：没有应答方 = 拒绝；中止/超时 = 拒绝；同一 requestId 不重复挂；
// 只结算一次；支持带外结算（通知栏/面板替用户点）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  PERMISSION_DENY,
  createPermissionBroker,
  permissionBroker,
  resetPermissionBrokerForTests,
} from '../src/agent/permission/broker.js';

const req = (id, extra = {}) => ({ requestId: id, toolName: 'run_shell', args: { command: 'ls' }, ...extra });

test('接线：approveToolCall 经 broker 发起审批，Alert 只是默认应答方', () => {
  const src = readFileSync(path.resolve('src/chat/toolApprovalFlow.js'), 'utf8');
  assert.ok(src.includes("from '../agent/permission/broker.js'"), '导入 broker');
  assert.ok(src.includes('broker.requestPermission('), '审批经 broker 发起');
  assert.ok(src.includes('handler: handler || defaultApprovalHandler'), '默认应答方是 Alert，可被覆盖');
  assert.ok(src.includes('function defaultApprovalHandler'), 'Alert 应答方独立成函数');
});

test('没有应答方 → 立即拒绝（问不到人就不执行）', async () => {
  const broker = createPermissionBroker();
  const result = await broker.requestPermission(req('a'));
  assert.equal(result.decision, PERMISSION_DENY);
  assert.equal(result.reason, 'no permission client');
});

test('缺 requestId → 拒绝（Promise reject）', async () => {
  const broker = createPermissionBroker();
  await assert.rejects(() => broker.requestPermission({ toolName: 'x' }), /missing requestId/);
});

test('应答方返回决定 → 结算为该决定', async () => {
  const broker = createPermissionBroker().setHandler(() => 'session');
  const result = await broker.requestPermission(req('a'));
  assert.equal(result.decision, 'session');
  assert.ok(result.resolvedAt > 0);
});

test('应答方抛错 → Promise reject', async () => {
  const broker = createPermissionBroker().setHandler(() => { throw new Error('boom'); });
  await assert.rejects(() => broker.requestPermission(req('a')), /boom/);
});

test('每次请求可覆盖已注册的应答方', async () => {
  const broker = createPermissionBroker().setHandler(() => 'always');
  const result = await broker.requestPermission(req('a'), { handler: () => 'deny' });
  assert.equal(result.decision, 'deny');
  // 覆盖只对本次生效
  assert.equal((await broker.requestPermission(req('b'))).decision, 'always');
});

test('应答方返回 undefined → 交给带外结算（resolvePermission）', async () => {
  const broker = createPermissionBroker().setHandler(() => undefined);
  const pending = broker.requestPermission(req('a'));
  assert.equal(broker.getPendingRequest('a').toolName, 'run_shell');
  assert.equal(broker.resolvePermission('a', 'always'), true);
  assert.equal((await pending).decision, 'always');
  assert.equal(broker.resolvePermission('a', 'deny'), false, '已结算就不能再结算');
});

test('同一 requestId 已在等 → 第二个请求被拒（不覆盖）', async () => {
  const broker = createPermissionBroker().setHandler(() => new Promise(() => {}));
  broker.requestPermission(req('dup'));
  await assert.rejects(() => broker.requestPermission(req('dup')), /already pending/);
});

test('中止信号 → 按拒绝结算并摘掉监听', async () => {
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener: (t, h) => listeners.add(h),
    removeEventListener: (t, h) => listeners.delete(h),
  };
  const broker = createPermissionBroker().setHandler(() => new Promise(() => {}));
  const pending = broker.requestPermission(req('a'), { signal });
  assert.equal(listeners.size, 1);
  for (const h of [...listeners]) h();
  assert.equal((await pending).decision, PERMISSION_DENY);
  assert.equal(listeners.size, 0, '结算后必须摘掉监听');
});

test('已中止的信号 → 连应答方都不叫', async () => {
  let called = 0;
  const broker = createPermissionBroker().setHandler(() => { called += 1; return 'always'; });
  const result = await broker.requestPermission(req('a'), {
    signal: { aborted: true, addEventListener() {}, removeEventListener() {} },
  });
  assert.equal(result.decision, PERMISSION_DENY);
  assert.equal(result.reason, 'aborted');
  assert.equal(called, 0);
});

test('超时 → 拒绝', async () => {
  const broker = createPermissionBroker().setHandler(() => new Promise(() => {}));
  const result = await broker.requestPermission(req('a'), { timeoutMs: 10 });
  assert.equal(result.decision, PERMISSION_DENY);
  assert.equal(result.reason, 'timeout');
});

test('rejectPermission → Promise reject', async () => {
  const broker = createPermissionBroker().setHandler(() => undefined);
  const pending = broker.requestPermission(req('a'));
  assert.equal(broker.rejectPermission('a', new Error('cancelled')), true);
  await assert.rejects(() => pending, /cancelled/);
});

test('listPendingRequests 反映在等的请求', async () => {
  const broker = createPermissionBroker().setHandler(() => new Promise(() => {}));
  broker.requestPermission(req('a'));
  broker.requestPermission(req('b'));
  assert.deepEqual(broker.listPendingRequests().map(r => r.requestId), ['a', 'b']);
});

test('单例：reset 清空 pending 与应答方', async () => {
  resetPermissionBrokerForTests();
  permissionBroker.setHandler(() => new Promise(() => {}));
  permissionBroker.requestPermission(req('a'));
  assert.equal(permissionBroker.listPendingRequests().length, 1);
  resetPermissionBrokerForTests();
  assert.equal(permissionBroker.listPendingRequests().length, 0);
  assert.equal(permissionBroker.getHandler(), null);
});
