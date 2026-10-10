// 工作区布局断点（纯函数，可 Node 直测）：宽屏左右分栏，窄屏单屏切换。
//
// 平板 / 横屏（宽度 ≥ WIDE_BREAKPOINT）时左右分栏——对话常驻左半，选中的领域并排右半；
// 窄屏维持现有单屏切换（左栏即标签）。抽成纯函数是为了能直测（WorkspaceScreen 是 RN UI，
// 纯 Node 测不了）。

export const WIDE_BREAKPOINT = 720;

// 返回 'split'（宽屏分栏）| 'single'（窄屏单屏）。
export function resolveWorkspaceLayout({ width = 0, breakpoint = WIDE_BREAKPOINT } = {}) {
  const value = Number(width);
  const limit = Number(breakpoint);
  if (!Number.isFinite(value) || !Number.isFinite(limit)) return 'single';
  return value >= limit ? 'split' : 'single';
}
