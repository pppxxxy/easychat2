// 输入下沉的**渲染计数**验证（机制 3 / 旧任务书 P0-1）。
//
// 这个文件回答的是之前只能靠源码契约间接保证的那个问题：
//   「敲一个字符，到底有多少组件重渲染？」
// 之前没法测，是因为仓库里没有渲染器。现在装了 react-test-renderer（devDependency，
// 与 react 同版本 19.1.0），可以在 Node 里真实渲染 React 树并数渲染次数。
//
// 为什么不用 RN 组件渲染真实的 ChatScreen/ChatComposer：`react-native` 在 Node 里加载不了
// （源码是 Flow + JSX，且依赖 TurboModule 原生绑定），要跑起来需要整套 jest-expo 级打桩。
// 本文件改为渲染**等价结构的普通 React 组件树**（宿主 + 订阅者 + 28 个未 memo 的子组件，
// 与 ChatScreen 的真实形状一致），用的却是**真实的 inputStore**。
// 也就是说：机制被真实验证，接线（谁调用了它）仍由 tests/inputSinking.test.mjs 的源码契约守。
//
// 判据（这三条合起来才是「改造生效」）：
//   ① 写 store 后，订阅者必须重渲染，且读到新值 —— 否则输入框会显示不出字 / 回退旧值；
//   ② 只调用期读取的宿主**不得**重渲染 —— 否则改造白做；
//   ③ 宿主不重渲染 ⇒ 它下面那 28 个未 memo 的子组件也一个都不重渲染 —— 这才是收益本体。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import React from 'react';

import { __resetInputForTests, getInput, setInput, useInput } from '../src/chat/inputStore.js';

const require = createRequire(import.meta.url);
const TestRenderer = require('react-test-renderer');
const act = TestRenderer.act || React.act;

// 用真实 store 搭一棵「形状与 ChatScreen 一致」的树：
//   Host（等价 ChatScreen：调用期读取、不订阅）
//     └─ 28 个未 memo 的子组件（等价 ChatScreen 里那 28 个未 memo 的组件）
//   Composer（等价 ChatComposer：订阅）
function buildTree() {
  const counts = { host: 0, composer: 0, children: 0 };
  const childValues = [];

  function Child() {
    counts.children += 1;
    return React.createElement('child');
  }

  function Host() {
    counts.host += 1;
    // 调用期读取：与 ChatScreen 里 getInput() 的用法一致（不进渲染输出、不订阅）。
    const peek = getInput();
    return React.createElement(
      'host',
      { peek },
      Array.from({ length: 28 }, (_, i) => React.createElement(Child, { key: i }))
    );
  }

  function Composer() {
    counts.composer += 1;
    const value = useInput();
    childValues.push(value);
    return React.createElement('composer', { value });
  }

  function App() {
    return React.createElement(React.Fragment, null,
      React.createElement(Host),
      React.createElement(Composer));
  }

  return { App, counts, childValues };
}

test('敲一个字符：只有输入区重渲染，宿主与它下面 28 个未 memo 子组件都不动', () => {
  __resetInputForTests();
  const { App, counts, childValues } = buildTree();
  let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(App)); });

  const afterMount = { ...counts };
  assert.equal(afterMount.host, 1, '宿主挂载渲染一次');
  assert.equal(afterMount.composer, 1, '输入区挂载渲染一次');
  assert.equal(afterMount.children, 28, '28 个子组件各渲染一次');

  // 敲一个字符
  act(() => { setInput('你'); });

  assert.equal(counts.composer, 2, '订阅者必须重渲染（否则输入框显示不出字）');
  assert.equal(childValues[childValues.length - 1], '你', '订阅者必须读到新值（防受控输入回退旧值）');
  assert.equal(counts.host, 1, '宿主不得因输入变化而重渲染（这是本改造的全部意义）');
  assert.equal(counts.children, 28, '宿主没重渲染 ⇒ 28 个未 memo 子组件一个都不该重渲染');

  // 再敲几个字符：每次只多渲染输入区一次
  act(() => { setInput('你好'); });
  act(() => { setInput('你好世'); });
  assert.equal(counts.composer, 4);
  assert.equal(counts.host, 1);
  assert.equal(counts.children, 28);
  renderer.unmount();
});

test('同值写入不引发任何重渲染（与 useState 的 bail-out 一致）', () => {
  __resetInputForTests();
  const { App, counts } = buildTree();
  let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(App)); });
  assert.equal(counts.composer, 1);

  act(() => { setInput('abc'); });
  assert.equal(counts.composer, 2);
  // 发送后清空、切会话清空等路径会在值已经相同的情况下重复写——
  // 若每次都通知，就凭空多出一串无意义重渲染。
  act(() => { setInput('abc'); });
  act(() => { setInput('abc'); });
  assert.equal(counts.composer, 2, '同值重复写不得触发重渲染');
  act(() => { setInput(''); });
  assert.equal(counts.composer, 3, '真的变了才渲染');
  renderer.unmount();
});

test('卸载后写入不再触发任何渲染（退订有效，无幽灵重渲染）', () => {
  __resetInputForTests();
  const { App, counts } = buildTree();
  let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(App)); });
  const before = { ...counts };
  act(() => { renderer.unmount(); });
  act(() => { setInput('卸载之后'); });
  assert.equal(counts.composer, before.composer, '卸载后不得再渲染');
  assert.equal(counts.host, before.host);
  assert.equal(getInput(), '卸载之后', '写入本身仍然生效（store 是模块级的）');
});

test('对照：如果宿主也订阅，Q 个字符就会带动 28 个子组件重渲染（本测试的负向基准）', () => {
  // 这条不是测实现，而是**证明上面的测试真的在测东西**：
  // 把宿主换成订阅版，同样的操作会让 children 渲染次数成倍增长。
  // 它同时说明为什么「宿主调用期读取」这个约束不能破——破了就是这个数量级。
  __resetInputForTests();
  const counts = { host: 0, children: 0 };
  function Child() {
    counts.children += 1;
    return React.createElement('child');
  }
  function SubscribingHost() {
    counts.host += 1;
    useInput(); // ← 宿主订阅（错误写法）
    return React.createElement(
      'host',
      null,
      Array.from({ length: 28 }, (_, i) => React.createElement(Child, { key: i }))
    );
  }
  let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(SubscribingHost)); });
  act(() => { setInput('a'); });
  act(() => { setInput('ab'); });
  act(() => { setInput('abc'); });
  assert.equal(counts.host, 4, '订阅版宿主：挂载 + 3 次输入 = 4 次');
  assert.equal(counts.children, 4 * 28, '订阅版宿主：28 个子组件被连带重渲染 4 轮（正是改造前的情形）');
  renderer.unmount();
});
