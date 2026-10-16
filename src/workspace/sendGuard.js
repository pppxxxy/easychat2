// FEAT-AC12 P0-2：发送防抖（纯逻辑，零 RN 依赖 → Node 直测）。
//
// 事故（用户截图 #462）：三条一模一样的「帮我拉取 easychat2」排在一起，而日志
// 同时段**零 turn-start**——消息落了库，回合一个都没启动。
//
// 为什么 `if (sending)` 守卫形同虚设：`sending` 是 React **state**，而 setState 是
// 异步批处理的。用户连点（或 JS 正忙导致批处理延迟）时，第一次点击**还没**把 state
// 翻成 true，后续点击就全部穿过了守卫。
//
// 修法（任务书 §二 P0-2）：
//   ① **ref 互斥锁**——同步翻位，与 React 的批处理无关。state 退回只管 UI 显示；
//   ② **相同文本短窗去重**——3 秒内重复提交同一内容时明确提示并丢弃，**不静默**
//      （静默丢弃会让用户以为"点了但没反应"，那正是本轮要消灭的观感）。
//
// 为什么做成独立纯模块：ChatPanel 在 Node 里进不来（react-native Flow 语法），
// 而这两条判定值得被**直接**断言（阈值、边界、并发语义）。留在组件里只能靠源码
// 正则——本仓反复踩过那种断言会空转（注入验证时看不出来）。

export const SEND_DEDUP_WINDOW_MS = 3000;

// 判定结果。'ok' 之外都是「不接受本次发送」，但**原因不同**：
//   · 'in-flight'：已有一轮在跑——调用方走 Steering（中途补充指令）或直接忽略；
//   · 'duplicate'：刚刚发过同样的内容——调用方要给用户一句明确提示。
export const SEND_DECISIONS = Object.freeze({
  OK: 'ok',
  IN_FLIGHT: 'in-flight',
  DUPLICATE: 'duplicate',
});

/**
 * 归一待发送文本（判定用的指纹）。
 *
 * 折叠空白（含全角空格）+ trim：用户在卡顿时急着点是「同一条消息」，
 * 多打一个空格不该被当成新消息放行。
 * 大小写**不**折叠——「GitHub」与「github」在自然语言里可能是不同意图。
 */
export function normalizeSendText(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
}

/**
 * 创建一个发送闸门。调用方持有实例（ChatPanel 放 ref 里）。
 *
 * 用法：
 *   const decision = gate.begin(text);
 *   if (decision !== SEND_DECISIONS.OK) { …提示/忽略…; return; }
 *   try { …跑回合… } finally { gate.end(); }
 *
 * ⚠️ `end()` 必须在**每一条**返回路径上调用（含提前 return 的错误分支）——
 * 漏一条就会把闸门永久锁死（用户之后再也发不出消息）。这条纪律有测试钉住。
 */
export function createSendGate({ windowMs = SEND_DEDUP_WINDOW_MS } = {}) {
  const window = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0
    ? Math.floor(Number(windowMs))
    : SEND_DEDUP_WINDOW_MS;
  // 同步的 in-flight 标记（就是「用 ref 当锁」的那把锁）。
  let inFlight = false;
  // 上一次**被接受**的发送（指纹 + 时刻）。
  let lastText = '';
  let lastAt = 0;

  function begin(text, now = Date.now()) {
    if (inFlight) return SEND_DECISIONS.IN_FLIGHT;
    const fingerprint = normalizeSendText(text);
    // 空文本不参与去重（空发送在调用方就被挡掉了；这里不擅自放行也不误判）。
    if (fingerprint && fingerprint === lastText && now - lastAt < window) {
      return SEND_DECISIONS.DUPLICATE;
    }
    inFlight = true;
    // 只记**被接受**的发送：被丢弃的那几次不该刷新时间窗
    //（否则用户连点会不断把窗口推后，正常重试也会被判重复）。
    if (fingerprint) {
      lastText = fingerprint;
      lastAt = now;
    }
    return SEND_DECISIONS.OK;
  }

  function end() {
    inFlight = false;
  }

  return {
    begin,
    end,
    isInFlight: () => inFlight,
    /** 测试用：读上一次被接受的发送（不暴露可变内部状态）。 */
    lastAccepted: () => ({ text: lastText, at: lastAt }),
    windowMs: window,
  };
}
