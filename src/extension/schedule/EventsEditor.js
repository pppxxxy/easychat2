// 概率事件编辑器：名称（可选）+ 时间点/时间段 + 概率 + 「要做的事」描述 + 删除 + 新增。
//
// 概率是百分数（0–100）。判定在 src/chat/schedule.js 里用确定性种子
// (角色 id, 事件 id, 日期) 完成：同一天内恒定，跨天才重新决定。

import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

function KindChip({ active, label, onPress, styles }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function EventRow({ event, index, isFirst, onChange, onRemove, styles, theme, t }) {
  const isRange = event.kind === 'range';
  return (
    <View style={[styles.row, isFirst && styles.rowFirst]}>
      <View style={styles.rowHead}>
        <TextInput
          style={styles.nameInput}
          value={event.name}
          onChangeText={text => onChange(index, { name: text })}
          placeholder={t('schedule.events.namePlaceholder')}
          placeholderTextColor={theme.colors.textFaint}
          maxLength={24}
          autoCorrect={false}
        />
        <TouchableOpacity
          style={styles.iconButton}
          onPress={() => onRemove(index)}
          accessibilityRole="button"
          accessibilityLabel={t('schedule.events.remove')}
        >
          <Ionicons name="trash-outline" size={18} color={theme.colors.danger} />
        </TouchableOpacity>
      </View>

      <View style={styles.rowBody}>
        <KindChip
          active={!isRange}
          label={t('schedule.events.kind.point')}
          onPress={() => onChange(index, { kind: 'point' })}
          styles={styles}
        />
        <KindChip
          active={isRange}
          label={t('schedule.events.kind.range')}
          onPress={() => onChange(index, { kind: 'range' })}
          styles={styles}
        />
      </View>

      <View style={styles.rowBody}>
        {isRange ? (
          <>
            <TextInput
              style={styles.timeInput}
              value={event.start}
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
              value={event.end}
              onChangeText={text => onChange(index, { end: text })}
              placeholder={t('schedule.timePlaceholder')}
              placeholderTextColor={theme.colors.textFaint}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              autoCorrect={false}
            />
          </>
        ) : (
          <TextInput
            style={styles.timeInput}
            value={event.at}
            onChangeText={text => onChange(index, { at: text })}
            placeholder={t('schedule.timePlaceholder')}
            placeholderTextColor={theme.colors.textFaint}
            keyboardType="numbers-and-punctuation"
            maxLength={5}
            autoCorrect={false}
          />
        )}
        <View style={styles.fieldGap} />
        <Text style={styles.fieldLabel}>{t('schedule.events.probability')}</Text>
        <TextInput
          style={styles.smallInput}
          value={String(event.probability)}
          onChangeText={text => onChange(index, { probability: text.replace(/[^0-9]/g, '').slice(0, 3) })}
          placeholder="50"
          placeholderTextColor={theme.colors.textFaint}
          keyboardType="number-pad"
          maxLength={3}
          autoCorrect={false}
        />
        <Text style={styles.unit}>%</Text>
      </View>

      <View style={styles.rowBody}>
        <TextInput
          style={styles.flexInput}
          value={event.description}
          onChangeText={text => onChange(index, { description: text })}
          placeholder={t('schedule.events.descriptionPlaceholder')}
          placeholderTextColor={theme.colors.textFaint}
          maxLength={120}
          autoCorrect={false}
        />
      </View>
    </View>
  );
}

export default function EventsEditor({ events, onChange, onAdd, onRemove, styles, theme, t }) {
  const list = Array.isArray(events) ? events : [];
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{t('schedule.events.title')}</Text>
      {list.length === 0 ? <Text style={styles.empty}>{t('schedule.events.empty')}</Text> : null}
      {list.map((event, index) => (
        <EventRow
          key={event.id || `event-${index}`}
          event={event}
          index={index}
          isFirst={index === 0}
          onChange={onChange}
          onRemove={onRemove}
          styles={styles}
          theme={theme}
          t={t}
        />
      ))}
      <TouchableOpacity style={styles.addButton} onPress={onAdd} activeOpacity={0.8} accessibilityRole="button">
        <Ionicons name="add" size={18} color={theme.colors.primarySoft} />
        <Text style={styles.addButtonText}>{t('schedule.events.add')}</Text>
      </TouchableOpacity>
      <Text style={styles.cardHint}>{t('schedule.events.hint')}</Text>
      <Text style={styles.cardHint}>{t('schedule.events.emptyDescriptionHint')}</Text>
    </View>
  );
}
