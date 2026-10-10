// I1：聊天页「本轮还在跑时按下发送」的判定——纯函数，Node 直测。
//
// 为什么单独一个纯模块：这段判定决定了「用户的输入会不会丢」，是最不该靠 UI 代码
// 里一堆 if 兜住的东西。三种结果：
// - `send`：没有在跑的请求 → 正常发送（新开一轮）；
// - `queued`：在跑**工具循环** → 作为补充指令入队（不打断工具链，loop 下一轮请求前注入）；
// - `blocked`：在跑，但不能入队 → 调用方必须**保留输入并给出说明**（绝不静默丢弃）。
//
// 为什么「不是工具循环」不能入队：`runAgentTurn` 只在多轮循环里 drain 队列，单次请求
// 没有「下一轮」可注入——收了就会烂在队列里，等于悄悄吞掉用户打的字。
//
// 与 workspace 宿主（`ChatPanel.js`）同一套语义；差别只在那边每轮无条件建队列。

export const STEERING_SEND_ACTIONS = Object.freeze({
  SEND: 'send',
  QUEUED: 'queued',
  BLOCKED: 'blocked',
});

export function resolveSteeringSend({
  inFlight = false,
  text = '',
  hasAttachments = false,
  steeringAvailable = false,
} = {}) {
  const value = String(text === undefined || text === null ? '' : text).trim();
  if (!inFlight) return { action: STEERING_SEND_ACTIONS.SEND };
  if (!value) return { action: STEERING_SEND_ACTIONS.BLOCKED, reason: 'empty' };
  if (hasAttachments) return { action: STEERING_SEND_ACTIONS.BLOCKED, reason: 'attachments' };
  if (!steeringAvailable) return { action: STEERING_SEND_ACTIONS.BLOCKED, reason: 'noLoop' };
  return { action: STEERING_SEND_ACTIONS.QUEUED, text: value };
}
