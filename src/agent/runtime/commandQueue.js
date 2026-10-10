// 运行时命令队列（Z 系采纳 #6，对照 zai-org/ZCode 的 runtime/command-queue.ts）。
//
// 为什么要有它：现在「运行中还能做什么」是散的——补充指令走 agent/steering.js 的
// 简易 FIFO，后台完成通知靠回调，运行中再发消息直接被拒。三者本质是同一件事：
// **一条排队的、带类型与优先级的命令**。把它们收进一个队列，语义就统一了：
//   prompt        用户新消息（会话忙时排队，等本轮结束再发）
//   steering      生成中补充的指令（下一轮模型请求前注入，不打断工具链）
//   notification  后台任务完成通知（空闲时批量呈现，不打断当前轮）
//   control       只改状态、不进模型轮的控制命令
// 优先级 now > next > later：同级按入队先后（FIFO）。
//
// 纯模块：零 import、零原生依赖，Node 直测。

export const COMMAND_PRIORITY = Object.freeze({ now: 0, next: 1, later: 2 });
export const COMMAND_PRIORITIES = Object.freeze(['now', 'next', 'later']);
export const COMMAND_MODES = Object.freeze(['prompt', 'steering', 'notification', 'control']);

const DEFAULT_PRIORITY = 'next';

function priorityRank(priority) {
  const value = COMMAND_PRIORITY[priority];
  return Number.isFinite(value) ? value : COMMAND_PRIORITY[DEFAULT_PRIORITY];
}

function normalizeCommand(command, seq) {
  const source = command && typeof command === 'object' ? command : {};
  const mode = COMMAND_MODES.includes(source.mode) ? source.mode : 'control';
  const priority = COMMAND_PRIORITIES.includes(source.priority) ? source.priority : DEFAULT_PRIORITY;
  const text = source.text === undefined || source.text === null ? '' : String(source.text);
  // prompt / steering 必须有正文；空正文的命令没有意义（调用方不必再判）。
  if ((mode === 'prompt' || mode === 'steering') && !text.trim()) return null;
  return {
    id: String(source.id || `cmd-${seq}`),
    mode,
    priority,
    text,
    payload: source.payload === undefined ? null : source.payload,
    createdAt: Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : Date.now(),
    seq,
  };
}

export function createCommandQueue() {
  let items = [];
  let seq = 0;
  const cancelPending = new Set();

  const pickIndex = maxPriority => {
    const cap = COMMAND_PRIORITIES.includes(maxPriority)
      ? COMMAND_PRIORITY[maxPriority]
      : Number.POSITIVE_INFINITY;
    let best = -1;
    let bestRank = Number.POSITIVE_INFINITY;
    for (let i = 0; i < items.length; i += 1) {
      const rank = priorityRank(items[i].priority);
      if (rank > cap) continue;
      // 同级 FIFO：只取第一个（items 本身按入队顺序 append）。
      if (rank < bestRank) { best = i; bestRank = rank; }
    }
    return best;
  };

  return {
    // 返回命令 id；无效命令（空正文的 prompt/steering）返回 null。
    enqueue(command) {
      seq += 1;
      const normalized = normalizeCommand(command, seq);
      if (!normalized) return null;
      items.push(normalized);
      return normalized.id;
    },
    // 取一条最高优先级（同级 FIFO）。
    dequeue(maxPriority) {
      const index = pickIndex(maxPriority);
      if (index === -1) return undefined;
      const [command] = items.splice(index, 1);
      return command;
    },
    // 取同优先级、同 mode 的一批（通知批量呈现用）；不传 mode 则只取一条。
    dequeueBatch(maxPriority, mode = null) {
      if (!mode) {
        const one = this.dequeue(maxPriority);
        return one ? [one] : [];
      }
      const cap = COMMAND_PRIORITIES.includes(maxPriority)
        ? COMMAND_PRIORITY[maxPriority]
        : Number.POSITIVE_INFINITY;
      const batch = items.filter(item => item.mode === mode && priorityRank(item.priority) <= cap);
      if (batch.length === 0) return [];
      const ids = new Set(batch.map(item => item.id));
      items = items.filter(item => !ids.has(item.id));
      return batch;
    },
    // 不取出，只查看（UI 显示排队条数/内容）。
    peek(maxPriority) {
      const index = pickIndex(maxPriority);
      return index === -1 ? undefined : items[index];
    },
    snapshot() {
      return [...items];
    },
    removeById(id) {
      const index = items.findIndex(item => item.id === id);
      if (index === -1) return undefined;
      const [command] = items.splice(index, 1);
      return command;
    },
    markCancelPending(id) { cancelPending.add(String(id || '')); },
    consumeCancelPending(id) { return cancelPending.delete(String(id || '')); },
    size() { return items.length; },
    countByMode(mode) { return items.filter(item => item.mode === mode).length; },
    clear() { items = []; cancelPending.clear(); },
  };
}
