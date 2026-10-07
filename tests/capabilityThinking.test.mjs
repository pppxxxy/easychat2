// 能力弹窗思考参数守卫（2026-10-07「自定义没反应」死局修复 + 预设完整性）：
// - 死局机制：custom 的 onPress 曾把当前值原样写回（状态零变化），而自定义输入块
//   只在「不匹配任何预设」时渲染——默认值命中预设 1 → 输入块永远不出现。
//   修复 = 点击 custom 时置空 format（预设 format 均非空，立即脱离全部匹配）；
// - THINKING_PRESETS 是 SettingsScreen 内联常量（任务书禁止顺手迁移 i18n/重构），
//   这里用源码切片断言每条 entry 的 field/format 非空（custom 除外）；
// - 自定义态空格式时确认按钮必须禁用（confirmCapability 会把空格式静默归一成
//   'effort'，不堵住就是「配错且无感知」）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localeSource } from './helpers/localeSource.mjs';

const read = relativePath => fs.readFileSync(path.resolve(relativePath), 'utf8');

test('THINKING_PRESETS：非 custom 条目 field/format 非空，custom 保持空位', () => {
  const screen = read('src/SettingsScreen.js');
  const match = /const THINKING_PRESETS = \[([\s\S]*?)\n\];/.exec(screen);
  assert.ok(match, 'THINKING_PRESETS 常量必须存在');
  const chunks = match[1].split("id: '").slice(1);
  assert.ok(chunks.length >= 5, '预设条目齐全（5 个真实预设 + custom）');
  for (const chunk of chunks) {
    const id = chunk.slice(0, chunk.indexOf('\''));
    const field = /field:\s*'([^']*)'/.exec(chunk)[1];
    const format = /format:\s*'([^']*)'/.exec(chunk)[1];
    if (id === 'custom') {
      assert.equal(field + format, '', 'custom 条目必须保持空 field/format（占位语义）');
    } else {
      assert.ok(field && format, `预设 ${id} 的 field/format 必须非空（否则匹配逻辑失真）`);
    }
  }
});

test('自定义死局修复：点 custom 置空 format 脱离匹配、保留字段名；输入块条件不动', () => {
  const screen = read('src/SettingsScreen.js');
  assert.ok(/thinkingFormat: preset\.id === 'custom'\s*\n\s*\?\s*''/.test(screen),
    'custom onPress 必须把 format 置空（写回当前值 = 死局）');
  assert.ok(/thinkingField: preset\.id === 'custom'\s*\n\s*\?\s*current\.thinkingField/.test(screen),
    '字段名必须保留旧值（减少重输）');
  assert.ok(screen.includes('{!matchedThinkingPreset ? ('), '自定义输入块的出现条件保持不变');
  assert.ok(/preset\.id === 'custom'\s*\n\s*\?\s*!matchedThinkingPreset/.test(screen),
    'custom 卡片高亮条件（!matchedThinkingPreset）保持不变');
});

test('静默归一化堵口：自定义态空格式 → 确认按钮禁用 + 提示行', () => {
  const screen = read('src/SettingsScreen.js');
  assert.ok(/customFormatMissing = capabilityDraft\.supportsThinking === true\s*\n\s*&& !matchedThinkingPreset\s*\n\s*&& !\['effort', 'boolean', 'object'\]\.includes/.test(screen),
    'customFormatMissing 条件：思考开 + 未命中预设 + 格式为空');
  assert.ok(screen.includes('disabled={customFormatMissing}'), '确认按钮必须禁用');
  assert.ok(screen.includes("t('settings.capability.customFormatRequired')"), '必须渲染提示行');
  for (const locale of ['src/i18n/locales/zh-CN', 'src/i18n/locales/en']) {
    assert.ok(localeSource(locale).includes("'settings.capability.customFormatRequired'"), `${locale} 缺少提示词条`);
  }
});

test('预设 hint 防腐（2026-10）：过时版本锚点禁回流，维护提示必须带核对日期', () => {
  const screen = read('src/SettingsScreen.js');
  assert.ok(!screen.includes('Claude 3.7'), '过时锚点 Claude 3.7 不得回流');
  assert.ok(!screen.includes('DeepSeek-R1'), '过时锚点 DeepSeek-R1 不得回流');
  assert.ok(!/Qwen3 系/.test(screen), '过时锚点「Qwen3 系」不得回流');
  assert.ok(/最后核对 \d{4}-\d{2}/.test(screen), 'THINKING_PRESETS 上方必须有「最后核对日期」的维护提示');
});
