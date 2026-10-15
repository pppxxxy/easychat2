// FEAT-AC4 P0-B：闹钟提醒工具域（set_reminder / list_reminders / cancel_reminder）——**脏层**。
//
// 分层照抄 AC1/AC2：`reminderSchema.js`（纯层）管时间归一与校验；本文件管读写。
//
// 落地方式：复用主动消息的**原生调度**（ProactiveMessageModule.schedule），
// 但用一次性形态（fireAt + 不走 LLM 的 fixedText）——见 ProactiveCore.RoleSchedule
// 与 ProactiveScheduling 的对应注释。
// 「新建对话」语义也是现成的：requestJson 留空 → 只用静态上下文，落进新会话。
//
// 依赖用**惰性 require**（先例 appSettingsTools.js / musicTools.js）：原生模块与
// storage 在纯 Node 里 import 不了，而本文件的**定义**要经 tools.js 索引层聚合
//（14 个测试 import 那个索引层，静态依赖会让它们全崩）。

import {
  REMINDER_TEXT_MAX,
  formatReminderTime,
  isReminderSlot,
  makeReminderSlotId,
  normalizeReminderTime,
  renderReminderConfirmText,
  renderReminderList,
  validateReminder,
} from '../reminderSchema.js';

let nativeModules = null;
function native() {
  if (!nativeModules) {
    nativeModules = {
      proactive: require('../../proactive/proactiveMessage.js'),
      moments: require('../../storage/moments.js'),
      assistant: require('../assistant.js'),
    };
  }
  return nativeModules;
}

/** 注入点（仅测试用）。传 null 恢复惰性 require。 */
export function __setReminderNativeModules(modules) {
  const backup = nativeModules;
  nativeModules = modules || null;
  return () => { nativeModules = backup; };
}

// 诊断留痕注入点（诊断模块依赖 AsyncStorage，纯 Node 单测不该被拖进来）。
let reminderTrace = { noteReminder() {} };
export function setReminderRecorder(recorder) {
  reminderTrace = recorder || { noteReminder() {} };
}

/**
 * 读全部提醒（从 JS 侧设置里的 slots 过滤）。
 *
 * 为什么读 JS 侧而不是问原生：slots 的**权威记录在 JS**（原生 MessageStore 是
 * 另一份调度态），且这里只需要「有哪些提醒」用于展示与取消，不必读原生。
 * 原生那份到期自删后，JS 这份由 syncReminders 对账清理。
 */
export async function readReminders() {
  const { moments } = native();
  let settings = null;
  try {
    settings = await moments.getProactiveSettings();
  } catch (error) {
    return [];
  }
  const slots = (settings && Array.isArray(settings.slots)) ? settings.slots : [];
  return slots
    .filter(slot => isReminderSlot(slot && slot.slotId))
    .map(slot => ({
      slotId: String(slot.slotId || ''),
      text: String(slot.text || slot.fixedText || '').trim(),
      fireAt: Number(slot.fireAt) || 0,
      enabled: slot.enabled !== false,
    }))
    .filter(item => item.slotId && item.fireAt > 0)
    .sort((a, b) => a.fireAt - b.fireAt);
}

/**
 * 建立一条提醒。
 *
 * @returns {Promise<{ ok: true, slotId: string, fireAt: number } | { ok: false, error: string }>}
 */
export async function createReminder({ text, time, now = Date.now() } = {}) {
  const invalid = validateReminder({ text, time, now });
  if (invalid) return { ok: false, error: invalid };
  const body = String(text).trim().slice(0, REMINDER_TEXT_MAX);
  const fireAt = normalizeReminderTime(time);

  const { proactive, moments, assistant } = native();

  // 精确闹钟权限前置：没授权就如实指引，**不静默降级成不准时**
  //（任务书明确要求；降级后「8 点提醒」可能变成「8 点半才提醒」）。
  try {
    const allowed = await proactive.canScheduleExactAlarms();
    if (allowed === false) {
      return {
        ok: false,
        error: '系统未授予「精确闹钟」权限，提醒可能不准时。请先在 设置→提醒 里打开它。',
      };
    }
  } catch (error) {
    // 查不了权限（老构建/原生缺失）不阻断：按「尽力而为」继续，
    // 由原生 schedule 侧再做一次判定（它也有一道降级）。
  }

  // 发送者 = 工作区助手（复用既有解析，不自己拼人设）。
  let assistantName = '助手';
  try {
    const resolved = await assistant.resolveWorkspaceAssistant('');
    assistantName = String((resolved && resolved.character && resolved.character.name) || assistantName);
  } catch (error) {}

  const slotId = makeReminderSlotId(now);
  const hour = new Date(fireAt).getHours();
  const minute = new Date(fireAt).getMinutes();

  try {
    await proactive.scheduleDailyMessage({
      slotId,
      // 用工作区助手的固定 id：提醒落进它的会话，而不是某个角色的会话。
      roleId: 'workspace-assistant',
      roleName: assistantName,
      persona: '',
      // 一次性形态：hour/minute 只为兼容字段（原生按 fireAt 触发，忽略它们）。
      hour,
      minute,
      mode: 'EXACT',
      enabled: true,
      revision: `${slotId}-${now}`,
      // 固定文案：不走 LLM（可靠性优先——见 ProactiveCore 的注释）。
      fixedText: body,
      // requestJson 留空 = 「新建对话」语义（只用静态上下文）。
      requestJson: '',
    });
  } catch (error) {
    return { ok: false, error: `建立提醒失败：${String((error && error.message) || error)}` };
  }

  // JS 侧记账：原生调度是另一份存储，这里把槽写进 proactive settings，
  // 让 list_reminders / 面板都能看到（原生那份只管到点触发）。
  try {
    const settings = await moments.getProactiveSettings();
    const slots = Array.isArray(settings.slots) ? settings.slots : [];
    await moments.saveProactiveSettings({
      ...settings,
      slots: [...slots, {
        slotId,
        roleId: 'workspace-assistant',
        roleName: assistantName,
        hour,
        minute,
        mode: 'EXACT',
        enabled: true,
        text: body,
        fireAt,
      }],
    });
  } catch (error) {
    // 记账失败不推翻已建立的调度（原生那份已经排上了）。
    // 但如实打点：这会让 list_reminders 看不到它。
    try {
      reminderTrace.noteReminder('set', `record-failed:${String((error && error.message) || error)}`);
    } catch (inner) {}
  }

  try {
    reminderTrace.noteReminder('set', formatReminderTime(fireAt, { now }));
  } catch (error) {}
  return { ok: true, slotId, fireAt };
}

