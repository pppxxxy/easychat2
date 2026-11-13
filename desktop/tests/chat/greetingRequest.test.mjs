// 开场白请求通道（greetingRequest）的行为测试。
//
// 这个 store 只有两条必须成立的性质，两条都对应真实故障形态：
//   · 必须**消费即清**：若当成持久开关，用户关掉选择器后每次 ChatPane 重渲染都会
//     再弹一次（选择器关不掉）；
//   · 订阅者在写入期间抛错不得让请求丢失或让其它订阅者收不到（否则 ChatPane 里
//     一个渲染异常就会让「+」永久失效）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetGreetingRequestForTests,
  consumeGreetingPicker,
  GREETING_PURPOSE_NEW,
  GREETING_PURPOSE_RESELECT,
  peekGreetingPicker,
  requestGreetingPicker,
  subscribe,
} from '../../src/chat/greetingRequest.js';

test('请求可被消费一次，消费后清空（关掉后不会又弹出来）', () => {
  __resetGreetingRequestForTests();
  assert.equal(consumeGreetingPicker(), '', '初始无请求');
  requestGreetingPicker();
  assert.equal(peekGreetingPicker(), GREETING_PURPOSE_NEW);
  assert.equal(consumeGreetingPicker(), GREETING_PURPOSE_NEW);
  assert.equal(consumeGreetingPicker(), '', '第二次消费必须为空');
  assert.equal(peekGreetingPicker(), '');
});

test('reselect 用途会被如实传递（不是一律当新建）', () => {
  __resetGreetingRequestForTests();
  requestGreetingPicker(GREETING_PURPOSE_RESELECT);
  assert.equal(consumeGreetingPicker(), GREETING_PURPOSE_RESELECT);
});

test('空/非法用途回落为 new（选择器必须有确定的行为）', () => {
  __resetGreetingRequestForTests();
  requestGreetingPicker('');
  assert.equal(consumeGreetingPicker(), GREETING_PURPOSE_NEW);
  requestGreetingPicker(null);
  assert.equal(consumeGreetingPicker(), GREETING_PURPOSE_NEW);
});

test('订阅者在请求时被通知；抛错的订阅者不影响其它订阅者', () => {
  __resetGreetingRequestForTests();
  const seen = [];
  const unsubscribeBad = subscribe(() => { throw new Error('boom'); });
  const unsubscribeGood = subscribe(() => { seen.push(peekGreetingPicker()); });
  requestGreetingPicker();
  assert.deepEqual(seen, [GREETING_PURPOSE_NEW], '正常订阅者必须收到通知');
  unsubscribeBad();
  unsubscribeGood();
  requestGreetingPicker();
  assert.deepEqual(seen, [GREETING_PURPOSE_NEW], '退订后不再收到');
});

test('退订函数可重复调用且不报错', () => {
  __resetGreetingRequestForTests();
  const unsubscribe = subscribe(() => {});
  unsubscribe();
  unsubscribe();
  // 非法订阅者直接返回 no-op 退订函数。
  assert.equal(typeof subscribe(null), 'function');
});