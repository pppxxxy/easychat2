// 「本会话统计」的展示格式化（纯函数，Node 直测；与组件分开，避免测试去加载 react-native）。

// token 数的紧凑显示（估算值，K/M 足够）。
export function formatTokenCount(value) {
  const num = Number(value) || 0;
  if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
  if (num >= 10000) return `${Math.round(num / 1000)}K`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return String(num);
}

// 延迟：<1s 用毫秒，否则用秒（保留一位小数）；无样本显示「—」。
export function formatLatency(ms) {
  const value = Number(ms) || 0;
  if (value <= 0) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

export function formatSpeed(tokensPerSec) {
  const value = Number(tokensPerSec) || 0;
  if (value <= 0) return '—';
  return `${value.toFixed(1)}/s`;
}

// 占比：有量就至少显示 1%（避免「用了但显示 0%」的错觉）。
export function formatPercent(ratio) {
  const value = Number(ratio) || 0;
  if (value <= 0) return '0%';
  return `${Math.max(1, Math.round(value * 100))}%`;
}
