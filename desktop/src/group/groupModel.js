// 桌面群聊的纯逻辑（Node 直测）。
//
// 与手机版（src/character/useGroupCreation.js + GroupCreateModal）同一套约束：
//   · 成员 2–8 人（MIN/MAX 由共享层决定，这里只引用不重定义）；
//   · 群名留空时用成员名以「、」连接兜底；
//   · 群头像/背景可选，创建后仍可在群设置里换。
// 本模块只做「能不能建、建成什么形状」，不碰存储与界面；创建调用共享的
// createGroupSession（sessionList/mutations.js），数据形状与手机完全一致。
import { MAX_GROUP_MEMBERS, MIN_GROUP_MEMBERS } from '../../../src/chat/groupChat/groupLimits.js';

// 成员计数与合法性：返回值直接喂给界面（按钮禁用、提示文案）。
export function groupMemberState(selectedIds) {
  const count = (Array.isArray(selectedIds) ? selectedIds : []).filter(Boolean).length;
  return {
    count,
    canCreate: count >= MIN_GROUP_MEMBERS && count <= MAX_GROUP_MEMBERS,
    atLimit: count >= MAX_GROUP_MEMBERS,
  };
}

// 点选成员：已选则取消；未选且未满则加入；已满则原样返回（界面据此提示上限）。
// 返回新数组，不修改入参——调用方可以直接 setState。
export function toggleGroupMember(selectedIds, id, max = MAX_GROUP_MEMBERS) {
  const list = (Array.isArray(selectedIds) ? selectedIds : []).filter(Boolean);
  const target = String(id || '');
  if (!target) return list;
  if (list.includes(target)) return list.filter(item => item !== target);
  const limit = Math.max(1, Math.trunc(Number(max) || MAX_GROUP_MEMBERS));
  if (list.length >= limit) return list;
  return [...list, target];
}

// 群名兜底：用户填了就用；空则按成员顺序用「、」连接（与手机逐字同口径）。
export function resolveGroupName(name, memberNames, joinSeparator = ', ') {
  const typed = String(name || '').trim();
  if (typed) return typed;
  const names = (Array.isArray(memberNames) ? memberNames : [])
    .map(item => String(item || '').trim())
    .filter(Boolean);
  // 分隔符由调用方按界面语言传入（中文「、」/ 英文「, 」），本模块不写死标点。
  return names.join(joinSeparator);
}

// 群聊显示名：会话名优先，其次成员名，最后兜底文案。
// 记忆页/聊天页/会话切换器都用它，避免三处各写一套导致名字不一致。
export function groupDisplayName(session, memberNames, fallback = '', joinSeparator = ', ') {
  const typed = String((session && session.name) || '').trim();
  if (typed) return typed;
  const names = (Array.isArray(memberNames) ? memberNames : [])
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return names.join(joinSeparator) || String(fallback || '');
}

// 会话的成员角色列表：按 members 顺序解析，跳过已被删除的角色。
// 返回 { members, missingIds } —— 缺失的成员要能让用户看见（群聊少了一个人不是静默的）。
export function resolveGroupMembers(session, characterMap) {
  const ids = Array.isArray(session && session.members) ? session.members.map(String) : [];
  const members = [];
  const missingIds = [];
  for (const id of ids) {
    const character = characterMap && typeof characterMap.get === 'function' ? characterMap.get(id) : null;
    if (character) members.push(character);
    else missingIds.push(id);
  }
  return { members, missingIds };
}

// 群聊发言人在桌面上的展示：消息自带 speakerName，缺省回落到成员表/角色名。
export function speakerNameOf(message, memberNames = [], fallback = '') {
  const own = String((message && message.speakerName) || '').trim();
  if (own) return own;
  const list = (Array.isArray(memberNames) ? memberNames : []).filter(Boolean);
  return list.length === 1 ? list[0] : String(fallback || '');
}