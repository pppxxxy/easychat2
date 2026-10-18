// 输入框「发送后出现 function (a0) { [bytecode] }」的回归守卫（2026-10-18 P0）。
//
// 用户实测：发完言，输入框突然多出一段 `function (a0) { [bytecode] }`，不是他打的字。
//
// 根因链（对 1f56c99 核实）：
//   useChatSend 迁移到 inputStore 时漏改了一处 `setInput(current => {...})`（函数式更新），
//   而 inputStore.setInput 当时只做 `String(next ?? '')` —— 函数被 String() 归一成**源码字符串**，
//   Hermes 下 `(a0) => {}`.toString() 恰好是 `function (a0) { [bytecode] }`（a0 是形参名）。
//   该调用在发送流程里，所以「一发消息就出现」。
//
// 两道防线（本文件全测）：
//   ① 调用点改成调用期读取 + 值传递（不再有函数式用法）；
//   ② inputStore 支持函数式更新 —— 就算将来又写出 setInput(fn)，也按 React 语义正确计算，
//      而不是把函数变成字符串。这条是「写错调用点」这类失误的兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  __resetInputForTests,
  getInput,
  setInput,
  subscribe,
} from '../src/chat/inputStore.js';
import { clearInputAfterSend } from '../src/chat/sendInputCleanup.js';

// Hermes 风格：函数被 String() 之后的形态（正是用户看到的那段）
const BYTECODE_SHAPE = /function\s*\(\s*\w*\s*\)\s*\{\s*\[bytecode\]\s*\}/;

test('P0 核心：setInput(函数) 不得把函数源码写进 store', () => {
  __resetInputForTests();
  setInput('原文本');

  // 这正是曾经出事的调用形态
  setInput(current => (current === '原文本' ? '' : current));

  const value = getInput();
  assert.equal(value, '', '函数式更新应按 React 语义求值（这里返回空串）');
  assert.equal(
    BYTECODE_SHAPE.test(value),
    false,
    `store 里出现了函数源码字符串（用户看到的就是这段）：${value}`
  );
  assert.equal(typeof value, 'string', 'store 的值永远是字符串');
});

test('函数式更新与 React setState 同语义：入参是当前值', () => {
  __resetInputForTests();
  setInput('abc');

  const seen = [];
  setInput(current => {
    seen.push(current);
    return `${current}d`;
  });
  assert.deepEqual(seen, ['abc'], '更新函数拿到的必须是当前值');
  assert.equal(getInput(), 'abcd');

  // 连续两次：第二次应看到第一次的结果（顺序正确，不是都基于旧值）
  setInput(current => `${current}e`);
  assert.equal(getInput(), 'abcde');
});

test('函数式更新返回同值时不清算、不通知（bail-out 语义保持）', () => {
  __resetInputForTests();
  setInput('same');
  let notified = 0;
  const unsubscribe = subscribe(() => { notified += 1; });

  assert.equal(setInput(current => current), false, '同值应返回 false');
  assert.equal(notified, 0, '同值不该通知订阅者（否则每轮白重渲染）');

  assert.equal(setInput(current => `${current}!`), true);
  assert.equal(notified, 1);
  unsubscribe();
  __resetInputForTests();
});

test('函数式更新返回 null/undefined 时归一为空串（不写出 "null"/"undefined"）', () => {
  __resetInputForTests();
  setInput('x');
  setInput(() => undefined);
  assert.equal(getInput(), '', 'undefined 归一为空串');
  setInput('y');
  setInput(() => null);
  assert.equal(getInput(), '', 'null 归一为空串');

  // 反向守卫：绝不允许出现字符串化后的 null/undefined
  setInput('z');
  setInput(() => null);
  assert.notEqual(getInput(), 'null');
  assert.notEqual(getInput(), 'undefined');
});

test('值传递路径不受影响（绝大多数调用点都是这种）', () => {
  __resetInputForTests();
  setInput('hello');
  assert.equal(getInput(), 'hello');
  setInput('');
  assert.equal(getInput(), '');
  setInput(undefined);
  assert.equal(getInput(), '');
  setInput(123);
  assert.equal(getInput(), '123', '非字符串归一为字符串');
});

