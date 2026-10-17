// 聊天输入框的文本：从 React state 改为**外部 store**（2026-10-18，机制 3 / 旧任务书 P0-1）。
//
// 为什么要动它：`input` 此前是 useSessionMessages 里的 useState，而那个 hook 由 ChatScreen
// 调用 ⇒ **每敲一个字符 ChatScreen 就重渲染一次**。实测（脚本统计，非目测）ChatScreen 的
// JSX 里有 31 个子组件标签、其中 28 个未做 memo，且它自己还有 4 个 useCallback 的依赖数组
// 含 input（openFullScreen / 发送包装 / 发送判定 / insertMention），另有 useSessionSwitch 的
// onSwitch / onSwitchGroup 两个回调同样因 input 进依赖而每键重建——一次按键共重建 6 个回调。
//
// 做法：状态放到模块级 store，只有**真正渲染这个值**的组件（ChatComposer）订阅它；
// 宿主在调用期用 getInput() 读取，不订阅 ⇒ 不再因按键重渲染。
//
// 为什么必须是「store + 订阅」而不是「把 state 搬进 ChatComposer」：
//   搬进 ChatComposer 要把它改成非受控输入 + imperative handle，而 @ 提及判定、切换会话
//   清空、草稿回填、全屏编辑回写全都要走 imperative set。store 方案下这些调用点只是把
//   `input` 换成 `getInput()`、`setInput` 换成 store 的 setInput，**草稿与切换逻辑一字不动**。
//
// 关于「只有 ChatComposer 订阅」这条约束（重要，别写成「谁都能订阅」）：
// 一旦有第二个渲染期订阅者出现在 ChatScreen 的渲染路径上，每键重渲染就回来了，
// 这个改造等于白做。宿主需要值的地方一律用 getInput()（调用期读取）。
import { useSyncExternalStore } from 'react';

let current = '';
const listeners = new Set();

// 调用期读取：**不订阅**，因此不引起重渲染。宿主的所有「取值」场景都用它。
export function getInput() {
  return current;
}

// 写入并通知订阅者。返回是否真的发生了变化。
//
// 同值时**不通知**：这与 React useState 的行为一致（Object.is 相同则 bail out，不重渲染）。
// 保留这一条很要紧——`setInput('')` 在「发送后清空」「切会话清空」等路径上会在空输入时
// 被反复调用，若每次都通知，就凭空多出一串无意义的重渲染。
//
// 入参一律归一为字符串：useState 版不归一，`setInput(undefined)` 会让 `input.trim()` 抛错；
// 全部调用点传的都是字符串，归一化是纯防御（且让 TS 之外的调用方也无法把这个值弄坏）。
export function setInput(next) {
  const text = String(next ?? '');
  if (text === current) return false;
  current = text;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      // 一个订阅者抛错不得影响其它订阅者，更不能让写入本身失败（值已经更新了）。
    }
  }
  return true;
}

// 订阅接口：函数引用是模块级的，天然稳定（useSyncExternalStore 要求 subscribe 稳定，
// 否则每次渲染都会重新订阅/退订）。
export function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 订阅版读取：只有用它读取的组件才会在写入时重渲染。目前唯一使用者是 ChatComposer
// （它要把值渲染进 TextInput，并据此决定「发送」「补充指令」两个按钮的可用态）。
export function useInput() {
  // 第三个参数是 getServerSnapshot：RN 不做 SSR，传同一个读取函数即可。
  return useSyncExternalStore(subscribe, getInput, getInput);
}

// 仅测试用：把 store 复位。模块级单例跨用例会串味，测试必须在每例开头调用。
export function __resetInputForTests() {
  current = '';
  listeners.clear();
}

// 仅测试用：读订阅者数量，用于断言「卸载后确实退订了」。
export function __listenerCountForTests() {
  return listeners.size;
}
