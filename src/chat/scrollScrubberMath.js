export function indexFromRatio(ratio, itemCount) {
  if (!Number.isFinite(itemCount) || itemCount <= 0) return 0;
  const clamped = Math.min(1, Math.max(0, Number(ratio) || 0));
  return Math.round(clamped * (itemCount - 1));
}

export function getScrollRange({ top = 0, height = 0, viewport = 0 } = {}) {
  const safeTop = Math.max(0, Number(top) || 0);
  const safeHeight = Math.max(0, Number(height) || 0);
  const safeViewport = Math.max(0, Number(viewport) || 0);
  return {
    start: safeTop,
    end: Math.max(0, safeTop + safeHeight - safeViewport),
  };
}
