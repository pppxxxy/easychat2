// 输入文本 store：行为测试（机制 3 期 1）。
//
// 这是一个模块级单例 store，所以测试必须每例复位（__resetInputForTests）。判据围绕
// 「宿主不再因按键重渲染」这个目标所依赖的几条不变量：
//   ① 写入必须通知订阅者（否则 ChatComposer 不更新，输入框会显示不出字）；
//   ② 同值写入**不得**通知（否则发送后清空、切会话清空会凭空多出重渲染）；
//   ③ getInput 是调用期读取、不建立订阅（宿主用它才不会被拖进重渲染）；
//   ④ 退订必须彻底（否则卸载后旧订阅者还在被通知，等于泄漏 + 幽灵重渲染）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __listenerCountForTests,
  __resetInputForTests,
  getInput,
  setInput,
  subscribe,
} from '../src/chat/inputStore.js';

test('初始值为空串；写入后 getInput 立即读到新值', () => {
  __resetInputForTests();
  assert.equal(getInput(), '');
  setInput('你好');
  assert.equal(getInput(), '你好');
});

test('写入必须通知所有订阅者（输入框靠它更新）', () => {
  __resetInputForTests();
  let aCalls = 0;
  let bCalls = 0;
  const offA = subscribe(() => { aCalls += 1; });
  const offB = subscribe(() => { bCalls += 1; });
  setInput('x');
  assert.equal(aCalls, 1, '订阅者 A 必须被通知');
  assert.equal(bCalls, 1, '订阅者 B 必须被通知');
  setInput('xy');
  assert.equal(aCalls, 2);
  assert.equal(bCalls, 2);
  offA();
  offB();
});

test('同值写入不通知（与 useState 的 bail-out 一致，避免无意义重渲染）', () => {
  __resetInputForTests();
  let calls = 0;
  const off = subscribe(() => { calls += 1; });
  assert.equal(setInput(''), false, '空串 → 空串：无变化，返回 false');
  assert.equal(calls, 0, '无变化不得通知');
  assert.equal(setInput('a'), true);
  assert.equal(calls, 1);
  assert.equal(setInput('a'), false, '同值重复写：无变化');
  assert.equal(calls, 1, '同值重复写不得再通知');
  off();
});

test('返回值语义：true = 真的变了（调用方可据此决定要不要做后续动作）', () => {
  __resetInputForTests();
  assert.equal(setInput('a'), true);
  assert.equal(setInput('a'), false);
  assert.equal(setInput('b'), true);
  assert.equal(setInput(''), true);
  assert.equal(setInput(''), false);
});

test('入参归一为字符串：undefined / null / 数字都不产生坏值', () => {
  __resetInputForTests();
  setInput(undefined);
  assert.equal(getInput(), '', 'undefined 归一为空串（useState 版会留下 undefined 并让 input.trim() 抛错）');
  setInput(null);
  assert.equal(getInput(), '');
  setInput(42);
  assert.equal(getInput(), '42');
  setInput('正常');
  assert.equal(getInput(), '正常');
});

test('getInput 是调用期读取，不建立订阅（宿主用它才不会被拖进重渲染）', () => {
  __resetInputForTests();
  const before = __listenerCountForTests();
  getInput();
  getInput();
  assert.equal(__listenerCountForTests(), before, 'getInput 不得注册订阅者');
});

test('退订彻底：退订后不再收到通知，订阅者数量归零', () => {
  __resetInputForTests();
  let calls = 0;
  const off = subscribe(() => { calls += 1; });
  assert.equal(__listenerCountForTests(), 1);
  setInput('a');
  assert.equal(calls, 1);
  off();
  assert.equal(__listenerCountForTests(), 0, '退订必须从集合里移除');
  setInput('b');
  assert.equal(calls, 1, '退订后不得再被通知');
});

test('重复退订是幂等的（useSyncExternalStore 可能重复调用清理函数）', () => {
  __resetInputForTests();
  const off = subscribe(() => {});
  off();
  off();
  assert.equal(__listenerCountForTests(), 0);
});

test('非法订阅者被忽略且不抛错', () => {
  __resetInputForTests();
  const off = subscribe(null);
  assert.equal(typeof off, 'function', '必须返回可调用的退订函数');
  off();
  setInput('a');
  assert.equal(getInput(), 'a');
});

test('一个订阅者抛错不影响其它订阅者，也不影响写入本身', () => {
  __resetInputForTests();
  let goodCalls = 0;
  subscribe(() => { throw new Error('订阅者炸了'); });
  subscribe(() => { goodCalls += 1; });
  setInput('x');
  assert.equal(getInput(), 'x', '写入本身必须成功');
  assert.equal(goodCalls, 1, '后续订阅者必须仍被通知');
});

test('回归：install → 多次输入 → 退订 的完整生命周期不残留订阅者', () => {
  // 这条对应真实使用：ChatComposer 挂载时订阅，卸载时退订。若退订无效，
  // 每次进出聊天页都会多留一个订阅者，写入时逐个通知它们 ⇒ 幽灵重渲染 + 泄漏。
  __resetInputForTests();
  const offs = [];
  for (let i = 0; i < 5; i += 1) offs.push(subscribe(() => {}));
  assert.equal(__listenerCountForTests(), 5);
  for (const off of offs) off();
  assert.equal(__listenerCountForTests(), 0, '全部退订后不得残留');
  setInput('after');
  assert.equal(getInput(), 'after');
});
