// 保留口径（P1-11）：快照条数 / 回滚基线份数 / 会话事件流上限——可配置，默认值即历史口径。
//
// 为什么集中一个纯模块：这三个上限原本各自散在 `fileHistory.js`（HISTORY_MAX）、
// `rollbackBaseline.js`（ROLLBACK_KEEP）、`sessionEvents.js`（SESSION_EVENTS_MAX_BYTES），
// 而它们的**默认值同时是写给用户看的承诺**（设置层文案里的数字，有守卫测试钉着）。
// 集中一处之后：改默认值只可能漏一处，归一化与边界也只有一份实现。
//
// 边界存在的理由：这些值直接决定「磁盘上留多少」。允许配 0 就是允许用户（或一次手滑）
// 把快照能力关死而界面仍宣称「有历史」——所以一律夹到合理区间，非法输入回落默认。
//
// 生效值的取法：`store.retention`（`createWorkspaceStore` 从工作区设置带下来）。
// 假 store / 老数据没有这个字段 → 一律走默认，行为与加这个模块之前逐字一致。

export const HISTORY_KEEP_DEFAULT = 200;
export const ROLLBACK_KEEP_DEFAULT = 3;
export const SESSION_EVENTS_MAX_KB_DEFAULT = 512;

export const RETENTION_BOUNDS = Object.freeze({
  // 快照条数：至少 10 条（低于这个数「写前快照」就没有实用价值），上限 5000。
  historyKeep: Object.freeze({ min: 10, max: 5000 }),
  // 回滚基线份数：每份可能几 MB，1–50。
  rollbackKeep: Object.freeze({ min: 1, max: 50 }),
  // 会话事件流上限（KB）：64KB–8MB。
  sessionEventsMaxKb: Object.freeze({ min: 64, max: 8192 }),
});

export const DEFAULT_RETENTION = Object.freeze({
  historyKeep: HISTORY_KEEP_DEFAULT,
  rollbackKeep: ROLLBACK_KEEP_DEFAULT,
  sessionEventsMaxKb: SESSION_EVENTS_MAX_KB_DEFAULT,
});

function clampInt(value, bounds, fallback) {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, num));
}

// 归一化：非法/缺失一律回落默认；合法值夹进区间（不静默接受 0 或负数）。
export function normalizeRetention(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    historyKeep: clampInt(source.historyKeep, RETENTION_BOUNDS.historyKeep, HISTORY_KEEP_DEFAULT),
    rollbackKeep: clampInt(source.rollbackKeep, RETENTION_BOUNDS.rollbackKeep, ROLLBACK_KEEP_DEFAULT),
    sessionEventsMaxKb: clampInt(
      source.sessionEventsMaxKb,
      RETENTION_BOUNDS.sessionEventsMaxKb,
      SESSION_EVENTS_MAX_KB_DEFAULT
    ),
  };
}

// 从 store（或设置对象）取生效口径：两者都用 `retention` 字段，缺失 = 默认。
export function retentionOf(source) {
  return normalizeRetention(source && source.retention);
}

// 事件流上限（字节）：唯一一处把 KB 换算成字节，避免调用点各写一次 *1024。
export function sessionEventsMaxBytes(retention) {
  return normalizeRetention(retention).sessionEventsMaxKb * 1024;
}
