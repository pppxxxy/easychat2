// 工具执行前的人工确认（toolApproval.js，纯逻辑 + 注入假的 Alert）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_DENIED,
  describeToolApproval,
  requestToolApproval,
} from '../src/chat/toolApproval.js';

const t = (key, params) => {
  if (key === 'chat.tool.approval.title') return `允许执行命令？(${params.name})`;
  if (key === 'chat.tool.approval.body') return `命令：${params.command}`;
  if (key === 'chat.tool.approval.bodyEmpty') return '没有命令内容';
  if (key === 'chat.tool.approval.deny') return '拒绝';
  if (key === 'chat.tool.approval.allow') return '允许';
  return key;
};

// 假 Alert：记录调用，并按「用户点了哪个按钮」回调。
function fakeAlert(choice, index = 1) {
  const calls = [];
  return {
    calls,
    alert(title, body, buttons, options) {
      calls.push({ title, body, buttons, options });
      if (choice === 'dismiss') {
        options.onDismiss();
        return;
      }
      buttons[index].onPress();
    },
  };
}

test('describeToolApproval：展示完整命令原文，缺命令时有专门文案', () => {
  const copy = describeToolApproval({ name: 'run_shell', args: { command: 'ls -al && rm -rf tmp' }, t });
  assert.equal(copy.title, '允许执行命令？(run_shell)');
  assert.ok(copy.body.includes('ls -al && rm -rf tmp'), '正文必须含完整命令，用户不能盲签');
  assert.equal(copy.deny, '拒绝');
  assert.equal(copy.allow, '允许');
  // 超长命令不截断：这是唯一一处刻意不做长度限制的文案
  const long = describeToolApproval({ name: 'run_shell', args: { command: 'x'.repeat(5000) }, t });
  assert.ok(long.body.includes('x'.repeat(5000)));
  assert.equal(describeToolApproval({ name: 'run_shell', args: {}, t }).body, '没有命令内容');
  assert.equal(describeToolApproval({ name: 'run_shell', args: null, t }).body, '没有命令内容');
  // 不给 t 也不崩（测试/异常路径）
  assert.ok(describeToolApproval({ name: 'x' }).title.length > 0);
});

test('点「允许」返回 true，点「拒绝」返回 false', async () => {
  const allow = fakeAlert('press', 1);
  assert.equal(await requestToolApproval({ name: 'run_shell', args: { command: 'ls' }, t, showAlert: allow }), true);
  assert.equal(allow.calls.length, 1);
  assert.equal(allow.calls[0].buttons[0].style, 'cancel');
  assert.equal(allow.calls[0].buttons[1].style, 'destructive');

  const deny = fakeAlert('press', 0);
  assert.equal(await requestToolApproval({ name: 'run_shell', args: { command: 'ls' }, t, showAlert: deny }), false);
});

test('弹框被点外部关掉 / 按返回键一律按拒绝', async () => {
  const dismissed = fakeAlert('dismiss');
  assert.equal(await requestToolApproval({ name: 'run_shell', args: { command: 'ls' }, t, showAlert: dismissed }), false);
  assert.equal(dismissed.calls[0].options.cancelable, true);
});

test('没有弹框能力时直接拒绝（问不到人 = 不许执行）', async () => {
  assert.equal(await requestToolApproval({ name: 'run_shell', args: { command: 'ls' }, t, showAlert: null }), false);
  assert.equal(await requestToolApproval({ name: 'run_shell', args: { command: 'ls' }, t, showAlert: {} }), false);
});

test('用户点停止生成时立即按拒绝结算，不留悬挂 Promise', async () => {
  // 假 Alert 故意不回调任何按钮：模拟「弹框还开着，用户没点」
  const stuck = { alert() {} };
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener: (type, handler) => listeners.add(handler),
    removeEventListener: (type, handler) => listeners.delete(handler),
  };
  const pending = requestToolApproval({ name: 'run_shell', args: { command: 'sleep 999' }, t, signal, showAlert: stuck });
  assert.equal(listeners.size, 1, '必须挂上中止监听');
  for (const handler of [...listeners]) handler();
  assert.equal(await pending, false);
  assert.equal(listeners.size, 0, '结算后必须摘掉监听，避免泄漏');
});

test('已经中止的信号：连弹框都不弹', async () => {
  const alert = fakeAlert('press', 0);
  const result = await requestToolApproval({
    name: 'run_shell',
    args: { command: 'ls' },
    t,
    showAlert: alert,
    signal: { aborted: true, addEventListener() {}, removeEventListener() {} },
  });
  assert.equal(result, false);
  assert.equal(alert.calls.length, 0, '已中止就不该再打扰用户');
});

test('拒绝常量可用于上层区分「拒绝」与「失败」', () => {
  assert.equal(APPROVAL_DENIED, 'approval-denied');
});
