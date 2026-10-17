// 输入文本下沉的接线守卫（机制 3 / 旧任务书 P0-1）。
//
// 这次改造的全部意义是一句话：**只有 ChatComposer 订阅输入文本，宿主 ChatScreen 不订阅**。
// 只重渲染输入区、不重渲染整个聊天页（31 个子组件里 28 个未 memo）。
//
// 而这条不变量非常容易被下一次「顺手」改回去——只要有人在宿主里读一次 input、或把
// input 当成 prop 传下去，每键重渲染就原样回来，而**功能测试完全看不出来**（界面一切正常，
// 只是又变卡了）。所以这里用源码契约把它钉死。
//
// 为什么用源码断言而不是行为断言：本仓库没有 RN 渲染器（AGENTS.md 约定的既有边界），
// 无法在 Node 里渲染 ChatScreen/ChatComposer 并数重渲染次数。按仓库惯例，
// 源码断言只用于钉住这类「已修复、且漏了会静默失效」的回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = rel => fs.readFileSync(path.resolve(rel), 'utf8');

const CHAT_SCREEN = read('src/ChatScreen.js');
const COMPOSER = read('src/chat/ChatComposer.js');
const SESSION_MESSAGES = read('src/chat/useSessionMessages.js');
const SESSION_SWITCH = read('src/chat/useSessionSwitch.js');
const STORE = read('src/chat/inputStore.js');

// 截出 <ChatComposer ... /> 这一段（按标签配对找结尾，不用固定字符窗口）。
// ⚠️ 为什么不能用 {0,400} 这种固定窗口：我第一版就是那么写的，注入验证时**没红**——
// 注入进去的 input={...} 恰好落在那 400 字符之外。窗口太窄会让守卫变成假绿，
// 这比没有守卫更糟（它给人已经守住了的错觉）。
function chatComposerCall() {
  const start = CHAT_SCREEN.indexOf('<ChatComposer');
  assert.ok(start >= 0, '必须仍渲染 ChatComposer');
  const end = CHAT_SCREEN.indexOf('/>', start);
  assert.ok(end > start, 'ChatComposer 必须是自闭合标签');
  return CHAT_SCREEN.slice(start, end);
}

test('宿主（ChatScreen）不得订阅输入文本：既不读 input 变量，也不把它当 prop 传下去', () => {
  // 1) 解构里不能出现任何名为 input 的绑定（`input,` 与 `input: xxx,` 两种写法都要挡住）。
  const destructureBindings = CHAT_SCREEN
    .split('\n')
    .filter(line => /^\s*input\s*[,:]\s*/.test(line) && !/^\s*\/\//.test(line));
  assert.deepEqual(
    destructureBindings,
    [],
    `ChatScreen 不得绑定名为 input 的值（那是订阅；用 getInput() 调用期读）：\n${destructureBindings.join('\n')}`
  );
  // 2) 不得把输入文本作为 prop 传给 ChatComposer（含 input={...} 与 {...{input}} 这类）。
  const composerCall = chatComposerCall();
  assert.equal(
    /\binput\s*=/.test(composerCall),
    false,
    `不得把 input 作为 prop 传给 ChatComposer（它自己订阅；宿主传值会废除本改造）：\n${composerCall.slice(0, 300)}`
  );
  // 3) 宿主用到输入文本的地方必须是调用期读取。
  assert.ok(CHAT_SCREEN.includes('getInput()'), '宿主取值必须走 getInput()');
  // 4) 依赖数组里不得残留 input（否则 6 个回调会被每个按键重建）。
  const depsWithInput = CHAT_SCREEN
    .split('\n')
    .filter(line => /^\s*\}, \[/.test(line) && /\binput\b/.test(line));
  assert.deepEqual(depsWithInput, [], `这些依赖数组仍含 input（每键重建回调）：\n${depsWithInput.join('\n')}`);
});

test('只有 ChatComposer 订阅 store（其它模块一律调用期读取）', () => {
  // 订阅入口是 useInput；它只应出现在 ChatComposer 里。
  assert.ok(COMPOSER.includes('useInput()'), 'ChatComposer 必须订阅（否则输入框显示不出字）');
  for (const [name, source] of [
    ['ChatScreen', CHAT_SCREEN],
    ['useSessionMessages', SESSION_MESSAGES],
    ['useSessionSwitch', SESSION_SWITCH],
  ]) {
    assert.equal(
      /\buseInput\b/.test(source),
      false,
      `${name} 不得订阅输入文本（只应调用期读取）`
    );
  }
  // store 自己导出 useInput，供订阅方使用。
  assert.ok(STORE.includes('export function useInput'), 'store 必须导出 useInput');
  assert.ok(STORE.includes('useSyncExternalStore'), '订阅必须走 useSyncExternalStore');
});

test('输入文本的真源唯一：useSessionMessages 不再持有 useState', () => {
  // useSessionMessages 是写入方（onInputChange / 草稿回填 / 发送后清空），
  // 它自己**不得**再存一份 input state——两份真源必然漂移。
  assert.equal(
    /const \[input, setInput\] = useState/.test(SESSION_MESSAGES),
    false,
    'useSessionMessages 不得再用 useState 存 input（真源在 store）'
  );
  assert.ok(
    SESSION_MESSAGES.includes("from './inputStore.js'"),
    'useSessionMessages 必须从 store 取 setInput'
  );
  assert.ok(
    SESSION_MESSAGES.includes('getInput,'),
    'useSessionMessages 必须把 getInput 暴露给宿主（宿主用它调用期读取）'
  );
});

test('useSessionSwitch：切换回调的依赖数组不得含 input（否则每键重建 onSwitch/onSwitchGroup）', () => {
  // 判据只看两件事，避免误伤：
  //   ① 函数参数解构里不得有 input（那会进依赖数组）——参数区的缩进是 2 空格；
  //   ② 依赖数组 [ ... ] 里不得出现裸 input。
  // 注意**不能**用「任何行首的 input:」来判：draft 对象里的 `input: getInput()` 是
  // 合法字段（快照自己的属性名正好叫 input），我第一版就是这么误伤的。
  const paramBlock = SESSION_SWITCH.slice(
    SESSION_SWITCH.indexOf('export default function useSessionSwitch({'),
    SESSION_SWITCH.indexOf('}) {', SESSION_SWITCH.indexOf('export default function useSessionSwitch({'))
  );
  assert.equal(
    /^\s{2}input\s*,\s*$/m.test(paramBlock),
    false,
    'useSessionSwitch 的参数里不得有 input（它会进依赖数组，导致每键重建回调）'
  );
  assert.ok(SESSION_SWITCH.includes('getInput()'), '切换时用 getInput() 做回滚快照');
  const depsWithInput = SESSION_SWITCH
    .split('\n')
    .filter(line => /^\s*\}, \[/.test(line) && /\binput\b/.test(line));
  assert.deepEqual(depsWithInput, [], `这些依赖数组仍含 input：\n${depsWithInput.join('\n')}`);
});

test('store 的契约：调用期读取不订阅、同值不通知（宿主不重渲染的前提）', () => {
  // 这两条是「宿主不重渲染」赖以成立的性质，由 tests/inputStore.test.mjs 做行为断言，
  // 这里只钉住实现里确实没有把 getInput 写成订阅、也没有无条件通知。
  assert.equal(
    /getInput[\s\S]{0,200}?subscribe\(/.test(STORE),
    false,
    'getInput 不得顺手注册订阅者'
  );
  assert.ok(
    STORE.includes('if (text === current) return false;'),
    '同值写入必须提前返回（与 useState 的 bail-out 一致，避免无意义重渲染）'
  );
});