/** 取消一条提醒。 */
export async function removeReminder(slotId) {
  const id = String(slotId || '').trim();
  if (!id) return { ok: false, error: '需要给出要取消的提醒 id（可用 list_reminders 查）' };
  const { proactive, moments } = native();
  try {
    await proactive.cancelDailySchedule(id);
  } catch (error) {
    return { ok: false, error: `取消失败：${String((error && error.message) || error)}` };
  }
  // JS 侧同步删掉记账（失败不影响已取消的调度）。
  try {
    const settings = await moments.getProactiveSettings();
    const slots = Array.isArray(settings.slots) ? settings.slots : [];
    await moments.saveProactiveSettings({
      ...settings,
      slots: slots.filter(slot => String((slot && slot.slotId) || '') !== id),
    });
  } catch (error) {}
  try {
    reminderTrace.noteReminder('cancel', id);
  } catch (error) {}
  return { ok: true, slotId: id };
}

// ---------- 工具定义 ----------

const LIST_REMINDERS_TOOL = {
  name: 'list_reminders',
  description: '列出已设置的提醒（只读）。给出每条的时间（本机时区）、内容与 id。'
    + '取消某条提醒时用它的 id 调 cancel_reminder。',
  readOnly: true,
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    const reminders = await readReminders();
    if (reminders.length === 0) return '当前没有设置任何提醒。';
    const now = Date.now();
    return `共 ${reminders.length} 条提醒：\n${renderReminderList(reminders, { now })}`;
  },
};

const SET_REMINDER_TOOL = {
  name: 'set_reminder',
  description: '设置一条**一次性**提醒（到点通知）。这是写操作，**执行前会弹确认框让用户批准**。'
    + `text 是要提醒的内容（≤${REMINDER_TEXT_MAX} 字）；`
    + 'time 是**绝对的日期时间**：ISO 8601 字符串（如 2026-10-16T08:00:00，不带时区按用户本机时区解释）'
    + '或 epoch 毫秒数。相对说法（「5 分钟后」「明天早上 8 点」）请你自己换算成绝对时间再传。'
    + '过去的时间会被拒绝并说明。提醒到点用**固定文案**（原样念出 text），不经模型改写——'
    + '所以 text 要写成一句完整的话。精确到达受系统省电策略影响。',
  readOnly: false,
  // 与 AC1/AC2 同一条审批链：到点会打扰用户，必须经用户点头。
  requiresConfirmation: true,
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: `提醒内容（≤${REMINDER_TEXT_MAX} 字），写成一句完整的话。` },
      time: { type: 'string', description: '绝对时间：ISO 8601 字符串（如 2026-10-16T08:00:00）或 epoch 毫秒数。' },
    },
    required: ['text', 'time'],
  },
  execute: async (options, args) => {
    const result = await createReminder({
      text: args && args.text,
      time: args && args.time,
    });
    if (!result.ok) return `${result.error}。未建立任何提醒。`;
    return `已设置提醒：${formatReminderTime(result.fireAt)} 提醒你「${String(args.text).trim()}」。`;
  },
};

const CANCEL_REMINDER_TOOL = {
  name: 'cancel_reminder',
  description: '取消一条已设置的提醒（按 id）。这是写操作，**执行前会弹确认框让用户批准**。'
    + 'id 从 list_reminders 取。',
  readOnly: false,
  requiresConfirmation: true,
  parameters: {
    type: 'object',
    properties: {
      slotId: { type: 'string', description: '要取消的提醒 id（来自 list_reminders）。' },
    },
    required: ['slotId'],
  },
  execute: async (options, args) => {
    const result = await removeReminder(args && args.slotId);
    if (!result.ok) return `${result.error}。未取消任何提醒。`;
    return `已取消提醒 ${result.slotId}。`;
  },
};

export const REMINDER_TOOL_DEFINITIONS = Object.freeze([
  LIST_REMINDERS_TOOL,
  SET_REMINDER_TOOL,
  CANCEL_REMINDER_TOOL,
]);

export const REMINDER_READ_DEFINITIONS = Object.freeze(
  REMINDER_TOOL_DEFINITIONS.filter(item => item.readOnly === true)
);
export const REMINDER_WRITE_DEFINITIONS = Object.freeze(
  REMINDER_TOOL_DEFINITIONS.filter(item => item.readOnly !== true)
);

/** 确认卡文案（宿主审批钩子用）。 */
export function renderReminderApproval({ name, args } = {}) {
  if (name === 'set_reminder') {
    return renderReminderConfirmText({
      text: args && args.text,
      fireAt: normalizeReminderTime(args && args.time),
    });
  }
  if (name === 'cancel_reminder') {
    return `将取消提醒 ${String((args && args.slotId) || '')}，允许吗？`;
  }
  return '';
}
