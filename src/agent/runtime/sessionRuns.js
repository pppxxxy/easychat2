// 会话运行时登记表（L 系「Agent 运行时与 UI 分离」的骨架，spec 2026-10-10-runtime-split）。
//
// 现状（L0a 测绘）：一次生成的 AbortController 与发送锁都挂在 ChatScreen 的
// useSessionGuard 上（屏幕作用域），因此「哪些会话正在跑」只存在于聊天页的内存里，
// 页面之外的任何地方（管理面板、并发准入）都看不到。
//
// 本模块把「正在跑的会话」提升成应用级的一等事实：谁在跑、跑哪个角色、什么时候开始、
// 用什么控制器取消。**控制器仍由发送方持有并驱动**（useSessionGuard 的 abortRef 语义
// 不变），这里只登记引用——不接管取消时机，避免两套取消逻辑打架。
//
// 纯模块：只依赖同样纯的 commandQueue，Node 可直测。
//
// Z 系采纳 #6：每个会话还带一条**类型化命令队列**（prompt/steering/notification/control，
// 带优先级）——运行中再发消息、补充指令、后台完成通知都进这里，语义统一。

import { createCommandQueue } from './commandQueue.js';

// 登记一条运行中的会话。同一会话同一时刻只允许一个 run（准入闸门），
// 重复 start 返回 null——调用方据此判断「这个会话已经在跑」。
function makeRun(sessionId, info) {
  const source = info && typeof info === 'object' ? info : {};
  return {
    sessionId,
    characterId: String(source.characterId || ''),
    controller: source.controller || null,
    // 发送方（useSessionGuard）持有的令牌：切回该会话时据此恢复界面上的发送锁。
    token: source.token || null,
    status: 'running',
    startedAt: Date.now(),
    // 展示用标签（角色名 / 会话名），由调用方给；缺省空串。
    label: String(source.label || ''),
  };
}

export function createSessionRunRegistry() {
  const runs = new Map();
  // sessionId → 类型化命令队列（与 run 解耦：会话空闲时也能排队，等 run 起来再消费）。
  const queues = new Map();
  const listeners = new Set();

  const queueFor = sessionId => {
    const id = String(sessionId || '');
    if (!id) return null;
    if (!queues.has(id)) queues.set(id, createCommandQueue());
    return queues.get(id);
  };

  const notify = () => {
    // 复制一份给监听者：回调里若再触发变更，不会边遍历边改集合。
    const snapshot = [...runs.values()];
    listeners.forEach(listener => {
      try {
        listener(snapshot);
      } catch (error) {
        // 监听者（面板）自身出错不能影响运行时的登记/取消。
      }
    });
  };

  const registry = {
    // 准入 + 登记。sessionId 为空或该会话已在跑 → null（不登记、不打断既有的那个）。
    start(sessionId, info) {
      const id = String(sessionId || '');
      if (!id) return null;
      if (runs.has(id)) return null;
      const run = makeRun(id, info);
      runs.set(id, run);
      // 控制器一旦被中止就自动注销——不管是谁触发的（登记表 cancel、发送方 abort、
      // 会话切换里对 abortRef 的直接 abort）。否则会出现「登记表显示还在跑、实际请求
      // 早已停止」的泄漏，面板会永远挂着一个幽灵会话。
      const signal = run.controller && run.controller.signal;
      if (signal && typeof signal.addEventListener === 'function') {
        try {
          signal.addEventListener('abort', () => { registry.finish(id); }, { once: true });
        } catch (error) {}
      }
      notify();
      return run;
    },
    get(sessionId) {
      return runs.get(String(sessionId || '')) || null;
    },
    has(sessionId) {
      return runs.has(String(sessionId || ''));
    },
    isRunning(sessionId) {
      const run = runs.get(String(sessionId || ''));
      return Boolean(run && run.status === 'running');
    },
    // 运行自然结束（成功/失败/被取消后调用方自行收尾）时注销。
    finish(sessionId) {
      const id = String(sessionId || '');
      if (!runs.has(id)) return false;
      runs.delete(id);
      notify();
      return true;
    },
    // 主动取消：先 abort 控制器再注销，保证「登记表里没有」与「请求确实停了」一致。
    cancel(sessionId) {
      const id = String(sessionId || '');
      const run = runs.get(id);
      if (!run) return false;
      try {
        if (run.controller && typeof run.controller.abort === 'function') run.controller.abort();
      } catch (error) {}
      runs.delete(id);
      notify();
      return true;
    },
    cancelAll() {
      const ids = [...runs.keys()];
      ids.forEach(id => registry.cancel(id));
      return ids.length;
    },
    // 面板读用：正在跑的会话快照（按开始时间升序，先跑的先列）。
    list() {
      return [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
    },
    size() {
      return runs.size;
    },
    // 面板订阅：变更时回调最新快照，返回退订函数。
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // ---- 类型化命令队列（Z 系采纳 #6）----
    // 入队一条命令（prompt/steering/notification/control）；空正文的 prompt/steering 返回 null。
    enqueueCommand(sessionId, command) {
      const queue = queueFor(sessionId);
      if (!queue) return null;
      const id = queue.enqueue(command);
      if (id) notify();
      return id;
    },
    // 取一条最高优先级命令（同级 FIFO）；maxPriority 限定上限（如只取 now）。
    dequeueCommand(sessionId, maxPriority) {
      const queue = queues.get(String(sessionId || ''));
      if (!queue) return undefined;
      const command = queue.dequeue(maxPriority);
      if (command) notify();
      return command;
    },
    // 取同优先级同 mode 的一批（通知批量呈现）。
    dequeueCommandBatch(sessionId, maxPriority, mode) {
      const queue = queues.get(String(sessionId || ''));
      if (!queue) return [];
      const batch = queue.dequeueBatch(maxPriority, mode);
      if (batch.length > 0) notify();
      return batch;
    },
    peekCommand(sessionId, maxPriority) {
      const queue = queues.get(String(sessionId || ''));
      return queue ? queue.peek(maxPriority) : undefined;
    },
    pendingCommandCount(sessionId) {
      const queue = queues.get(String(sessionId || ''));
      return queue ? queue.size() : 0;
    },
    clearCommands(sessionId) {
      const queue = queues.get(String(sessionId || ''));
      if (!queue) return false;
      queue.clear();
      notify();
      return true;
    },
    resetForTests() {
      runs.clear();
      queues.clear();
      listeners.clear();
    },
  };
  return registry;
}

// 应用级单例：发送路径（登记）与运行中角色面板（读取/取消）共享同一份事实。
export const sessionRuns = createSessionRunRegistry();

export function resetSessionRunsForTests() {
  sessionRuns.resetForTests();
}
