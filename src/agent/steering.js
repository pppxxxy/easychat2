// I1：Steering 队列（用户中途补充指令）——纯函数、注入式。
//
// 场景：agent 正在跑（多轮工具链），用户在输入框打了新指令直接发送。
// 语义：不中断当前工具链、不新开 turn——指令入队，由 loop.js 在**下一轮模型
// 请求前**以 system 小段注入（「用户中途补充：…，请在后续决策中纳入」）。
//
// 容量：最多 5 条（满则挤掉最旧——新指令更相关）；单条截断 500 字符
//（超出部分不是"指令"而是"新任务"，应该等本轮结束单独发）。

export const STEERING_MAX_ITEMS = 5;
export const STEERING_TEXT_MAX = 500;

export function createSteeringQueue() {
  let items = [];
  return {
    // 返回是否入队成功（空文本拒绝——调用方不必再判）。
    push(raw) {
      const text = String(raw == null ? '' : raw).trim().slice(0, STEERING_TEXT_MAX);
      if (!text) return false;
      if (items.length >= STEERING_MAX_ITEMS) items.shift();
      items.push(text);
      return true;
    },
    // 取出并清空（loop 每轮请求前调；空队列零开销）。
    drain() {
      const out = items;
      items = [];
      return out;
    },
    get size() {
      return items.length;
    },
  };
}
