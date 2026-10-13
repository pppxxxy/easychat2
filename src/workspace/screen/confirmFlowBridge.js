// AS2：confirm_flow 的宿主桥（模块级，零 RN 依赖，Node 直测）。
//
// 分工：agent 循环里的工具 await 一个 Promise（requestConfirmFlow），面板订阅
// getPendingConfirmFlow() 渲染题卡，用户提交/取消时 resolve。桥住在模块级而不是
// 组件 state 里，理由与 pullController 相同（AGENTS.md 不变量⑧）：宿主面板可被
// 卸载重建（工作区切领域），Promise 与 resolver 绝不能跟着丢——丢了 agent 就永远
// 卡在等一个没人回答的确认。
//
// 同一时刻只挂一张卡：新请求进来时旧卡按「取消」结算（agent 拿到「用户取消了
// 确认」，比两张卡叠着让用户猜哪张是哪题诚实）。
//
// 宿主选项源（角色列表等长清单）走 agent 循环的 ctx.choices 一路（ChatPanel 注入），
// 不经过本桥——桥只管「挂起的题卡与结算」这一件事。

let pending = null; // { snapshot: { questions }, resolve, timer }
const listeners = new Set();
// 与 confirm_flow 工具的 timeoutMs（5 分钟，同 ask_user 口径）对齐：竞速双方同一时钟。
export const CONFIRM_TIMEOUT_MS = 300000;

function emit() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      // 订阅者异常不得影响确认主流程（旁路机制）。
    }
  }
}

// timeoutMs：不传/非法 → 默认 5 分钟（与工具超时同预算）；显式 0 或负数 → 不设超时。
export function requestConfirmFlow({ questions, timeoutMs } = {}) {
  const list = Array.isArray(questions) ? questions : [];
  if (pending) {
    const stale = pending;
    pending = null;
    if (stale.timer) clearTimeout(stale.timer);
    stale.resolve(null);
  }
  return new Promise(resolve => {
    if (list.length === 0) {
      resolve(null);
      return;
    }
    const entry = { snapshot: { questions: list }, resolve, timer: null };
    // 幽灵卡防护：工具侧 runTool 超时（默认 5 分钟）会放弃等待并继续回合——桥上的
    // 题卡若不跟着结算，就会永远挂在面板上，用户后来填的答案落进一个没人等的
    // Promise。到点自动按「取消」结算（与工具超时同一预算，竞速双方同一时钟）。
    // 归一：非法（NaN/非数）→ 默认 5 分钟；显式 0 或负数 → 不设超时（调用方明确关掉）。
    const raw = Number(timeoutMs);
    const timeout = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : CONFIRM_TIMEOUT_MS;
    if (timeout > 0) {
      // 只结算「仍然挂着的那张卡」：旧卡的定时器若在换卡后才触发，不能误杀新卡。
      entry.timer = setTimeout(() => { if (pending === entry) settle(null); }, timeout);
    }
    pending = entry;
    emit();
  });
}

// useSyncExternalStore 的 getSnapshot：未变化时必须返回同一引用。
export function getPendingConfirmFlow() {
  return pending ? pending.snapshot : null;
}

export function subscribeConfirmFlow(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function settle(value) {
  if (!pending) return false;
  const current = pending;
  pending = null;
  if (current.timer) clearTimeout(current.timer);
  emit();
  current.resolve(value);
  return true;
}

export function respondConfirmFlow(answers) {
  return settle(Array.isArray(answers) ? answers : null);
}

export function cancelConfirmFlow() {
  return settle(null);
}

// 宿主接线（runAgentTurn options 的一段）：ChatPanel 只 spread 这一个调用——
// 映射规则住在桥里（可 Node 直测），顶格的 ChatPanel 不再长行数。
// choices('characters') 把角色库映射成 list 题候选（id + 展示名），
// 防模型编造角色 id/名字。
export function confirmFlowHostOptions(characters) {
  const list = Array.isArray(characters) ? characters : [];
  return {
    onConfirmFlow: requestConfirmFlow,
    choices: source => (source === 'characters'
      ? list
        .map(item => ({ id: String((item && item.id) || ''), label: String((item && item.name) || '') }))
        .filter(item => item.id && item.label)
      : null),
  };
}

// 仅测试用：复位单例。
export function resetConfirmFlowBridge() {
  if (pending) {
    const current = pending;
    pending = null;
    if (current.timer) clearTimeout(current.timer);
    current.resolve(null);
  }
  listeners.clear();
}
