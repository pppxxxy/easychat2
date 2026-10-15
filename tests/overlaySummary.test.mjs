// FEAT-AC4 P0-A 补：确认卡摘要渲染（把工具调用翻成人话）。
//
// 纯 Node 直测：summarizeToolCall 只依赖 schema 层与纯渲染函数
//（reminderTools 的 renderReminderApproval 不碰原生，惰性 require 只在执行工具时才触发）。
//
// 这条覆盖的**回归**：确认卡的 summarize 钩子此前从未接线 → 卡片只显示工具名 + JSON。
// 现在断言各域的渲染函数真的产出了人话问句。

import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeToolCall } from '../src/screenWatch/overlaySummary.js';

test('提醒：set 渲染含时间与内容，cancel 渲染含 id', () => {
  const at = new Date(2026, 9, 16, 8, 0, 0).getTime();
  const setText = summarizeToolCall({ name: 'set_reminder', args: { text: '开会', time: at } });
  assert.match(setText, /开会/);
  assert.match(setText, /允许吗/);

  const cancelText = summarizeToolCall({ name: 'cancel_reminder', args: { slotId: 'reminder-x' } });
  assert.match(cancelText, /reminder-x/);
});

test('音乐：play/resume 渲染成人话问句', () => {
  assert.match(summarizeToolCall({ name: 'control_music', args: { action: 'play' } }), /将开始播放/);
  assert.match(summarizeToolCall({ name: 'control_music', args: { action: 'resume' } }), /将继续播放/);
});

test('设置：渲染 key + 目标值（布尔归一成 开/关）', () => {
  const text = summarizeToolCall({ name: 'set_app_setting', args: { key: 'tts.autoBroadcast', value: true } });
  assert.match(text, /tts\.autoBroadcast/);
  assert.match(text, /开/);
  assert.match(text, /允许吗/);
  // 空 key → 空串（调用方回落工具名 + 参数）
  assert.equal(summarizeToolCall({ name: 'set_app_setting', args: {} }), '');
});

test('未知工具 / 无参数：返回空串（回落兜底，不抛）', () => {
  assert.equal(summarizeToolCall({ name: 'run_shell', args: { cmd: 'ls' } }), '');
  assert.equal(summarizeToolCall({}), '');
  assert.equal(summarizeToolCall(), '');
  // args 为 null / 非对象也不抛（纯映射要能承受原生/JSON 载荷的形状漂移）
  assert.match(summarizeToolCall({ name: 'control_music', args: null }), /将开始播放/);
});