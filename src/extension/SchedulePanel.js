// 作息面板：为每个角色设定可选的作息（起床 / 上班 / 下班 / 睡觉 + 启用开关）。
// 作息只写提示词（普通对话与主动消息共用静态规则），不新增原生模块。
// 入口在拓展页；保存到 @easychat2_character_schedules（见 storage/schedule.js）。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';

import { useApp } from '../context/AppContext.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import PaneHeader from '../ui/PaneHeader.js';
import {
  DEFAULT_SCHEDULE,
  describeSchedule,
  normalizeSchedule,
  resolveSchedulePeriod,
} from '../chat/schedule.js';
import { getCharacterSchedule, saveCharacterSchedule } from '../storage/schedule.js';

const TIME_FIELDS = [
  { key: 'wake', labelKey: 'schedule.wake' },
  { key: 'workStart', labelKey: 'schedule.workStart' },
  { key: 'workEnd', labelKey: 'schedule.workEnd' },
  { key: 'sleep', labelKey: 'schedule.sleep' },
];

function TimeField({ label, value, onChange, styles, theme }) {
  return (
    <View style={styles.timeRow}>
      <Text style={styles.timeLabel}>{label}</Text>
      <TextInput
        style={styles.timeInput}
        value={value}
        onChangeText={onChange}
        placeholder="HH:MM"
        placeholderTextColor={theme.colors.textFaint}
        keyboardType="numbers-and-punctuation"
        maxLength={5}
        autoCorrect={false}
      />
    </View>
  );
}

export default function SchedulePanel() {
  const navigation = useNavigation();
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { characters, activeId } = useApp();

  const [roleId, setRoleId] = useState('');
  const [draft, setDraft] = useState(DEFAULT_SCHEDULE);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notice, setNotice] = useState('');

  // 默认选中当前活跃角色；角色列表变化时纠正失效选择。
  useEffect(() => {
    const ids = (Array.isArray(characters) ? characters : []).map(item => String(item && item.id || ''));
    if (ids.length === 0) {
      setRoleId('');
      return;
    }
    setRoleId(current => (current && ids.includes(current) ? current : (ids.includes(String(activeId)) ? String(activeId) : ids[0])));
  }, [characters, activeId]);

  // 切换角色时读取其作息（无则默认值）。
  useEffect(() => {
    let cancelled = false;
    if (!roleId) return undefined;
    getCharacterSchedule(roleId)
      .then(schedule => {
        if (cancelled) return;
        setDraft(schedule ? normalizeSchedule(schedule) : { ...DEFAULT_SCHEDULE });
      })
      .catch(() => {
        if (!cancelled) setDraft({ ...DEFAULT_SCHEDULE });
      });
    return () => { cancelled = true; };
  }, [roleId]);

  const activeRole = useMemo(
    () => (Array.isArray(characters) ? characters : []).find(item => item.id === roleId) || null,
    [characters, roleId]
  );

  const setField = useCallback((key, value) => {
    setDraft(current => ({ ...current, [key]: value }));
    setNotice('');
  }, []);

  const toggleEnabled = useCallback(value => {
    setDraft(current => ({ ...current, enabled: value }));
    setNotice('');
  }, []);

  const handleSave = useCallback(async () => {
    if (!roleId) return;
    try {
      const normalized = normalizeSchedule(draft);
      await saveCharacterSchedule(roleId, normalized);
      setDraft(normalized);
      setNotice(t('schedule.saved'));
    } catch (error) {
      setNotice(t('schedule.saveFailed'));
    }
  }, [roleId, draft, t]);

  const normalized = normalizeSchedule(draft);
  const period = resolveSchedulePeriod(normalized, new Date());
  const periodLabel = t(
    period === 'sleep' ? 'schedule.period.sleep'
      : period === 'work' ? 'schedule.period.work'
        : 'schedule.period.free'
  );

  return (
    <View style={styles.container}>
      <PaneHeader title={t('schedule.title')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content}>
        {!activeRole ? (
          <Text style={styles.hint}>{t('schedule.noRoles')}</Text>
        ) : (
          <>
            <TouchableOpacity
              style={styles.select}
              onPress={() => setPickerOpen(open => !open)}
              activeOpacity={0.8}
              accessibilityRole="button"
            >
              <Text style={styles.selectLabel}>{t('schedule.selectRole')}</Text>
              <Text style={styles.selectValue} numberOfLines={1}>{activeRole.name || ''}</Text>
              <Ionicons name={pickerOpen ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textFaint} />
            </TouchableOpacity>
            {pickerOpen ? (
              <View style={styles.pickerBody}>
                {(Array.isArray(characters) ? characters : []).map(item => (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.pickerRow}
                    onPress={() => { setRoleId(item.id); setPickerOpen(false); }}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.pickerText, item.id === roleId && styles.pickerTextActive]} numberOfLines={1}>
                      {item.name || ''}
                    </Text>
                    {item.id === roleId ? <Ionicons name="checkmark" size={16} color={theme.colors.primary} /> : null}
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}

            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>{t('schedule.enable')}</Text>
              <Switch value={draft.enabled === true} onValueChange={toggleEnabled} />
            </View>

            <View style={styles.timeCard}>
              {TIME_FIELDS.map(field => (
                <TimeField
                  key={field.key}
                  label={t(field.labelKey)}
                  value={String(draft[field.key] || '')}
                  onChange={text => setField(field.key, text)}
                  styles={styles}
                  theme={theme}
                />
              ))}
            </View>

            <View style={styles.previewCard}>
              <Text style={styles.previewTitle}>{t('schedule.preview')}</Text>
              <Text style={styles.previewText}>{describeSchedule(normalized)}</Text>
              {normalized.enabled ? (
                <Text style={styles.previewPeriod}>{t('schedule.currentPeriod', { period: periodLabel })}</Text>
              ) : null}
            </View>

            <Text style={styles.hint}>
              {normalized.enabled ? t('schedule.hint') : t('schedule.disabledHint')}
            </Text>

            <TouchableOpacity style={styles.saveButton} onPress={handleSave} activeOpacity={0.85}>
              <Text style={styles.saveButtonText}>{t('schedule.save')}</Text>
            </TouchableOpacity>
            {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 40 },
  select: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  selectLabel: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), marginRight: 10 },
  selectValue: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '600' },
  pickerBody: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    marginTop: 6,
    paddingVertical: 4,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  pickerText: { flex: 1, color: theme.colors.textMuted, fontSize: fonts.scaled(14) },
  pickerTextActive: { color: theme.colors.primary, fontWeight: '700' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  switchLabel: { color: theme.colors.text, fontSize: fonts.scaled(15) },
  timeCard: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.lg,
    paddingHorizontal: 14,
    paddingVertical: 4,
    marginBottom: 14,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  timeLabel: { color: theme.colors.textMuted, fontSize: fonts.scaled(15) },
  timeInput: {
    minWidth: 96,
    textAlign: 'center',
    color: theme.colors.text,
    fontSize: fonts.scaled(15),
    fontWeight: '600',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface,
  },
  previewCard: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.lg,
    padding: 14,
    marginBottom: 12,
  },
  previewTitle: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginBottom: 6 },
  previewText: { color: theme.colors.text, fontSize: fonts.scaled(14) },
  previewPeriod: { color: theme.colors.primary, fontSize: fonts.scaled(13), marginTop: 6 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 16 },
  saveButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.primary,
  },
  saveButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(15), fontWeight: '700' },
  notice: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), textAlign: 'center', marginTop: 10 },
});
