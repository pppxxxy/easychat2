// FEAT-AC8 P0-B：**同签名确认预算**（纯逻辑，零依赖，Node 直测）。
//
// 事故现场（用户 2026-10-16 00:35 真机日志）：一个回合里连弹 **5 张确认卡**
//（4 次允许 + 1 次拒绝）。原因是 BUG-A（布尔字符串被校验拒绝）让工具每次返回
//「未做任何修改」，模型于是**合规地重发**同一个调用——每次重发都要用户再点一次
//「允许」。用户被夹在「模型没错、工具没错、但我要连点五次」中间。
//
// 修 BUG-A 后这条链会消失，但**防环仍必须做**：任何工具持续失败（不只布尔这个 case）
// 都会复现同一形态——循环里的重复调用检测只 nudge 不阻断（见 loop.js 的 E2），
// 它拦不住「用户要反复点确认」这件**打扰**。
//
// 设计取舍（任务书 §二 P0-B）：
//  · 预算 **2**（首次 + 1 次重试）：首次必须照弹（逐次确认语义不变），
//    第 2 次给一次重试机会（模型可能只是参数写错），第 3 次起**不再打扰用户**，
//    直接按拒绝结算。
//  · 签名 = 工具名 + 规范化参数（**同签名才算重复**）：不同参数各自独立预算，
//    不会因为「改了个参数」就被误判成重试。
//  · 预算按**回合**清零：新一轮用户发话应重新获得完整的确认机会。
//  · 第 3 次起不弹卡、按拒绝——**方向是拒绝不是放行**（安全语义一字未松）。
//
// 阈值为什么是 2：拍板值（任务书 §四），依据是当晚 4 次已明显过量。
// 若真机仍觉打扰可调 1；改这一个常量即可，且下面有测试钉住语义。

export const CONFIRM_REPEAT_BUDGET = 2;

/**
 * 规范化签名：工具名 + 键序稳定的参数 JSON。
 *
 * 为什么参数要**排序后再序列化**：`{a:1,b:2}` 与 `{b:2,a:1}` 是同一组参数，
 * 键序抖动不该被当成「换了参数」（loop.js 的 stableStringify 同款理由）。
 * 序列化失败（循环引用等）退化为「只按工具名」——宁可多共享一点预算，
 * 也不要因为签名算不出来而让防环失效。
 */
export function confirmSignature(name, args) {
  const tool = String(name || '').trim();
  let payload = '';
  try {
    payload = stableStringify(args === undefined ? null : args);
  } catch (error) {
    payload = '';
  }
  return payload ? `${tool}|${payload}` : tool;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * 回合级的同签名确认计数器。
 *
 * 用法：一个回合建一个实例（宿主按回合创建/重置），每次**需要确认**的调用先问
 * `shouldAsk(signature)`：
 *   · true  → 照常弹卡（并已记一次）；
 *   · false → 预算用尽，调用方按拒绝结算，不弹卡。
 *
 * 为什么把「记一次」放进 shouldAsk 而不是分成 peek + record 两步：
 * 两步 API 很容易被调用方漏掉第二步（本仓「接口建好却没接线」的旧形态），
 * 单次调用同时判定与记账，漏接的可能性就消失了。
 */
export class ConfirmBudget {
  constructor({ budget = CONFIRM_REPEAT_BUDGET } = {}) {
    this.budget = Number.isFinite(Number(budget)) && Number(budget) > 0
      ? Math.floor(Number(budget))
      : CONFIRM_REPEAT_BUDGET;
    this.counts = new Map();
  }

  /** 该签名已询问过的次数（测试与诊断用）。 */
  askedCount(signature) {
    return this.counts.get(String(signature || '')) || 0;
  }

  /**
   * 是否还应弹卡（并在返回 true 时记一次）。
   * 返回 false = 预算用尽 → 调用方必须按**拒绝**结算（不是放行）。
   */
  shouldAsk(signature) {
    const key = String(signature || '');
    if (!key) return true;      // 签名缺失：不启用防环（宁可多问，不可误拒）
    const used = this.counts.get(key) || 0;
    if (used >= this.budget) return false;
    this.counts.set(key, used + 1);
    return true;
  }

  /** 回合结束/新回合开始：清零（新一轮用户发话应重新获得完整确认机会）。 */
  reset() {
    this.counts.clear();
  }
}

/**
 * 预算用尽时给**模型**的话术。
 *
 * 为什么必须给模型一句明确的话：模型不知道自己在循环里——它只看到「用户拒绝了」，
 * 于是可能继续重发（这正是当晚的形态）。告诉它「已停止再次询问 + 请给手动指引」，
 * 它才能合规地收尾，而不是把用户拖进第 4、5 次点击。
 */
export function repeatGuardMessage(name, { budget = CONFIRM_REPEAT_BUDGET } = {}) {
  return `同一操作本轮已确认过 ${budget} 次仍未成功，已停止再次询问（未执行）：${name}。`
    + '请停止重试，向用户说明情况并给出手动操作指引。';
}
