// 工具使用提示的可见性：**唯一判定层**（纯逻辑，零依赖，Node 可直测）。
//
// 背景：聊天页的「工具过程气泡」（见 chat/toolBubbleView.js 与 chat/ToolBubble.js）
// 会告诉用户「正在搜索…」「已搜索」。有用户不想要这些提示，希望按工具关掉。
//
// 三条**不可让步**的边界（改这个文件之前先读完；两条都在下面有对应分支与测试）：
//
// 1. **审批/确认界面绝不隐藏。** 工具需要用户点头时，弹层由 chat/toolApprovalFlow.js
//    独立弹出（消费点见 useChatSend.js 的 onToolApproval → approveToolCall），
//    根本不经过本模块。把审批也藏起来 = 工具在用户不知情时静默执行，那是安全问题，
//    不是偏好问题。所以本模块只回答「过程提示显不显示」，永远不回答「要不要问用户」。
//
// 2. **失败绝不隐藏。** 工具调用失败、超时、被拒必须看得见——否则用户面对的是一个
//    「什么都没发生」的假象，而且会把「工具没跑成」当成「模型没想用工具」。
//    实现见 isToolNoticeHidden 里对 status === 'error' 的短路。
//
// 3. **默认可见（fail-open to visible）。** 设置缺失、损坏、字段类型不对、工具名不在
//    表里——一律按「显示」处理。宁可多显示一条提示，也不静默吞掉一条。

// 工具名合法形状：与 agent/tools/registry.js 的 TOOL_NAME_PATTERN 同口径。
// 存储里的键必须先是「可能存在的工具名」，否则一个损坏的 blob 就能往设置里塞任意键。
export const TOOL_NOTICE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// 这几个键的字符恰好都在上面的白名单里，但它们在对象上**不是普通数据键**：
// `__proto__` 会改原型、`constructor` / `prototype` 会撞上继承链。必须单独挡掉，
// 否则「按工具隐藏」这张表就成了一个原型污染入口。
const RESERVED_TOOL_NOTICE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// 归一化「按工具隐藏」表 → `{ 工具名: true }`（只保留显式 true 的项）。
//
// **未知工具名保留**（这里只做形状校验，不按白名单丢弃），理由：
// 聊天页还能显示**不在静态聊天工具清单里**的工具（read/write 模式下的工作区工具、
// MCP 工具）。按白名单丢弃会让用户在这些工具上的偏好在下次读盘时静默失效——
// 这正是本仓库被咬过六次以上的「同一份清单多处各写一份、其中一处漏同步」形态。
// 保留的代价是有界的：键必须匹配 TOOL_NOTICE_NAME_PATTERN，且只有用户在界面上
// 显式拨动过的工具名才会被写进来。
export function normalizeHiddenToolNotices(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  Object.keys(source).forEach(key => {
    // 只认显式的 true：false / 0 / 'yes' / null 都等于「显示」，不制造模糊状态。
    if (source[key] !== true) return;
    const name = String(key).trim();
    if (!TOOL_NOTICE_NAME_PATTERN.test(name)) return;
    if (RESERVED_TOOL_NOTICE_KEYS.has(name)) return;
    result[name] = true;
  });
  return result;
}

// **唯一的隐藏判定**——所有消费点都调它，不许在别处各写一遍 settings.hideXxx。
//
// 参数：
//   toolName  工具名（agent/tools/registry.js 里的名字，如 web_search）
//   settings  含 hideAllToolNotices / hiddenToolNotices 的设置对象（可直接传归一化前的
//             原始对象——本函数自己归一化，调用方不需要先处理）
//   status    该次工具事件的状态（'running' | 'done' | 'error'）。界面要问「这个工具的
//             开关现在是什么状态」时不传（默认空串 = 按开关判定）。
//
// 返回 true 表示「这条过程提示该被隐藏」。注意它**只**描述提示，不描述工具本身：
// 隐藏了提示的工具照常执行、照常在需要时弹审批。
export function isToolNoticeHidden(toolName, settings, status = '') {
  // 边界 2：失败永不隐藏。这是本函数的第一条分支，位置本身就是契约——
  // 任何新加的隐藏条件都必须排在它后面。
  if (String(status || '') === 'error') return false;
  // 边界 3：设置缺失/不是对象 → 显示。
  if (!settings || typeof settings !== 'object') return false;
  // 总开关：全部隐藏（含清单外的工具：工作区工具、MCP 工具、将来新增的工具）。
  if (settings.hideAllToolNotices === true) return true;
  const name = String(toolName || '').trim();
  if (!name) return false;
  const hidden = normalizeHiddenToolNotices(settings.hiddenToolNotices);
  return hidden[name] === true;
}
