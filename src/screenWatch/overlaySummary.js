// FEAT-AC4 P0-A 补：把「工具确认」渲染成人话摘要的**纯逻辑层**（零 RN 依赖，Node 直测）。
//
// 背景（已对码核实）：确认卡的 summarize 钩子此前**从未被接线**（createOverlayConfirmHandler()
// 无参调用 → summarize=null），于是 confirm 卡只显示「工具名 + JSON args」；AC1/AC2/AC4
// 各自写好的 renderReminderApproval / renderMusicConfirmText 全部成了死代码。
// 本文件把它们接到同一个 summarize 上——工具名 → 人话，缺省回落。
//
// 为什么单独一个文件：ScreenWatchScreen/useOverlayChatSend 都已贴着行数棘轮；
// 且这里全是纯映射，抽出来就能 Node 直测（不必真机点确认卡）。

import { coerceSettingValue, describeSetting, renderSettingValue } from '../workspace/appSettingsSchema.js';
import { renderMusicConfirmText } from '../workspace/musicToolSchema.js';
import { renderReminderApproval } from '../workspace/toolDefs/reminderTools.js';

const MUSIC_WRITE_TOOL = 'control_music';
const SET_SETTING_TOOL = 'set_app_setting';

/**
 * 把一次待确认的工具调用渲染成人话摘要。
 *
 * @param {{name?: string, args?: object}} call registry 传下来的 { name, args }
 * @returns {string} 摘要；无法渲染时返回空串（调用方回落「工具名 + 参数」）。
 */
export function summarizeToolCall({ name, args } = {}) {
  const tool = String(name || '').trim();
  const source = args && typeof args === 'object' ? args : {};

  if (tool === 'set_reminder' || tool === 'cancel_reminder') {
    // 提醒：set 用「将在 <本地时间> 提醒你「…」」，cancel 用「将取消提醒 <id>」。
    return renderReminderApproval({ name: tool, args: source });
  }

  if (tool === MUSIC_WRITE_TOOL) {
    // 音乐：action 级问句（play/resume 才会走到确认；其余动作不弹）。
    return renderMusicConfirmText({ action: String(source.action || '').trim() });
  }

  if (tool === SET_SETTING_TOOL) {
    // 设置：确认发生在读旧值**之前**（registry 先问、execute 才读盘），
    // 所以这里只能给「键 + 目标值」，给不出「旧值 → 新值」。
    const key = String(source.key || '').trim();
    if (!key) return '';
    const target = renderSettingValue(key, coerceSettingValue(key, source.value));
    return `将把「${describeSetting(key)}」（${key}）改为 ${target}，允许吗？`;
  }

  return '';
}