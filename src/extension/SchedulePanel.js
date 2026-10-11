// 作息面板：为每个角色设定可选的作息。
//
// 模型（见 src/chat/schedule.js 的 v2 schema）：
//   · 时间段可增删改：名称任意（上学 / 喝咖啡 …）+ 起止时间，支持跨零点；
//     列表顺序 = 命中优先级（重叠取第一个命中，都不命中算空闲）。
//   · 概率事件：某个时间点或某个时间段 + 概率（0–100%）+ 「要做的事」描述。
//     判定用确定性种子（角色 id + 事件 id + 日期），同一天内恒定、跨天才变。
//   · 「区分工作日/休息日」开关：开启后作息分两套，周末与自定义节假日走休息日那套。
//   · 节假日 = 用户可编辑的日期列表（不内置法定假日表）。
// 作息只写提示词（普通对话 / 定时任务 / 主动消息共用），不新增原生模块。
// 存储 @easychat2_character_schedules（见 storage/schedule.js，旧四时刻数据读到时自动迁移）。
// 子编辑器在 ./schedule/ 下（与设置卡片拆到 src/settings/sections/*.js 同一做法）。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ScrollView,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';

import { useApp } from '../context/AppContext.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import PaneHeader from '../ui/PaneHeader.js';
import { createDefaultSchedule, normalizeSchedule } from '../chat/schedule.js';
import { getCharacterSchedule, saveCharacterSchedule } from '../storage/schedule.js';
import EventsEditor from './schedule/EventsEditor.js';
import HolidaysEditor from './schedule/HolidaysEditor.js';
import SegmentsEditor from './schedule/SegmentsEditor.js';
import { createScheduleStyles } from './schedule/styles.js';
import { currentPeriodText, schedulePreviewLines } from './schedule/preview.js';
import {
  addEvent,
  addHoliday,
  addSegment,
  moveSegment,
  removeEvent,
  removeHoliday,
  removeSegment,
  setEnabled,
  setSplitWeekday,
  updateEvent,
  updateSegment,
} from './schedule/draftOps.js';

const DAY_TABS = [['workday', 'schedule.dayKind.workday'], ['restday', 'schedule.dayKind.restday']];

export default function SchedulePanel() {
  const navigation = useNavigation();
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createScheduleStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { characters, activeId } = useApp();

  const [roleId, setRoleId] = useState('');
  const [draft, setDraft] = useState(createDefaultSchedule);
  const [dayKind, setDayKind] = useState('workday');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [holidayDraft, setHolidayDraft] = useState('');
  const [holidayInvalid, setHolidayInvalid] = useState(false);
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

  // 切换角色时读取其作息（无则默认值；旧四时刻数据由 normalizeSchedule 迁移）。
  useEffect(() => {
    let cancelled = false;
    if (!roleId) return undefined;
    setDayKind('workday');
    setHolidayDraft('');
    setHolidayInvalid(false);
    getCharacterSchedule(roleId)
      .then(schedule => {
        if (cancelled) return;
        setDraft(schedule ? normalizeSchedule(schedule) : createDefaultSchedule());
      })
      .catch(() => {
        if (!cancelled) setDraft(createDefaultSchedule());
      });
    return () => { cancelled = true; };
  }, [roleId]);

  const activeRole = useMemo(
    () => (Array.isArray(characters) ? characters : []).find(item => item.id === roleId) || null,
    [characters, roleId]
  );

  // 所有草稿改动都走 draftOps 的纯函数（不可变更新），并清掉上一次的提示。
  const apply = useCallback(updater => {
    setDraft(current => updater(current));
    setNotice('');
  }, []);

  const day = dayKind === 'restday' ? draft.restday : draft.workday;

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

  const handleAddHoliday = useCallback(() => {
    const result = addHoliday(draft, holidayDraft);
    setHolidayInvalid(!result.ok);
    if (result.ok) {
      setDraft(result.draft);
      setHolidayDraft('');
      setNotice('');
    }
  }, [draft, holidayDraft]);

  const normalized = normalizeSchedule(draft);
  const previewLines = schedulePreviewLines(normalized, t);
  const periodLabel = currentPeriodText(normalized, t, new Date());

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
              <View style={styles.switchLabel}>
                <Text style={styles.switchTitle}>{t('schedule.enable')}</Text>
                <Text style={styles.switchSubLabel}>{t('schedule.enableHint')}</Text>
              </View>
              <Switch value={draft.enabled === true} onValueChange={value => apply(current => setEnabled(current, value))} />
            </View>

            <View style={styles.switchRow}>
              <View style={styles.switchLabel}>
                <Text style={styles.switchTitle}>{t('schedule.splitWeekday')}</Text>
                <Text style={styles.switchSubLabel}>{t('schedule.splitWeekdayHint')}</Text>
              </View>
              <Switch value={draft.splitWeekday === true} onValueChange={value => apply(current => setSplitWeekday(current, value))} />
            </View>

            {draft.splitWeekday ? (
              <View style={styles.tabs}>
                {DAY_TABS.map(([kind, key]) => (
                  <TouchableOpacity
                    key={kind}
                    style={[styles.tab, dayKind === kind && styles.tabActive]}
                    onPress={() => setDayKind(kind)}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityState={{ selected: dayKind === kind }}
                  >
                    <Text style={[styles.tabText, dayKind === kind && styles.tabTextActive]}>{t(key)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null}

            <SegmentsEditor
              segments={day.segments}
              onChange={(index, patch) => apply(current => updateSegment(current, dayKind, index, patch))}
              onAdd={() => apply(current => addSegment(current, dayKind))}
              onRemove={index => apply(current => removeSegment(current, dayKind, index))}
              onMove={(index, delta) => apply(current => moveSegment(current, dayKind, index, delta))}
              styles={styles}
              theme={theme}
              t={t}
            />

            <EventsEditor
              events={day.events}
              onChange={(index, patch) => apply(current => updateEvent(current, dayKind, index, patch))}
              onAdd={() => apply(current => addEvent(current, dayKind))}
              onRemove={index => apply(current => removeEvent(current, dayKind, index))}
              styles={styles}
              theme={theme}
              t={t}
            />

            {draft.splitWeekday ? (
              <HolidaysEditor
                holidays={draft.holidays}
                draftDate={holidayDraft}
                onChangeDate={text => { setHolidayDraft(text); setHolidayInvalid(false); }}
                onAdd={handleAddHoliday}
                onRemove={key => apply(current => removeHoliday(current, key))}
                invalid={holidayInvalid}
                styles={styles}
                theme={theme}
                t={t}
              />
            ) : null}

            <View style={styles.previewCard}>
              <Text style={styles.previewTitle}>{t('schedule.preview')}</Text>
              {previewLines.map((line, index) => (
                <Text key={`preview-${index}`} style={styles.previewText}>{line}</Text>
              ))}
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
