// FEAT-AC11 P0-2：**回合中止理由**的边车契约（纯逻辑，零依赖，Node 直测）。
//
// 为什么需要它（真机 17:38/17:40 的教训）：两个回合在诊断日志里只有 turn-start /
// turn-tool，**没有任何收尾事件**——abort 路径当时零打点，回合从日志里彻底蒸发。
// 当时只能靠「日志里 31 秒的空洞正好对上用户切面板的动作」反推根因。
//
// 补上 turn-aborted 事件之后，还差一步：**谁停的这一轮**。AbortSignal 不携带原因
// （`signal.reason` 在部分 RN/Hermes 版本上不存在），所以理由必须由**中止方**显式留下。
//
// ⚠️ 这里最容易写错的一点（本模块存在的主要理由）：
// `AbortController` 与它的 `controller.signal` 是**两个不同的对象**。
// 宿主只写 `controller.abortReason = 'panel-switch'` 时，loop 拿到的是
// `options.signal`（也就是 `controller.signal`）——**读不到那个字段**，
// 理由会静默变成空串，打点里依旧只有 turn-aborted 没有 reason。
// 所以写与读都收口到本模块：写时**同时**写 controller 与 controller.signal，
// 读时按同一约定取。契约只有一处，不会两边漂移。

// 合法理由：小写字母开头的短标签（panel-switch / screen-close / user-stop / turn-timeout…）。
// 只认标签而不是自由文本——它是**枚举式原因码**，不是正文通道（隐私与可读性同理）。
const REASON_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * 带理由中止一个 AbortController（唯一合法的中止入口）。
 *
 * @param {AbortController} controller 目标控制器（缺失/不可用时不抛）
 * @param {string} reason 短标签，如 'panel-switch' | 'screen-close' | 'user-stop'
 * @returns {boolean} 是否真的执行了 abort
 */
export function abortWithReason(controller, reason) {
  if (!controller || typeof controller.abort !== 'function') return false;
  // 已经中止过：**不覆盖已有理由**。谁先中止谁才是原因——
  // 关屏（visible=false）先 abort，随后组件卸载还会再走一次清理；
  // 若这里覆盖，理由会从 'screen-close' 变成 'panel-unmount'，把人指向错误方向。
  if (controller.signal && controller.signal.aborted === true) return false;
  const tag = normalizeAbortReason(reason);
  try {
    // 写两处：controller 自身（宿主/调试可见）与它的 signal（loop 读的是这个）。
    if (tag) {
      controller.abortReason = tag;
      if (controller.signal) controller.signal.abortReason = tag;
    }
    controller.abort();
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * 归一理由标签：非法（自由文本 / 大写 / 超长 / 非字符串）一律丢弃 → 空串。
 *
 * 「绝不猜」是有意的：编一个理由比没有理由更糟——它会把排查带向错误方向。
 */
export function normalizeAbortReason(reason) {
  if (typeof reason !== 'string') return '';
  const trimmed = reason.trim();
  return REASON_PATTERN.test(trimmed) ? trimmed : '';
}

/**
 * 从 signal 读取中止理由（loop 侧用）。
 *
 * @param {AbortSignal} signal 调用方传进 runAgentTurn 的 signal
 * @returns {string} 合法短标签，或空串（读不到 / 不合法）
 */
export function readAbortReason(signal) {
  if (!signal) return '';
  try {
    return normalizeAbortReason(signal.abortReason);
  } catch (error) {
    return '';
  }
}
