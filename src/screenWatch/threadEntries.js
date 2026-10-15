// FEAT-AC5 P0-A：看屏幕对话条目的**展示用**纯逻辑（零 RN 依赖 → Node 直测）。
//
// 为什么单独一个文件：ScreenWatchPanel 展开线程时要显示每条 entry 的「谁说的 + 何时」。
// 这属于纯映射，按仓库纪律抽出来测——埋在 JSX 里的判定没有测试，改错了也不会红
//（本轮 P0-A 的另一半「行可点开」是渲染结构，不设 Node 测试）。

// 条目时间：`MM-DD HH:mm`。
// 不显示年份：看屏幕对话是短期记忆（线程 30 分钟空闲即换新、最多 50 条），
// 年份只会挤占悬浮窗/窄栏本就紧张的横向空间。
// at 缺失/非法 → 空串（渲染层据此不显示时间，而不是显示 1970）。
export function formatThreadEntryTime(at) {
  const value = Number(at) || 0;
  if (!value) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 条目角色 → i18n 键。**不复用记忆页的 memory.provenance.evidence.role***：
// 那里把 assistant 叫「角色」，但工作区线程里说话的是**工作区助手**，
// 复用会让用户在「看屏幕」面板里看到「角色」而不知道指的是谁。
export function threadEntryRoleKey(role) {
  return role === 'user' ? 'workspace.watch.roleUser' : 'workspace.watch.roleAssistant';
}

// FEAT-AC9 P2-2：遗留空线程的**展示层**判据。
//
// 现象（用户反馈）：工作区看屏幕面板的列表里一直挂着 pre-AC7 时代的
// 「（暂无内容）0」线程——那是当年「中止路径什么都不落库」留下的产物（AC7 P0-C 已修，
// 新回合不会再产生这种线程），但**已经写进存储的那些不会自己消失**。
//
// 为什么只在**展示层**过滤、不删数据：
//   · 存储是用户的数据，判据（多久算「遗留」）会随产品调整，用它做**删除**的理由
//     会在判据改错时造成不可逆损失；
//   · 用户仍可在记忆页的「屏幕对话」里看到它们（空线程聚合在一键清理入口）并手动删除。
// 故这里只回答「这条要不要画进面板列表」。
export const STALE_EMPTY_THREAD_MS = 48 * 60 * 60 * 1000;

/**
 * 是否属于「遗留空线程」（有 id、0 条目、且最后活动超过 48 小时）。
 *
 * @param {object} thread 线程
 * @param {number} [now] 当前时间（注入以便直测；缺省 Date.now()）
 * @returns {boolean}
 */
export function isStaleEmptyThread(thread, now = Date.now()) {
  if (!thread || !thread.id) return false;
  const entries = Array.isArray(thread.entries) ? thread.entries : [];
  if (entries.length > 0) return false;
  // updatedAt 缺失/非法 → 视为**旧**（它确实是旧数据；但见下：调用方按 scope 收窄，
  // 且 0 条目的线程在记忆页仍可见可删，所以按旧处理不会造成「看不见也删不掉」）。
  const updatedAt = Math.floor(Number(thread.updatedAt)) || 0;
  return now - updatedAt > STALE_EMPTY_THREAD_MS;
}

/**
 * 面板列表的展示过滤：滤掉遗留空线程，其余原样（**不改顺序**——threads.js 已按时间倒序）。
 *
 * @param {Array} threads 线程列表（已按 scope 收窄）
 * @param {number} [now]
 * @returns {Array} 新数组（不修改入参）
 */
export function filterStaleEmptyThreads(threads, now = Date.now()) {
  return (Array.isArray(threads) ? threads : []).filter(thread => !isStaleEmptyThread(thread, now));
}
