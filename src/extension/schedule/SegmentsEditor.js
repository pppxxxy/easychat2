// 时间段编辑器：名称 + 起止时间 + 优先级（↑↓）+ 删除 + 新增。
//
// 「列表顺序 = 命中优先级」：重叠时取第一个命中的时间段（判定规则见
// src/chat/schedule.js 的 resolveScheduleSegment），所以这里必须能调顺序。

import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

function SegmentRow({ segment, index, isFirst, onChange, onRemove, onMove, styles, theme, t }) {
  return (
    <View style={[styles.row, isFirst && styles.rowFirst]}>
      <View style={styles.rowHead}>
        <TextInput
          style={styles.nameInput}
          value={segment.name}
          onChangeText={text => onChange(index, { name: text })}
          placeholder={t('schedule.segments.namePlaceholder')}
          placeholderTextColor={theme.colors.textFaint}
          maxLength={24}
          autoCorrect={false}
        />
        <View style={styles.rowActions}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => onMove(index, -1)}
            accessibilityRole="button"
            accessibilityLabel={t('schedule.segments.moveUp')}
          >
            <Ionicons name="chevron-up" size={18} color={theme.colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => onMove(index, 1)}
            accessibilityRole="button"
            accessibilityLabel={t('schedule.segments.moveDown')}
          >
            <Ionicons name="chevron-down" size={18} color={theme.colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => onRemove(index)}
            accessibilityRole="button"
            accessibilityLabel={t('schedule.segments.remove')}
          >
            <Ionicons name="trash-outline" size={18} color={theme.colors.danger} />
          </TouchableOpacity>
        </View>
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.fieldLabel}>{t('schedule.segments.start')}</Text>
        <TextInput
          style={styles.timeInput}
          value={segment.start}
          onChangeText={text => onChange(index, { start: text })}
          placeholder={t('schedule.timePlaceholder')}
          placeholderTextColor={theme.colors.textFaint}
          keyboardType="numbers-and-punctuation"
          maxLength={5}
          autoCorrect={false}
        />
        <Text style={styles.timeDash}>–</Text>
        <TextInput
          style={styles.timeInput}
          value={segment.end}
          onChangeText={text => onChange(index, { end: text })}
          placeholder={t('schedule.timePlaceholder')}
          placeholderTextColor={theme.colors.textFaint}
          keyboardType="numbers-and-punctuation"
          maxLength={5}
          autoCorrect={false}
        />
        <Text style={styles.fieldLabel}> {t('schedule.segments.end')}</Text>
      </View>
    </View>
  );
}

export default function SegmentsEditor({ segments, onChange, onAdd, onRemove, onMove, styles, theme, t }) {
  const list = Array.isArray(segments) ? segments : [];
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{t('schedule.segments.title')}</Text>
      {list.length === 0 ? <Text style={styles.empty}>{t('schedule.segments.empty')}</Text> : null}
      {list.map((segment, index) => (
        <SegmentRow
          key={segment.id || `segment-${index}`}
          segment={segment}
          index={index}
          isFirst={index === 0}
          onChange={onChange}
          onRemove={onRemove}
          onMove={onMove}
          styles={styles}
          theme={theme}
          t={t}
        />
      ))}
      <TouchableOpacity style={styles.addButton} onPress={onAdd} activeOpacity={0.8} accessibilityRole="button">
        <Ionicons name="add" size={18} color={theme.colors.accentText} />
        <Text style={styles.addButtonText}>{t('schedule.segments.add')}</Text>
      </TouchableOpacity>
      <Text style={styles.cardHint}>{t('schedule.segments.orderHint')}</Text>
    </View>
  );
}
