// FEAT-AC8 P0-C：**线程变更通知**（app 级 → 面板刷新）。
//
// 事故（用户 00:35 复测）：悬浮窗工作区回合往线程里写了条目，但工作区「看屏幕」面板
// 只在**挂载时**与**开/关悬浮窗时**刷新列表 ⇒ 用户看到的是回合开始前的旧状态，
// 于是「（暂无内容）」到底是「真没写入」还是「UI 陈旧」无法分辨
//（任务书 §四 明确把这一点标为「真机实证缺失」，验收第 0 步专为分辨它而设）。
//
// 修法：回合结束后由 app 级发一条 JS 事件，**面板在场即刷新**。
//
// 为什么用「模块级订阅表」而不是 DeviceEventEmitter：这条通知是**纯 JS 内部**的
// （发起方是 JS 的回合执行器，接收方是 JS 的 React 面板），不经过原生；
// 走 DeviceEventEmitter 反而要新增一个原生无关的事件名，且原生层会多一次空转发。
// 订阅表用 Set，退订是幂等的（React 严格模式会双调用 effect）。
//
// 边界（如实）：面板**不在场**时这条通知无人接收——那没关系，
// 面板挂载时本来就会查一次（既有行为），不会漏。

const listeners = new Set();

/**
 * 订阅线程变更通知。返回退订函数（幂等：重复调用无副作用）。
 */
export function subscribeThreadsChanged(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * 广播「线程已变更」。**永不抛**（通知失败不该影响回合结果）。
 * 单个订阅者抛错不阻断其余订阅者（与仓内 safeCallback 同口径）。
 */
export function notifyThreadsChanged() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      // 一个订阅者坏了不影响别的。
    }
  }
}

/** 测试可见：当前订阅数（仅测试用）。 */
export function __threadsChangedListenerCount() {
  return listeners.size;
}

/** 测试可见：清空订阅（仅测试用）。 */
export function __resetThreadsChanged() {
  listeners.clear();
}
