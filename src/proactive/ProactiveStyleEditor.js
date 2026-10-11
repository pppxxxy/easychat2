// 主动消息的「随机时段 + 风格权重」编辑器（从 ProactivePanel 拆出的子模块）。
//
// 拆出来的两个理由：面板文件有行数棘轮（只许减不许增），且这段逻辑自成一块——
// 「时段长度」与「四种风格的权重」本就是同一件事的两半（什么时候发、发哪种）。
//
// 纯逻辑（时段换算、权重换算、按类型摊平）在 proactiveStyleModel.js：那是会被算错的
// 部分，放在无 RN 依赖的模块里才能 Node 直测。这里只负责渲染与事件。
//
// 说明：RN UI 文件，已登记进 .c8rc.json 排除。

import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import {
  PROACTIVE_WINDOW_OPTIONS,
  WEIGHT_MAX_PERCENT,
  buildStyleRows,
  effectivePercent,
  formatWindowRange,
  styleRowsToStyles,
} from './proactiveStyleModel.js';

export default function ProactiveStyleEditor({ slot, onChange, styles, theme, t, typeOptions }) {
  const windowMinutes = Math.max(0, Math.trunc(Number(slot.windowMinutes) || 0));
  const rows = buildStyleRows(slot, typeOptions.map(option => option.value));
  const activeTotal = rows.reduce((sum, row) => sum + row.percent, 0);
  const range = formatWindowRange(slot.hour, slot.minute, windowMinutes);
  const labelOf = type => {
    const found = typeOptions.find(option => option.value === type);
    return found ? found.label : type;
  };

  // 每次改动都把整张表交回去：权重表是一个整体（归一与「至少一条启用」都依赖全局），
  // 只传变化的那一行会让存储层拿不到上下文。
  const emit = nextRows => onChange({ styles: styleRowsToStyles(nextRows) });
  const setPercent = (type, percent) => {
    emit(rows.map(row => (row.type === type ? { ...row, percent } : row)));
  };
  const setPrompt = (type, customPrompt) => {
    emit(rows.map(row => (row.type === type ? { ...row, customPrompt } : row)));
  };

  return (
    <>
      <Text style={styles.fieldLabel}>{t('proactive.window.label')}</Text>
      <View style={styles.chipWrap}>
        {PROACTIVE_WINDOW_OPTIONS.map(option => {
          const active = windowMinutes === option;
          return (
            <TouchableOpacity
              key={option}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onChange({ windowMinutes: option })}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {option === 0
                  ? t('proactive.window.off')
                  : t('proactive.window.minutes', { count: option })}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.hint}>
        {range
          ? t(range.nextDay ? 'proactive.window.hintNextDay' : 'proactive.window.hint', {
            start: range.start,
            end: range.end,
          })
          : t('proactive.window.hintOff')}
      </Text>

      <Text style={styles.fieldLabel}>{t('proactive.weight.label')}</Text>
      {rows.map(row => (
        <View key={row.type}>
          <View style={styles.weightRow}>
            <Text style={styles.weightLabel} numberOfLines={1}>{labelOf(row.type)}</Text>
            <TextInput
              style={styles.weightInput}
              value={String(row.percent)}
              onChangeText={text => {
                const digits = String(text).replace(/[^0-9]/g, '');
                const value = Math.trunc(Number(digits));
                setPercent(
                  row.type,
                  Number.isFinite(value) ? Math.min(Math.max(value, 0), WEIGHT_MAX_PERCENT) : 0,
                );
              }}
              keyboardType="number-pad"
              maxLength={3}
              accessibilityLabel={t('proactive.weight.a11y', { name: labelOf(row.type) })}
            />
            <Text style={styles.weightPercent}>
              {t('proactive.weight.effective', { percent: effectivePercent(row.percent, activeTotal) })}
            </Text>
          </View>
          {row.type === 'CUSTOM' && row.percent > 0 ? (
            <TextInput
              style={styles.promptInput}
              value={row.customPrompt}
              onChangeText={text => setPrompt(row.type, text)}
              placeholder={t('proactive.customPrompt.placeholder')}
              placeholderTextColor={theme.colors.textFaint}
              multiline
            />
          ) : null}
        </View>
      ))}
      <Text style={styles.hint}>
        {activeTotal > 0 ? t('proactive.weight.hint') : t('proactive.weight.hintAllZero')}
      </Text>
    </>
  );
}
