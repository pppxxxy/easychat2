// FEAT-AC4 P0-B：闹钟提醒工具域的**纯逻辑层**（零 RN 依赖，Node 直测）。
//
// 用户诉求：「几点提醒我」类闹钟 = 主动消息系统 + 新建对话 + 精确时间提醒。
//
// 现状缺口（已对码核实）：主动消息模型只有「每日重复的时:分」
//（RoleSchedule{hour, minute, mode: WORK|EXACT}），**没有一次性精确日期时间**。
// 本域补的就是它：JS 把「明天早上 8 点」规范化为绝对 epoch ms，原生按 fireAt
// 一次性触发后自删（见 ProactiveCore.RoleSchedule.fireAt / ProactiveScheduling）。
//
// 本文件管**判定**（时间归一、过去时间拒绝、文案渲染），脏层管读写。

import { describeValue } from './schemaValue.js';

// 与 AC1/AC2 共用同一实现（口径统一，避免三处漂移）。
export const describeReminderValue = describeValue;

// 提醒文本长度上限：通知栏放不下太长的正文，且它会被原样作为消息体（不走 LLM）。
export const REMINDER_TEXT_MAX = 200;

// 一次性提醒的槽位前缀：用于与「每日时段」区分（list_reminders 只列这些）。
export const REMINDER_SLOT_PREFIX = 'reminder-';

// 「秒 vs 毫秒」的分界：10^12 ms ≈ 2001-09-09。小于它的一律按**秒**解释
//（秒级时间戳在 2001 年前是常态，而提醒总是将来的时刻，不存在歧义）。
// 数字与数字字符串两条路径共用这一个常量——两处各写一个阈值必然漂移。
const SECONDS_CUTOFF = 1e12;

/**
 * 把模型给的时刻规范化为绝对 epoch ms。
 *
 * 接受三种形态（模型的输出不可控，三种都常见）：
 *   ① 数字（epoch ms）—— 直接采用；
 *   ② 数字字符串（"1735689600000"）—— 按 epoch ms 解析；
 *   ③ ISO 8601 字符串（"2026-10-16T08:00:00" / 带 Z 或时区偏移）—— Date.parse。
 *
 * **不带时区的 ISO 串按本机时区解释**（这正是用户说「明天早上 8 点」的意思）；
 * 带 Z/偏移的按其自身时区（调用方若已换算过就不该再动）。
 *
 * 返回 null = 无法解析（调用方直接拒绝，**不猜**一个时间出来——
 * 猜错会让用户在最不该被打扰的时刻收到提醒）。
 */
export function normalizeReminderTime(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // ⚠️ 数字路径也必须做同样的「秒 vs 毫秒」判定——否则 1800000000（数字）被当成
    // 1970-01-21 的毫秒，而 "1800000000"（字符串）被正确当成秒。两条路径不一致
    // 会让「同一个时间、模型时而给数字时而给字符串」产生两种结果（实测踩到）。
    return Math.floor(value < SECONDS_CUTOFF ? value * 1000 : value);
  }
  const raw = String(value).trim();
  if (!raw) return null;
  // 纯数字串：按 epoch（与上面数字路径同一判据）
  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) return null;
    return Math.floor(num < SECONDS_CUTOFF ? num * 1000 : num);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 校验一条提醒请求。
 *
 * 返回 null = 通过；返回字符串 = 拒绝原因（给模型与用户看）。
 * **过去时间直接拒绝并说明**（任务书明确要求）——排一个过去的闹钟
 * 要么被系统立即触发（等于立刻打扰用户），要么静默不响（用户以为设上了）。
 */
export function validateReminder({ text, time, now = Date.now() } = {}) {
  const body = String(text || '').trim();
  if (!body) return `提醒内容不能为空`;
  if (body.length > REMINDER_TEXT_MAX) {
    return `提醒内容太长（最多 ${REMINDER_TEXT_MAX} 字，当前 ${body.length} 字）`;
  }
  const at = normalizeReminderTime(time);
  if (at === null) {
    return `无法识别提醒时间：${describeReminderValue(time)}。请给明确的日期时间（如 2026-10-16T08:00:00）。`;
  }
  if (at <= now) {
    return `提醒时间已经过去了（${formatReminderTime(at)}）。请给一个将来的时间。`;
  }
  return null;
}

/**
 * epoch ms → 本机时区的可读时间（确认卡与工具输出用）。
 *
 * 为什么必须写清时区：用户在别的城市/跨夏令时看到「8:00」却不知道是哪个时区的 8:00，
 * 那是最容易出错的点（任务书要求「确认卡含换算后的本地时间」）。
 */
export function formatReminderTime(epochMs, { now = null } = {}) {
  const value = Number(epochMs);
  if (!Number.isFinite(value) || value <= 0) return '（无效时间）';
  const date = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  const body = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  // 相对天数提示：用户更容易判断「明天 8:00」还是「后天 8:00」
  if (now !== null) {
    const days = Math.round(
      (new Date(value).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000
    );
    if (days === 0) return `${body}（今天）`;
    if (days === 1) return `${body}（明天）`;
    if (days === 2) return `${body}（后天）`;
    if (days > 2) return `${body}（${days} 天后）`;
  }
  return body;
}

/** 生成提醒槽位 id（带前缀，便于与每日时段区分）。 */
export function makeReminderSlotId(now = Date.now(), random = Math.random) {
  return `${REMINDER_SLOT_PREFIX}${now.toString(36)}-${Math.floor(random() * 1e6).toString(36)}`;
}

/** 是否是我们管理的提醒槽（list_reminders 的过滤判据）。 */
export function isReminderSlot(slotId) {
  return String(slotId || '').startsWith(REMINDER_SLOT_PREFIX);
}

/**
 * 渲染确认卡文案（play/resume 之外，本域也要确认——它会到点打扰用户）。
 */
export function renderReminderConfirmText({ text, fireAt, now = Date.now() } = {}) {
  const body = String(text || '').trim() || '提醒';
  return `将在 ${formatReminderTime(fireAt, { now })} 提醒你「${body}」，允许吗？`;
}

/** 渲染提醒列表（list_reminders 用）。 */
export function renderReminderList(reminders, { now = Date.now(), limit = 30 } = {}) {
  const list = Array.isArray(reminders) ? reminders : [];
  if (list.length === 0) return '';
  return list.slice(0, limit).map(item => {
    const when = formatReminderTime(item.fireAt, { now });
    return `- ${when}　${item.text}　id=${item.slotId}`;
  }).join('\n');
}
