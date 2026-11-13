// 「打开开场白选择器」的跨面板请求通道。
//
// 为什么需要：顶栏的「+」（DesktopApp）与开场白选择器（ChatPane）不在同一棵树里，
// 选择器要读 messagesRef / activeSessionId / setMessages，这些都只有 ChatPane 持有
// （来自 useDesktopChat）。把整套编排提到 DesktopApp 会逼着它向下传一堆 ref。
//
// 做法与 inputStore 同款：模块级小 store，请求方只写、ChatPane 只读并消费一次。
// 「消费」语义是刻意的——请求是**一次性动作**，不是持久状态；若当成布尔量，
// 用户关掉选择器后只要 ChatPane 重渲染就会又弹一次。
export const GREETING_PURPOSE_NEW = 'new';
export const GREETING_PURPOSE_RESELECT = 'reselect';

let pending = '';
const listeners = new Set();

// 请求方（顶栏「+」）：记一次请求并通知订阅者。
export function requestGreetingPicker(purpose = GREETING_PURPOSE_NEW) {
  pending = String(purpose || GREETING_PURPOSE_NEW);
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      // 单个订阅者抛错不得影响其它订阅者，更不得让写入失败。
    }
  }
}

// 消费方（ChatPane）：取出并**清空**。返回 '' 表示没有待处理请求。
export function consumeGreetingPicker() {
  const value = pending;
  pending = '';
  return value;
}

// 只读当前值（不消费）：供渲染期判断是否需要打开，但**不要**用它当开关。
export function peekGreetingPicker() {
  return pending;
}

export function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 仅测试用：模块级单例跨用例会串味。
export function __resetGreetingRequestForTests() {
  pending = '';
  listeners.clear();
}