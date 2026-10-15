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
