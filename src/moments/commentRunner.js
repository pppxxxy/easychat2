// 后台评论任务的注册表：把「用户动态的评论生成」从组件生命周期里解耦。
//
// 背景（用户 2026-10-11 反馈）：用户发完动态后退出动态页，评论生成被组件卸载时的
// abort 打断，等于「一退出就结束」。评论是逐角色串行调模型的慢任务，必须由模块级
// 单例持有，退出界面后继续跑完、继续写库；用户回来时从存储读到的就是完整结果。
//
// 设计约束：
// - 零 RN / 零存储依赖（真正的模型调用由调用方通过 run 注入），便于纯 Node 单测；
// - 同一条动态同一时刻只跑一个任务：重复 start 会排队而不是并发（避免重复扣费）；
// - stop 中止当前任务并清空该动态的待跑队列——用户点了「停止」就真的停。

const tasks = new Map(); // momentId -> { pending: Function[], controller, draining }
let snapshot = new Set();
const listeners = new Set();

function publish() {
  snapshot = new Set(tasks.keys());
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      // 订阅者（React setState）抛错不该影响任务本身。
    }
  }
}

// 订阅任务集合变化；返回退订函数。配合 getCommentingIds 使用。
export function subscribeCommentRunner(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 当前有任务（正在跑或排队中）的动态 id 集合。引用只在变化时更新，可直接喂给
// useState / useSyncExternalStore。
export function getCommentingIds() {
  return snapshot;
}

export function isCommenting(momentId) {
  return tasks.has(String(momentId || ''));
}

async function drain(momentId, entry) {
  entry.draining = true;
  try {
    while (entry.pending.length > 0) {
      const run = entry.pending.shift();
      const controller = new AbortController();
      entry.controller = controller;
      try {
        await run({ signal: controller.signal });
      } catch (error) {
        // 增值功能：失败静默，不打断后续排队的任务。
      } finally {
        entry.controller = null;
      }
    }
  } finally {
    entry.draining = false;
    // 只在没有任何排队任务时注销；drain 的退出与这里的判断之间没有 await，
    // 所以「新 start 撞进这个窗口」不可能发生。
    if (tasks.get(momentId) === entry && entry.pending.length === 0) {
      tasks.delete(momentId);
      publish();
    }
  }
}

// 登记一条动态的评论任务。run 收到 { signal }，应在收到 abort 时尽快返回。
// 已在跑时排队（顺序执行），返回 true 表示已受理。
export function startCommentTask(momentId, run) {
  const id = String(momentId || '');
  if (!id || typeof run !== 'function') return false;
  let entry = tasks.get(id);
  if (!entry) {
    entry = { pending: [], controller: null, draining: false };
    tasks.set(id, entry);
    publish();
  }
  entry.pending.push(run);
  if (!entry.draining) drain(id, entry);
  return true;
}

// 停止该动态的评论任务：中止当前请求并丢弃排队中的任务。
// 返回是否确实有任务被停止。
export function stopCommentTask(momentId) {
  const id = String(momentId || '');
  const entry = tasks.get(id);
  if (!entry) return false;
  entry.pending.length = 0;
  if (entry.controller) entry.controller.abort();
  return true;
}

// 仅供单测：清空所有任务与订阅者。
export function resetCommentRunnerForTests() {
  for (const entry of tasks.values()) {
    entry.pending.length = 0;
    if (entry.controller) entry.controller.abort();
  }
  tasks.clear();
  listeners.clear();
  publish();
}
