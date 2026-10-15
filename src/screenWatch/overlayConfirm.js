// FEAT-AC4 P0-A：悬浮窗**窗内确认卡**的纯逻辑层（零 RN 依赖，Node 直测）。
//
// 背景（已对码核实）：悬浮窗工作区回合此前被两行 SW3 时代的代码锁死——
// `mode: 'read'`（写类工具不可见）+ `confirm: async () => false`（一律自动拒绝）。
// 当时的理由是「悬浮窗不弹全屏 Alert（会盖住用户正在看的画面）」，在 AC1/AC2
// 之前是合理取舍；现在它成了「悬浮窗干不了活」的单一根因。
//
// 解法：不弹全屏框，而是在悬浮窗聊天流里插一张原生确认卡（操作摘要 + 允许/拒绝）。
// 本文件管**挂起与结算的全部判定**——那才是真正有风险的部分（超时、重复点击、
// 迟到事件、并发挂起），抽出来就能在 Node 里把边界全测一遍，不必真机点。
//
// 为什么需要超时：agent 循环不能无限挂起。60 秒不点 = 拒绝（同一语义），
// 助手如实收尾（「用户没有回应，未执行」）。

export const OVERLAY_CONFIRM_TIMEOUT_MS = 60000;

// 摘要长度上限：确认卡是悬浮窗里的一小块，太长会撑爆（也防止模型塞长文）。
export const OVERLAY_CONFIRM_SUMMARY_MAX = 300;

/**
 * 归一确认请求的载荷。
 * 返回 null = 载荷不可用（调用方直接按拒绝处理，不挂起）。
 *
 * @param {object} args
 * @param {string} [args.fallbackSummary] 摘要为空时的兜底文案。
 *   ⚠️ **必须由调用方传入 i18n 已译文案**：本文件是纯逻辑层，返回值会被渲染到
 *   用户可见的确认卡上，而本仓的 i18n 门禁禁止在函数返回的对象字面量里硬编码中文
 *   （那是「被渲染层直接展示的文案」的形态）。
 */
export function normalizeOverlayConfirmRequest(raw = {}) {
  // ⚠️ 必须显式挡 null：解构默认值只对 undefined 生效，显式传 null 会抛
  //（实测踩到——调用方从原生载荷/JSON 里取值时拿到 null 是常态）。
  const source = raw && typeof raw === 'object' ? raw : {};
  const confirmId = String(source.id || '').trim();
  if (!confirmId) return null;
  const text = String(source.summary || '').trim().slice(0, OVERLAY_CONFIRM_SUMMARY_MAX);
  const timeout = Number(source.timeoutMs);
  return {
    id: confirmId,
    // 摘要为空时用调用方给的兜底：空卡片会让用户不知道在确认什么。
    // 兜底也缺省时退到工具名（英文/键名，不是硬编码中文文案）。
    summary: text || String(source.fallbackSummary || '').trim() || 'confirm',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : OVERLAY_CONFIRM_TIMEOUT_MS,
  };
}

/**
 * 确认挂起登记表（**纯逻辑**：不碰定时器与原生，由调用方注入）。
 *
 * 为什么单独一个类而不是几个模块级变量：挂起状态有 4 条竞态路径
 *（用户点允许 / 点拒绝 / 超时 / 迟到或重复事件），每一条都必须恰好结算一次。
 * 把「谁该结算」收在一个地方，才能保证 agent 循环不会卡在一个永远等不到的 Promise 上。
 */
export class OverlayConfirmRegistry {
  constructor({ timeoutMs = OVERLAY_CONFIRM_TIMEOUT_MS } = {}) {
    this.defaultTimeoutMs = timeoutMs;
    // id → { resolve, timer, settled }
    this.pending = new Map();
  }

  /** 当前挂起数量（诊断与测试用）。 */
  get size() {
    return this.pending.size;
  }