// ---- 源码契约：污染源那一处必须真的改成调用期读取 ----

test('源码契约：清空逻辑外提后仍走调用期读取 + 值传递', () => {
  const raw = fs.readFileSync(path.resolve('src/chat/useChatSend.js'), 'utf8');
  // 先剥掉注释：说明文字里会引用 `setInput(current => ...)` 这种反例，
  // 不剥就会把「注释里提到它」误当成「代码里用了它」（这条守卫第一版就栽在这）。
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
  const functionalCalls = [...source.matchAll(/setInput\(\s*(\(|(?:async\s*)?(?:prev|current|state|old|last)\s*=>)/g)];
  assert.deepEqual(
    functionalCalls.map(match => match[0]),
    [],
    'useChatSend 里不得再出现函数式 setInput（store 不是 useState；曾因这处漏改把函数 String 成 bytecode）'
  );
  // 清空逻辑已外提到 sendInputCleanup.js（为守 1960 行基线），调用点必须真的是它
  assert.match(source, /clearInputAfterSend\(/, '必须调用外提后的清空函数');
});

test('源码契约：外提的清空模块本身用调用期读取 + 值传递', () => {
  const cleanup = fs.readFileSync(path.resolve('src/chat/sendInputCleanup.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
  assert.match(cleanup, /getInput\(\)\s*!==\s*rawText/, '必须用调用期读取做防竞态判断');
  assert.match(cleanup, /setInput\(''\)/, '必须传值写入（不是函数）');
  assert.equal(
    /setInput\(\s*(\(|\w+\s*=>)/.test(cleanup),
    false,
    '外提模块里也不得出现函数式 setInput'
  );
});

// ---- 外提模块的行为测试（不只是源码契约）----

test('clearInputAfterSend：输入未变 → 清空并清草稿', () => {
  let input = '要发的字';
  const draftCalls = [];
  const cleared = clearInputAfterSend({
    rawText: '要发的字',
    getInput: () => input,
    setInput: value => { input = value; },
    draftTextRef: { current: '要发的字' },
    persistDraftNow: (sessionId, text) => draftCalls.push([sessionId, text]),
    sessionId: 's1',
  });
  assert.equal(cleared, true);
  assert.equal(input, '', '输入应被清空');
  assert.deepEqual(draftCalls, [['s1', '']], '草稿应被写成空串');
});

test('clearInputAfterSend：用户已改动输入 → 一个字节都不动（防竞态核心）', () => {
  let input = '用户新打的话';
  const draftCalls = [];
  const draftRef = { current: '要发的字' };
  const cleared = clearInputAfterSend({
    rawText: '要发的字',
    getInput: () => input,
    setInput: value => { input = value; },
    draftTextRef: draftRef,
    persistDraftNow: (sessionId, text) => draftCalls.push([sessionId, text]),
    sessionId: 's1',
  });
  assert.equal(cleared, false, '不该清空');
  assert.equal(input, '用户新打的话', '用户新输入必须原样保留');
  assert.equal(draftRef.current, '要发的字', '草稿也不该被动');
  assert.deepEqual(draftCalls, [], '不该写草稿');
});

test('clearInputAfterSend：永不把函数写进输入（本模块的历史教训）', () => {
  let input = 'x';
  clearInputAfterSend({
    rawText: 'x',
    getInput: () => input,
    setInput: value => { input = value; },
    draftTextRef: { current: '' },
    persistDraftNow: () => {},
    sessionId: 's1',
  });
  assert.equal(typeof input, 'string', '写入的必须始终是字符串');
  assert.equal(BYTECODE_SHAPE.test(input), false);
});

test('源码契约：inputStore 仍然只有一个渲染期订阅者契约（ChatComposer）', () => {
  const composer = fs.readFileSync(path.resolve('src/chat/ChatComposer.js'), 'utf8');
  assert.match(composer, /useInput\(\)/, 'ChatComposer 必须是订阅方');
  const sendHook = fs.readFileSync(path.resolve('src/chat/useChatSend.js'), 'utf8');
  assert.equal(/useInput\(\)/.test(sendHook), false, 'useChatSend 不得订阅输入（只调用期读取）');
});
