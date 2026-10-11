// 流式写界面的最小节流（只用于**文本增量**，reasoning 不节流）。
//
// 为什么需要：token 可能比屏幕刷新还密（本地模型尤其，一个 chunk 一个 token），
// 每个 token 都 setMessages 会让 MessageList 的整表 .map() 重跑一遍。配合
// mergeStreamedText 的「文本未变返回原引用」，可以进一步把重渲染压到一帧一次。
//
// 口径（三条都要，缺一个就会出问题）：
//   1. **前沿立即放行**：首个 token 不延迟（纯后沿节流会让首字晚 intervalMs 才出现）；
//   2. 窗口内的中间值**只留最后一个**：文本是全量累积的（每个回调都带完整 fullText），
//      中间值没有任何信息量，丢掉不损失内容；
//   3. 后沿**一定补上**：由定时器兜底（不是靠调用方记得 flush），窗口内的最后一份
//      文本不会丢。flush() 只是「不用等这 16ms」的加速通道。
//
// 依赖 now / schedule 可注入：定时器行为才能被直测（不注入就得靠真实时钟，测试会变慢且易抖）。

import { mergeStreamedText } from './replyFlow.js';

export const STREAM_THROTTLE_INTERVAL_MS = 16;

export function createStreamThrottle(apply, {
  intervalMs = STREAM_THROTTLE_INTERVAL_MS,
  now = Date.now,
  schedule = setTimeout,
} = {}) {
  const window = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0
    ? Number(intervalMs)
    : STREAM_THROTTLE_INTERVAL_MS;
  let lastDeliveredAt = Number.NEGATIVE_INFINITY;
  let timer = null;
  let pending = null;
  let hasPending = false;

  const deliver = value => {
    lastDeliveredAt = now();
    apply(value);
  };

  // 把待发的最后一份值立刻发出去（没有待发值就是空操作，返回 false）。
  const flush = () => {
    timer = null;
    if (!hasPending) return false;
    const value = pending;
    pending = null;
    hasPending = false;
    deliver(value);
    return true;
  };

  const push = value => {
    const at = now();
    if (timer === null && at - lastDeliveredAt >= window) {
      deliver(value);
      return;
    }
    // 窗口内：覆盖待发值（只留最后一个），并保证有一个后沿定时器在跑。
    pending = value;
    hasPending = true;
    if (timer === null) {
      timer = schedule(flush, Math.max(0, window - (at - lastDeliveredAt)));
    }
  };

  return { push, flush };
}

// 「把流式文本节流写进消息列表」的现成装配：调用方只需要给会话判定与 setMessages。
// 抽出来是为了让 useChatSend 里只留一行（那个文件在行数棘轮上顶格，且并发修改多）。
// 文本是全量累积的，所以节流丢中间值不丢内容；未命中/已结算时 mergeStreamedText
// 返回原引用，迟到的后沿写入是空操作，不会把结算后的消息改回 pending。
export function createTextStreamThrottle({ isCurrentSession, setMessages, pendingId, intervalMs }) {
  return createStreamThrottle(text => {
    if (!isCurrentSession()) return;
    setMessages(current => (
      isCurrentSession() ? mergeStreamedText(current, pendingId, text) : current
    ));
  }, { intervalMs });
}