  /**
   * 登记一个挂起请求。
   *
   * @param {object} request  { id, summary, timeoutMs }
   * @param {(result: {approved: boolean, reason: string}) => void} settle 结算回调（只调一次）
   * @param {object} deps  { setTimeout, clearTimeout } —— 注入以便单测控制时间
   * @returns {boolean} 是否登记成功（id 已存在 → false，调用方按拒绝处理）
   */
  register(request, settle, deps = {}) {
    const normalized = normalizeOverlayConfirmRequest(request);
    if (!normalized) return false;
    if (this.pending.has(normalized.id)) return false;   // 同 id 重复挂起：拒绝，不覆盖
    const setTimer = deps.setTimeout || setTimeout;
    // 注意：entry 里**没有** settled 标志——「恰好结算一次」的唯一机制是
    // settleById 里的 pending.delete（单线程 + get/delete 之间无 await，天然原子）。
    // 早先版本另加了一个 settled 布尔，实测是**冗余**的（delete 之后再也 get 不到），
    // 冗余状态只会让「谁才是真正的判定点」变模糊，故删掉。
    const entry = { settle, timer: null };
    // 超时 = 拒绝（同一语义：没得到允许就是不许执行）。
    entry.timer = setTimer(() => {
      this.settleById(normalized.id, { approved: false, reason: 'timeout' });
    }, normalized.timeoutMs);
    this.pending.set(normalized.id, entry);
    return true;
  }

  /**
   * 按 id 结算（用户点了允许/拒绝，或超时）。
   *
   * **幂等**：重复的 id、迟到的事件、已经超时结算过的，一律静默忽略。
   * 这是「恰好结算一次」的唯一保证点——agent 循环因此不会卡死，也不会被
   * 一个迟到事件唤醒成「执行了本该拒绝的操作」。
   *
   * 实现要点：先 delete 再回调。delete 之后任何并发的 settleById 都 get 不到
   * entry，天然幂等（不依赖额外的布尔标志）。
   *
   * @returns {boolean} 本次是否真的结算了（false = 已被别的路径结算过 / 未知 id）
   */
  settleById(id, result, deps = {}) {
    const key = String(id || '').trim();
    const entry = this.pending.get(key);
    if (!entry) return false;
    this.pending.delete(key);
    const clearTimer = deps.clearTimeout || clearTimeout;
    if (entry.timer !== null) {
      try {
        clearTimer(entry.timer);
      } catch (error) {}
      entry.timer = null;
    }
    try {
      entry.settle({
        approved: result && result.approved === true,
        reason: String((result && result.reason) || (result && result.approved ? 'approved' : 'denied')),
      });
    } catch (error) {
      // 结算回调抛错不该影响注册表状态（它已经被清干净了）。
    }
    return true;
  }

  /** 全部按拒绝结算（服务销毁 / app 退出：不能让 agent 悬着）。 */
  settleAll(reason = 'aborted', deps = {}) {
    const ids = [...this.pending.keys()];
    ids.forEach(id => this.settleById(id, { approved: false, reason }, deps));
    return ids.length;
  }
}

/**
 * 生成确认卡要显示的**摘要行**（把工具的 call 渲染成人看得懂的一句话）。
 *
 * 为什么需要兜底：工具的 confirm 渲染函数（AC1 的「旧值→新值」、AC2 的「将播放《X》」）
 * 不一定存在——registry 传下来的只有 { name, args }。兜底用工具名 + 参数摘要，
 * 总比一张空白卡片强（用户至少能看出在确认哪个操作）。
 */
export function renderOverlayConfirmSummary({ name, args, render } = {}) {
  if (typeof render === 'function') {
    try {
      const text = String(render({ name, args }) || '').trim();
      if (text) return text.slice(0, OVERLAY_CONFIRM_SUMMARY_MAX);
    } catch (error) {
      // 渲染函数抛错 → 走下面的兜底，不让确认卡因此弹不出来。
    }
  }
  const toolName = String(name || '').trim() || '未知操作';
  let detail = '';
  try {
    detail = args && typeof args === 'object' ? JSON.stringify(args) : String(args || '');
  } catch (error) {
    detail = '';
  }
  detail = detail.slice(0, 160);
  return (detail ? `${toolName}\n${detail}` : toolName).slice(0, OVERLAY_CONFIRM_SUMMARY_MAX);
}
