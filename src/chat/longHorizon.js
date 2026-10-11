// 长程上下文模式（差距 #5）——面向大窗口模型（如 1M）的压缩策略覆盖。
//
// 背景：默认口径在 85% 触发会话自动压缩、70% 出提示条（见 chat/compactionPolicy.js），
// 面向的是 200k 级窗口。ZCode/GLM-5.3 这类 1M 窗口模型需要**更晚触发压缩、保留更多
// 近期消息**，否则「长程任务」还没跑多久就被压缩掉早期上下文。
//
// 本模块只做**策略解算**（纯函数），不改既有默认值：`enabled` 为真时把阈值与保留条数
// 抬到长程档，其余原样透传。是否开启由设置决定（`chatOptions.longHorizon`）。

export const LONG_HORIZON_PRESET = Object.freeze({
  autoCompactRatio: 0.92,   // 会话空闲自动压缩线（默认 0.85）
  compactHintRatio: 0.8,    // 「建议压缩」提示线（默认 0.7）
  keepRecent: 12,           // 压缩后保留的近期消息条数（默认 6）
});

// 解算长程策略。base 是当前口径（可只给部分字段）。
// 返回 { autoCompactRatio, compactHintRatio, keepRecent, longHorizon }。
export function resolveLongHorizonPolicy({ enabled = false, base = {} } = {}) {
  const b = base && typeof base === 'object' ? base : {};
  const resolved = {
    autoCompactRatio: Number.isFinite(Number(b.autoCompactRatio)) ? Number(b.autoCompactRatio) : 0.85,
    compactHintRatio: Number.isFinite(Number(b.compactHintRatio)) ? Number(b.compactHintRatio) : 0.7,
    keepRecent: Number.isFinite(Number(b.keepRecent)) ? Math.max(0, Math.trunc(Number(b.keepRecent))) : 6,
    longHorizon: false,
  };
  if (!enabled) return resolved;
  return {
    autoCompactRatio: Math.max(resolved.autoCompactRatio, LONG_HORIZON_PRESET.autoCompactRatio),
    compactHintRatio: Math.max(resolved.compactHintRatio, LONG_HORIZON_PRESET.compactHintRatio),
    keepRecent: Math.max(resolved.keepRecent, LONG_HORIZON_PRESET.keepRecent),
    longHorizon: true,
  };
}

// 该窗口是否「够大、值得建议开启长程模式」（纯判据，供设置页提示）。
export function shouldSuggestLongHorizon(contextWindow, { threshold = 400000 } = {}) {
  return Number(contextWindow) >= Number(threshold);
}
