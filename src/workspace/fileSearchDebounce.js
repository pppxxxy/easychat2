// FEAT-AC12 P1：文件面板搜索的**防抖调度**（纯逻辑，零 React 依赖 → Node 直测）。
//
// 为什么需要它（对基线核实的两个每击键成本）：
//   ① 全量加载在**首个字符**就触发：搜索框 onChangeText 里第一个非空字符立刻发起
//      全树 refresh({ full: true })——恰是 AC12 P0-1 刚优化掉的重 IO（大工作区下
//      打「buildTree」，按第一个 b 就吃一次全树 walk）。
//   ② 每击键同步全量扫描 + 重渲：fileQuery 直接进 searchWorkspaceFiles 的 useMemo
//      依赖，每个字符 = 全量路径线性扫 + 排序 + 最多 50 行结果重渲，无节流。
//
// 目标：给**消费路径**（扫描 / 渲染 / 全量加载）加防抖；输入框本体保持即时受控
//（打字手感不回退——这也是本仓反复强调的「别为了性能牺牲手感」）。
//
// 为什么做成「注入时钟的对象」而不是一个 hook：仓库没有 react-test-renderer，
// hook 在 Node 里跑不起来。而本任务的四条验收判据（连发只消费一次 / 超窗口各消费一次 /
// 清空立即生效 / 计时器可清理无悬挂）**必须能被直接断言**，所以时钟与提交回调都从外部
// 注入——这四条因此全部能在 Node 里真跑（见 tests/workspaceSearchDebounce.test.mjs）。

// 窗口长度与依据：人类连续击键间隔普遍 < 150ms，300ms 是「已经停手」的常用判据。
// 千万不要拍脑袋改成 0（等于没有防抖）或 1000（打完要等一秒才出结果，手感明显发滞）。
export const SEARCH_DEBOUNCE_MS = 300;

// push() 的判定结果（供调用方/测试区分两条路径，不靠时序猜）。
export const DEBOUNCE_DECISIONS = Object.freeze({
  // 空值：立即提交，不等窗口（清空必须零延迟回目录树，不能先闪一下旧结果）
  IMMEDIATE: 'immediate',
  // 非空：排入窗口，窗口结束后提交（窗口内再次输入会重置窗口）
  SCHEDULED: 'scheduled',
});

/**
 * 「是否该把单层清单升级成全量」的判据（纯函数 → 可行为测试）。
 *
 * 为什么单独抽出来：这条判据原先散在搜索框的 onChangeText 里（`text.trim() &&
 * !filesRef.current.full`），只能靠**源码字符串**断言——而注入验证证明了那种断言的
 * 弱点：把调用改成死代码（`const load = null; load(...)`）之后字符串仍在，测试照样全绿。
 * 抽成纯函数之后，「空查询不拉 / 已全量不重复拉 / 非空才拉」三条都能真跑。
 *
 * 时机仍由调用方保证：本函数只管「该不该」，**窗口结束后才调用**是 hook 的职责
 *（逐键触发正是 AC12 P0-1 刚优化掉的那笔重 IO）。
 *
 * @param {{ query?: string, alreadyFull?: boolean }} args
 * @returns {boolean}
 */
export function shouldLoadFullList({ query, alreadyFull } = {}) {
  if (alreadyFull === true) return false;
  return String(query === undefined || query === null ? '' : query).trim() !== '';
}

/**
 * 创建一个防抖调度器。
 *
 * 契约：
 *  · `push(value)`：非空 → 重置窗口并在窗口结束后 `commit(value)`；
 *    空串 → **立即** `commit('')`（清空不等窗口）；返回 DEBOUNCE_DECISIONS 之一。
 *  · 窗口内多次 push 只提交**最后一次**的值（前一次的定时器被取消）。
 *  · `cancel()`：取消挂起的提交（组件卸载时必须调，否则计时器泄漏）。
 *  · `commit` 抛错不影响调度器状态（调用方是 UI setState，正常不会抛；
 *    真抛了也不该让后续输入失去响应）。
 *
 * @param {object} [options]
 * @param {number} [options.delayMs] 窗口长度，默认 SEARCH_DEBOUNCE_MS
 * @param {(value: string) => void} [options.commit] 窗口结束后的提交回调
 * @param {(fn: Function, ms: number) => *} [options.setTimer] 注入时钟（测试传假时钟）
 * @param {(id: *) => void} [options.clearTimer] 注入时钟的取消函数
 */
export function createSearchDebouncer({
  delayMs = SEARCH_DEBOUNCE_MS,
  commit,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = id => clearTimeout(id),
} = {}) {
  const window = Number.isFinite(Number(delayMs)) && Number(delayMs) >= 0
    ? Math.floor(Number(delayMs))
    : SEARCH_DEBOUNCE_MS;
  let timer = null;
  let pending = '';

  function clear() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function fire(value) {
    timer = null;
    pending = '';
    if (typeof commit === 'function') commit(value);
  }

  return {
    push(value) {
      const next = String(value === undefined || value === null ? '' : value);
      // 先撤掉上一次的挂起：窗口内连续输入只该提交最后一次。
      clear();
      if (next === '') {
        // 清空立即生效：等窗口会先显示旧结果再跳回目录树，用户看到的是「闪一下」。
        fire('');
        return DEBOUNCE_DECISIONS.IMMEDIATE;
      }
      pending = next;
      timer = setTimer(() => fire(next), window);
      return DEBOUNCE_DECISIONS.SCHEDULED;
    },
    /** 取消挂起的提交（卸载/换角色时必须调）。返回值便于测试断言「确实取消了」。 */
    cancel() {
      const had = timer !== null;
      clear();
      pending = '';
      return had;
    },
    /** 是否有挂起的定时器（测试用：验证「无悬挂计时器」）。 */
    hasPendingTimer: () => timer !== null,
    /** 挂起待提交的值（空串 = 无挂起）。 */
    pendingValue: () => pending,
    windowMs: window,
  };
}
