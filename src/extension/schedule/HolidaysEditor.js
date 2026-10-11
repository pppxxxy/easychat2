// 节假日日期列表编辑器：加 "YYYY-MM-DD" + 逐条删除。
//
// 假日只做「工作日 → 休息日」的加法（周末已自动算休息日）。刻意**不内置法定假日表**：
// 法定节假日每年变，内置表会静默过期，且本仓库无法联网核实日期。

import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

export default function HolidaysEditor({ holidays, draftDate, onChangeDate, onAdd, onRemove, invalid, styles, theme, t }) {
  const list = Array.isArray(holidays) ? holidays : [];
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{t('schedule.holidays.title')}</Text>
      {list.length === 0 ? <Text style={styles.empty}>{t('schedule.holidays.empty')}</Text> : null}
      <View style={styles.chipRow}>
        {list.map(key => (
          <TouchableOpacity
            key={key}
            style={styles.chip}
            onPress={() => onRemove(key)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={`${t('schedule.holidays.remove')} ${key}`}
          >
            <Text style={styles.chipText}>{key} ×</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.rowBody}>
        <TextInput
          style={styles.flexInput}
          value={draftDate}
          onChangeText={onChangeDate}
          placeholder={t('schedule.holidays.placeholder')}
          placeholderTextColor={theme.colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={10}
        />
        <View style={styles.fieldGap} />
        <TouchableOpacity style={styles.chip} onPress={onAdd} activeOpacity={0.8} accessibilityRole="button">
          <Text style={styles.chipText}>{t('schedule.holidays.add')}</Text>
        </TouchableOpacity>
      </View>
      {invalid ? <Text style={styles.cardHint}>{t('schedule.holidays.invalid')}</Text> : null}
      <Text style={styles.cardHint}>{t('schedule.holidays.hint')}</Text>
    </View>
  );
}
