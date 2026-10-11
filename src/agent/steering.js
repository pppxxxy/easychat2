// I1：Steering 队列（用户中途补充指令）——纯函数、注入式。
//
// 场景：agent 正在跑（多轮工具链），用户在输入框打了新指令直接发送。
// 语义：不中断当前工具链、不新开 turn——指令入队，由 loop.js 在**下一轮模型
// 请求前**以 system 小段注入（「用户中途补充：…，请在后续决策中纳入」）。
//
// 容器：Z 系采纳 #6 的**类型化命令队列**（runtime/commandQueue.js）。steering 就是
// 「一条 priority=next 的 steering 命令」——与 prompt / notification / control 共用同一套
// 优先级与同级 FIFO 语义，不再自建第二个队列实现。对外契约（push / drain / size）
// 与旧版逐字一致，loop.js 与两个宿主（useChatSend、ChatPanel）零改动。
//
// 容量：最多 5 条（满则挤掉最旧——新指令更相关）；单条截断 500 字符
//（超出部分不是"指令"而是"新任务"，应该等本轮结束单独发）。

import { createCommandQueue } from './runtime/commandQueue.js';

export const STEERING_MAX_ITEMS = 5;
export const STEERING_TEXT_MAX = 500;

export function createSteeringQueue() {
  const queue = createCommandQueue();
  const steeringItems = () => queue.snapshot().filter(item => item.mode === 'steering');

  return {
    // 返回是否入队成功（空文本拒绝——调用方不必再判）。
    push(raw) {
      const text = String(raw == null ? '' : raw).trim().slice(0, STEERING_TEXT_MAX);
      if (!text) return false;
      // 满则挤掉最旧：snapshot 按入队顺序，第一条 steering 即最旧。
      while (steeringItems().length >= STEERING_MAX_ITEMS) {
        const oldest = steeringItems()[0];
        if (!oldest) break;
        queue.removeById(oldest.id);
      }
      return queue.enqueue({ mode: 'steering', priority: 'next', text }) !== null;
    },
    // 取出并清空（loop 每轮请求前调；空队列零开销）。
    drain() {
      return queue.dequeueBatch('next', 'steering').map(item => item.text);
    },
    get size() {
      return queue.countByMode('steering');
    },
  };
}
