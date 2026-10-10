// 工作区**宽屏两栏**的布局解算（纯函数，Node 可直测）。
//
// 背景：工作区是「单屏 + 面板单开」——任一时刻只挂载一个面板，这是**刻意设计**
//（`WorkspaceScreen.js` 文件头：为了从结构上根除 Modal 叠 Modal）。手机竖屏放不下两栏，
// 这条原则继续有效；但平板 / 横屏 / 折叠屏展开时，把文件、终端、GitHub 从「替换对话」
// 变成「停在对话旁边」，才是宽屏该有的样子。
//
// 所以这里只回答一个问题：**这块屏幕要不要分两栏、以及怎么分**。所有数值判断都放在纯函数里，
// 界面只负责把结果画出来——拖拽、旋转、折叠屏展开都会频繁触发重算，判定逻辑必须能被直测。
//
// 用户裁决（2026-10-10）：**宽屏允许破例两栏**。

// 低于此宽度永远单栏。取 900 而不是 DSH 的 1024：那是「桌面三栏」的阈值，
// 我们只有两栏，且平板横屏（常见 1024–1280 逻辑像素）必须能进两栏。
export const WIDE_MIN_WIDTH = 900;
// 任一栏不得窄于此——窄过它就不是「并排工作」而是「两个都用不了」。
export const MIN_PANE_WIDTH = 280;
export const DEFAULT_SPLIT_RATIO = 0.5;
// 比例上下限：给左栏（对话）留出至少这个份额，避免拖到一边只剩一条缝。
export const MIN_SPLIT_RATIO = 0.35;
export const MAX_SPLIT_RATIO = 0.75;

function safeWidth(width) {
  const value = Number(width);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function isWideLayout(width) {
  return safeWidth(width) >= WIDE_MIN_WIDTH;
}

export function clampSplitRatio(ratio) {
  // 注意别直接 `Number(ratio)`：`Number(null)` 是 0（有限！），会被当成「用户拖到了最左」
  // 夹到下限，而不是「没有值」回默认。空值必须先判掉。
  const usable = typeof ratio === 'number'
    || (typeof ratio === 'string' && ratio.trim() !== '');
  if (!usable) return DEFAULT_SPLIT_RATIO;
  const value = Number(ratio);
  if (!Number.isFinite(value)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
}

// 这块屏幕要不要两栏：**宽屏** + **当前不在对话领域**。
// 在对话领域时即使宽屏也是单栏——「对话常驻」的含义是对话那一栏一直在，
// 而不是「永远有两栏」；用户点了对话就是想要全宽的对话。
export function resolveWorkspaceLayout({ width, panel } = {}) {
  const wide = isWideLayout(width);
  const onChat = String(panel || 'chat') === 'chat';
  return { wide, twoPane: wide && !onChat, single: !(wide && !onChat) };
}

// 两栏的实际像素宽度。夹紧后仍放不下（屏幕太窄）时如实返回 null——**不硬分**，
// 让界面退回单栏，而不是给用户两个都不可用的窄栏。
export function splitColumns({ width, ratio } = {}) {
  const total = safeWidth(width);
  if (total <= 0) return null;
  const usable = total;
  if (usable < MIN_PANE_WIDTH * 2) return null;
  const left = Math.round(usable * clampSplitRatio(ratio));
  // 右栏用减法而不是各自 round，保证 left + right 恒等于 total（否则会出现 1px 缝隙）。
  const right = usable - left;
  if (left < MIN_PANE_WIDTH || right < MIN_PANE_WIDTH) {
    // 夹紧到能放下为止：优先保证右栏不小于下限（右栏是用户刚打开的那一栏）。
    const fixedLeft = Math.max(MIN_PANE_WIDTH, Math.min(usable - MIN_PANE_WIDTH, left));
    return { left: fixedLeft, right: usable - fixedLeft };
  }
  return { left, right };
}

// 拖拽：起点比例 + 水平位移 → 新比例。位移按**总宽**折算，所以同一次拖动在宽屏上
// 移动的比例更小（手感一致：手指走的像素数一样，栏宽变化的像素数也一样）。
export function ratioFromDrag({ startRatio, dx, width } = {}) {
  const total = safeWidth(width);
  if (total <= 0) return clampSplitRatio(startRatio);
  const base = Number(startRatio);
  const safeBase = Number.isFinite(base) ? base : DEFAULT_SPLIT_RATIO;
  const delta = Number(dx);
  if (!Number.isFinite(delta)) return clampSplitRatio(safeBase);
  return clampSplitRatio(safeBase + delta / total);
}

// 持久化读回：存的是 `{ ratio, side }`。任何一项不合法就整份丢弃（回默认），
// 不做「半份可信」——半份可信会让布局在重启后处于一个用户没选过的状态。
export const SIDE_PANELS = Object.freeze(['files', 'github', 'terminal']);

export function normalizeStoredLayout(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const side = String(raw.side || '');
  if (!SIDE_PANELS.includes(side)) return null;
  const ratio = Number(raw.ratio);
  if (!Number.isFinite(ratio) || ratio < MIN_SPLIT_RATIO || ratio > MAX_SPLIT_RATIO) return null;
  return { ratio, side };
}
