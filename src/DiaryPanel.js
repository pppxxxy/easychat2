import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { getDiaries, getDiarySettings, getApiConfigs, saveDiarySettings } from './storage.js';
import {
  formatDiaryDate,
  getRoleDiarySetting,
  selectDiariesForCharacter,
  setRoleDiarySetting,
} from './diary/diary.js';
import { useApp } from './context/AppContext.js';
import { EmptyState } from './ui/index.js';
import { useTheme } from './theme/ThemeContext.js';

// 日记：为每个角色单独开关「自动写日记」，并可为该角色指定写日记用的 API（不选则用默认）。
// 角色用折叠选择器挑选，避免一次罗列一大堆角色卡；每个角色对应一页，页内左右滑动翻阅日记。
// 日记在「过了一天之后的第一次启动」由 runDiaryForNewDay 生成；这里只做设置与查看。
// embedded=true 时不自带滚动容器，交给外层折叠分组滚动。
export default function DiaryPanel({ embedded = false }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const { characters } = useApp();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState(() => ({ roles: {}, apiConfigId: '', model: '', lastRunDate: '' }));
  const [configs, setConfigs] = useState([]);
  const [diaries, setDiaries] = useState([]);
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [apiPickerOpen, setApiPickerOpen] = useState(false);
  const [diaryIndex, setDiaryIndex] = useState(0);
  const [notice, setNotice] = useState('');
  const [viewWidth, setViewWidth] = useState(() => Dimensions.get('window').width - 72);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [stored, api, list] = await Promise.all([
        getDiarySettings(),
        getApiConfigs(),
        getDiaries().catch(() => []),
      ]);
      setSettings(stored);
      setConfigs(api.configs);
      setDiaries(list);
    } catch (error) {
      setNotice('读取日记设置失败，请重试。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const activeRoleId = selectedRoleId
    || (characters[0] && characters[0].id)
    || '';
  const activeRole = useMemo(
    () => characters.find(item => item.id === activeRoleId) || null,
    [characters, activeRoleId]
  );
  const roleSetting = getRoleDiarySetting(settings, activeRoleId);
  const roleDiaries = useMemo(
    () => selectDiariesForCharacter(diaries, activeRoleId),
    [diaries, activeRoleId]
  );
  // 切换角色或日记数量变化时，把翻阅位置钳制回范围内。
  useEffect(() => {
    setDiaryIndex(current => (current < roleDiaries.length ? current : 0));
  }, [roleDiaries.length, activeRoleId]);

  const toggleRole = useCallback((id, enabled, roleName) => {
    setSettings(current => setRoleDiarySetting(current, id, { enabled, roleName }));
  }, []);

  const chooseRoleApi = useCallback((id, apiConfigId) => {
    setSettings(current => setRoleDiarySetting(current, id, { apiConfigId }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setNotice('');
    try {
      const saved = await saveDiarySettings(settings);
      setSettings(saved);
      setNotice('日记设置已保存');
    } catch (error) {
      setNotice('保存失败，请检查存储空间或权限。');
    } finally {
      setSaving(false);
    }
  }, [settings]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  const Container = embedded ? View : ScrollView;
  const containerProps = embedded ? { style: styles.content } : { contentContainerStyle: styles.content };

  if (characters.length === 0) {
    return (
      <EmptyState
        icon="book-outline"
        title="还没有角色"
        description="先到「角色」页添加或导入一个角色，再回来为它开启日记。"
      />
    );
  }

  const roleName = (activeRole && activeRole.name) || '该角色';
  const roleApiName = (configs.find(item => item.id === roleSetting.apiConfigId) || {}).name || '';

  return (
    <Container {...containerProps}>
      <Text style={styles.title}>日记</Text>
      <Text style={styles.hint}>
        开启后，角色会在「过了一天的第一次启动」时，为前一天与你的对话写一篇日记。
        每个角色单独设置，写日记用的 API 可为该角色单独指定，不选则用默认配置。
      </Text>

      {/* 折叠选择角色：避免一次把所有角色卡都列出来。 */}
      <View style={styles.collapsible}>
        <TouchableOpacity
          style={styles.collapsibleHead}
          onPress={() => setRolePickerOpen(v => !v)}
          activeOpacity={0.8}
          accessibilityRole="button"
        >
          <Text style={styles.collapsibleLabel}>选择角色</Text>
          <Text style={styles.collapsibleValue} numberOfLines={1}>{roleName}</Text>
          <Ionicons name={rolePickerOpen ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textFaint} />
        </TouchableOpacity>
        {rolePickerOpen ? (
          <View style={styles.collapsibleBody}>
            {characters.map(item => {
              const on = getRoleDiarySetting(settings, item.id).enabled === true;
              const active = item.id === activeRoleId;
              return (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.optionRow, active && styles.optionRowActive]}
                  onPress={() => { setSelectedRoleId(item.id); setRolePickerOpen(false); }}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.optionText, active && styles.optionTextActive]} numberOfLines={1}>
                    {item.name || '未命名'}
                  </Text>
                  {on ? <Ionicons name="book" size={14} color={theme.colors.primary} /> : null}
                  {active ? <Ionicons name="checkmark" size={16} color={theme.colors.primary} style={styles.optionCheck} /> : null}
                </TouchableOpacity>
              );
            })}
          </View>
        ) : null}
      </View>

      {/* 当前角色设置：开关 + 专属 API 折叠选择 */}
      <View style={styles.switchRow}>
        <View style={styles.switchLabelWrap}>
          <Text style={styles.switchLabel}>{`让「${roleName}」写日记`}</Text>
          <Text style={styles.switchHint}>开启后该角色才会自动生成日记</Text>
        </View>
        <Switch
          value={roleSetting.enabled === true}
          onValueChange={value => toggleRole(activeRoleId, value, (activeRole && activeRole.name) || '')}
          trackColor={{ true: theme.colors.primary, false: theme.colors.surfaceBorder }}
        />
      </View>

      <View style={styles.collapsible}>
        <TouchableOpacity
          style={styles.collapsibleHead}
          onPress={() => setApiPickerOpen(v => !v)}
          activeOpacity={0.8}
          accessibilityRole="button"
        >
          <Text style={styles.collapsibleLabel}>{`「${roleName}」的写日记 API`}</Text>
          <Text style={styles.collapsibleValue} numberOfLines={1}>{roleApiName || '默认（当前配置）'}</Text>
          <Ionicons name={apiPickerOpen ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textFaint} />
        </TouchableOpacity>
        {apiPickerOpen ? (
          <View style={styles.collapsibleBody}>
            <TouchableOpacity
              style={[styles.optionRow, !roleSetting.apiConfigId && styles.optionRowActive]}
              onPress={() => { chooseRoleApi(activeRoleId, ''); setApiPickerOpen(false); }}
              activeOpacity={0.85}
            >
              <Text style={[styles.optionText, !roleSetting.apiConfigId && styles.optionTextActive]}>
                默认（当前激活配置）
              </Text>
              {!roleSetting.apiConfigId ? <Ionicons name="checkmark" size={16} color={theme.colors.primary} /> : null}
            </TouchableOpacity>
            {configs.map(item => {
              const active = roleSetting.apiConfigId === item.id;
              return (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.optionRow, active && styles.optionRowActive]}
                  onPress={() => { chooseRoleApi(activeRoleId, item.id); setApiPickerOpen(false); }}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.optionText, active && styles.optionTextActive]} numberOfLines={1}>{item.name}</Text>
                  {active ? <Ionicons name="checkmark" size={16} color={theme.colors.primary} /> : null}
                </TouchableOpacity>
              );
            })}
            {configs.length === 0 ? (
              <Text style={styles.hint}>还没有 API 配置，将使用「设置」里的当前激活配置。</Text>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* 日记翻阅：整个区域是一页一页的日记，左右滑动查看不同日期。 */}
      <View style={styles.diaryHeaderRow}>
        <Text style={styles.sectionTitle}>{`${roleName}的日记`}</Text>
        {roleDiaries.length > 0 ? (
          <Text style={styles.diaryCounter}>{`${diaryIndex + 1} / ${roleDiaries.length}`}</Text>
        ) : null}
      </View>
      {roleDiaries.length === 0 ? (
        <Text style={styles.hint}>还没有日记。开启后，等过一天再启动应用就会生成。</Text>
      ) : (
        <View style={styles.diaryPager} onLayout={e => setViewWidth(e.nativeEvent.layout.width - 24)}>
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={e => {
              const width = e.nativeEvent.layoutMeasurement.width || viewWidth;
              setDiaryIndex(Math.round(e.nativeEvent.contentOffset.x / width));
            }}
          >
            {roleDiaries.map(entry => (
              <View key={entry.id} style={[styles.diaryPage, { width: viewWidth }]}>
                <Text style={styles.diaryDate}>{formatDiaryDate(entry.date)}</Text>
                <ScrollView style={styles.diaryPageScroll} nestedScrollEnabled>
                  <Text style={styles.diaryText}>{entry.text}</Text>
                </ScrollView>
              </View>
            ))}
          </ScrollView>
          {roleDiaries.length > 1 ? (
            <View style={styles.diaryNav}>
              <TouchableOpacity
                style={[styles.diaryNavBtn, diaryIndex <= 0 && styles.diaryNavDisabled]}
                disabled={diaryIndex <= 0}
                onPress={() => setDiaryIndex(i => Math.max(0, i - 1))}
                accessibilityLabel="上一天"
              >
                <Ionicons name="chevron-back" size={18} color={theme.colors.textMuted} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.diaryNavBtn, diaryIndex >= roleDiaries.length - 1 && styles.diaryNavDisabled]}
                disabled={diaryIndex >= roleDiaries.length - 1}
                onPress={() => setDiaryIndex(i => Math.min(roleDiaries.length - 1, i + 1))}
                accessibilityLabel="下一天"
              >
                <Ionicons name="chevron-forward" size={18} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      )}

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <TouchableOpacity
        style={[styles.saveButton, saving && styles.saveButtonDisabled]}
        onPress={save}
        disabled={saving}
        activeOpacity={0.85}
      >
        <Text style={styles.saveButtonText}>{saving ? '保存中…' : '保存设置'}</Text>
      </TouchableOpacity>
    </Container>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 200 },
  content: { paddingHorizontal: 20, paddingBottom: 40 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800', marginTop: 6 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginTop: 8 },
  sectionTitle: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700' },
  collapsible: {
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 10,
    backgroundColor: theme.colors.surface,
    marginTop: 12,
    overflow: 'hidden',
  },
  collapsibleHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  collapsibleLabel: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), fontWeight: '600' },
  collapsibleValue: { flex: 1, textAlign: 'right', marginLeft: 10, marginRight: 8, color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  collapsibleBody: { borderTopWidth: 1, borderTopColor: theme.colors.surfaceBorder, paddingVertical: 4 },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  optionRowActive: { backgroundColor: theme.colors.surfaceAlt },
  optionText: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(13) },
  optionTextActive: { color: theme.colors.primary, fontWeight: '700' },
  optionCheck: { marginLeft: 6 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    padding: 12,
    marginTop: 12,
  },
  switchLabelWrap: { flex: 1, marginRight: 12 },
  switchLabel: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700' },
  switchHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 4 },
  diaryHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 20,
  },
  diaryCounter: { color: theme.colors.textFaint, fontSize: fonts.scaled(12) },
  diaryPager: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 10,
    backgroundColor: theme.colors.surface,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  diaryPage: { paddingRight: 0 },
  diaryPageScroll: { maxHeight: 320, marginTop: 4 },
  diaryDate: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(13), fontWeight: '800' },
  diaryText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(21) },
  diaryNav: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 },
  diaryNavBtn: { padding: 6, marginLeft: 8 },
  diaryNavDisabled: { opacity: 0.3 },
  notice: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(12), marginTop: 14 },
  saveButton: {
    marginTop: 22,
    backgroundColor: theme.colors.primary,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  saveButtonDisabled: { opacity: 0.6 },
  saveButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '800' },
});
