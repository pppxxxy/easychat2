// R4：拉取所有权上提到**模块级单例**（Q3「切标签 = 中断」的实测结论修正）。
//
// 事实核验（main，含 R0/R1）：切标签并不会杀死写入循环——循环活在组件闭包里，
// store 是屏幕级的，卸载只翻 mountedRef。用户看到的「中断」是**失明**：
//   ① 窄屏是条件渲染（WorkspaceScreen 切领域 = GithubPanel 整个卸载），
//      进度/忙碌态是 hook 局部 state，重挂载即归零 → 界面显示「没在拉取」；
//   ② 切回来时文件列表只有已写完的部分（残缺中间态）→ 观感上是「断了」。
// 另有一个**真实风险**：重入守卫 `if (pullBusy) return` 同样是局部 state，
// 重挂载归零后可以再点一次 → 两个写入循环并发跑同一个 store（batch 互相踩）。
//
// 所以把「谁在拉、进度多少、要不要取消」从可卸载的面板上提到这里：
// 面板只是订阅者（useSyncExternalStore），卸载不带走任何状态；running 是
// 模块级标志，重挂载后仍然拦得住第二次点击。锁屏才是真中断源（R0-3 已接 KeepAwake）。
//
// 本模块零 RN 依赖（Node 直测：状态机 / 订阅退订 / 取消语义 / 双写拒绝）。

// 面板挂载计数（模块级，不进 state：避免挂载/卸载本身触发订阅者重渲染）。
let attachedPanels = 0;

let state = {
  running: false,
  progress: { done: 0, total: 0 },
  notice: '',
  eta: 0,
  cancelRequested: false,
  startedAt: 0,
  // 上一次拉取的收尾摘要（诊断用：Q3 要区分「失明」还是「真死」）。
  lastResult: null,
  // 面板不在场时完成的拉取——重挂载后据此如实告知「它其实跑完了」。
  finishedWhileAway: null,
};

const listeners = new Set();

function emit(patch) {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      // 订阅者异常不得影响拉取主流程（旁路机制）。
    }
  }
}

export function getPullState() {
  return state;
}

export function subscribePull(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// 面板挂载/卸载：只动计数，不动 state（不会引起重渲染循环）。
export function attachPullPanel() {
  attachedPanels += 1;
  return () => { attachedPanels = Math.max(0, attachedPanels - 1); };
}

export function pullPanelAttached() {
  return attachedPanels > 0;
}

// 开始一次拉取：**双写保护在这里**——已有循环在跑就拒绝（返回 false），
// 调用方据此提示「已在拉取中」，而不是静默 return 让用户以为没反应。
export function beginPull({ at = Date.now() } = {}) {
  if (state.running) return false;
  emit({
    running: true,
    progress: { done: 0, total: 0 },
    notice: '',
    eta: 0,
    cancelRequested: false,
    startedAt: at,
    finishedWhileAway: null,
  });
  return true;
}

// 收尾（成功/失败/取消都走它）：返回摘要，并把「面板不在场时完成」记下来。
export function endPull({ result = 'unknown', written = 0, at = Date.now() } = {}) {
  const startedAt = state.startedAt || at;
  const summary = {
    result,
    written,
    startedAt,
    endedAt: at,
    durationMs: Math.max(0, at - startedAt),
    panelAttached: pullPanelAttached(),
  };
  emit({
    running: false,
    progress: { done: 0, total: 0 },
    eta: 0,
    cancelRequested: false,
    lastResult: summary,
    finishedWhileAway: summary.panelAttached ? null : summary,
  });
  return summary;
}

export function setPullProgress(progress, eta = 0) {
  const done = Math.max(0, Math.floor(Number(progress && progress.done) || 0));
  const total = Math.max(0, Math.floor(Number(progress && progress.total) || 0));
  emit({ progress: { done, total }, eta: Math.max(0, Math.round(Number(eta) || 0)) });
}

export function setPullNotice(notice) {
  emit({ notice: String(notice || '') });
}

// 取消按钮：只在真正跑着的时候置位（幂等；循环到下一个检查点自行抛出）。
export function requestPullCancel() {
  if (!state.running) return false;
  emit({ cancelRequested: true });
  return true;
}

export function isPullRunning() {
  return state.running;
}

export function isPullCancelRequested() {
  return state.cancelRequested;
}

// 用户看过「它其实跑完了」之后清掉提示（面板调用）。
export function consumeFinishedWhileAway() {
  if (!state.finishedWhileAway) return null;
  const summary = state.finishedWhileAway;
  emit({ finishedWhileAway: null });
  return summary;
}

// 仅测试用：把单例复位（模块级状态跨用例存活，必须显式清）。
export function resetPullController() {
  attachedPanels = 0;
  listeners.clear();
  state = {
    running: false,
    progress: { done: 0, total: 0 },
    notice: '',
    eta: 0,
    cancelRequested: false,
    startedAt: 0,
    lastResult: null,
    finishedWhileAway: null,
  };
}
