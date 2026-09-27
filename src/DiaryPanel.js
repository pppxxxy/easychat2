import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { getDiaries, getDiarySettings, getApiConfigs, saveDiarySettings } from './storage';
import {
  formatDiaryDate,
  getRoleDiarySetting,
  normalizeDiarySettings,
  selectDiariesForCharacter,
  setRoleDiaryEnabled,
} from './diary/diary';
import { useApp } from './context/AppContext';
import { EmptyState } from './ui';
import { useTheme } from './theme/ThemeContext';

// 日记：为每个角色单独开关「自动写日记」，并选择一个写日记用的 API。
// 日记在「过了一天之后的第一次启动」由 runDiaryForNewDay 生成；这里只做设置与查看。
// embedded=true 时不自带滚动容器，交给外层折叠分组滚动。
export default function DiaryPanel({ embedded = false }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const { characters } = useApp();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState(() => normalizeDiarySettings(null));
  const [configs, setConfigs] = useState([]);
  const [diaries, setDiaries] = useState([]);
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [notice, setNotice] = useState('');

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

  const toggleRole = useCallback((id, enabled, roleName) => {
    setSettings(current => setRoleDiaryEnabled(current, id, enabled, roleName));
  }, []);

  const chooseConfig = useCallback(id => {
    setSettings(current => ({ ...normalizeDiarySettings(current), apiConfigId: id }));
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

  // 无角色时不渲染选择区，避免出现空白的“选择角色”
  if (characters.length === 0) {
    return (
      <EmptyState
        icon="book-outline"
        title="还没有角色"
        description="先到「角色」页添加或导入一个角色，再回来为它开启日记。"
      />
    );
  }

  return (
    <Container {...containerProps}>
      <Text style={styles.title}>日记</Text>
      <Text style={styles.hint}>
        开启后，角色会在「过了一天的第一次启动」时，为前一天与你的对话写一篇日记。
        每个角色单独开关，写日记用的模型可在这里指定。
      </Text>

      <Text style={styles.sectionTitle}>选择角色</Text>
      <View style={styles.chipWrap}>
        {characters.map(item => {
          const on = getRoleDiarySetting(settings, item.id).enabled === true;
          return (
            <TouchableOpacity
              key={item.id}
              style={[styles.chip, item.id === activeRoleId && styles.chipActive]}
              onPress={() => setSelectedRoleId(item.id)}
              activeOpacity={0.85}
            >
              <Text style={[styles.chipText, item.id === activeRoleId && styles.chipTextActive]}>
                {item.name || '未命名'}
              </Text>
              {on ? <Ionicons name="book" size={12} color={theme.colors.primary} style={styles.chipBadge} /> : null}
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.switchRow}>
        <View style={styles.switchLabelWrap}>
          <Text style={styles.switchLabel}>
            {`让「${(activeRole && activeRole.name) || '该角色'}」写日记`}
          </Text>
          <Text style={styles.switchHint}>开启后该角色才会自动生成日记</Text>
        </View>
        <Switch
          value={roleSetting.enabled === true}
          onValueChange={value => toggleRole(activeRoleId, value, (activeRole && activeRole.name) || '')}
          trackColor={{ true: theme.colors.primary, false: theme.colors.surfaceBorder }}
        />
      </View>

      <Text style={styles.sectionTitle}>写日记的模型</Text>
      {configs.length === 0 ? (
        <Text style={styles.hint}>还没有 API 配置，请先到设置页添加。若留空则使用当前激活配置。</Text>
      ) : (
        <View style={styles.chipWrap}>
          {configs.map(item => {
            const active = settings.apiConfigId === item.id;
            return (
              <TouchableOpacity
                key={item.id}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => chooseConfig(item.id)}
                activeOpacity={0.85}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{item.name}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      <Text style={styles.hint}>未选择时使用「设置」里当前激活的 API 配置。</Text>

      <Text style={styles.sectionTitle}>
        {`${(activeRole && activeRole.name) || '该角色'}的日记（${roleDiaries.length}）`}
      </Text>
      {roleDiaries.length === 0 ? (
        <Text style={styles.hint}>还没有日记。开启后，等过一天再启动应用就会生成。</Text>
      ) : (
        roleDiaries.map(entry => (
          <View key={entry.id} style={styles.diaryCard}>
            <Text style={styles.diaryDate}>{formatDiaryDate(entry.date)}</Text>
            <Text style={styles.diaryText}>{entry.text}</Text>
          </View>
        ))
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
  sectionTitle: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', marginTop: 20 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    marginRight: 8,
    marginBottom: 8,
  },
  chipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600' },
  chipTextActive: { color: theme.colors.primaryContrast },
  chipBadge: { marginLeft: 6 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    padding: 12,
    marginTop: 16,
  },
  switchLabelWrap: { flex: 1, marginRight: 12 },
  switchLabel: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700' },
  switchHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 4 },
  diaryCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    padding: 12,
    marginTop: 10,
  },
  diaryDate: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginBottom: 6 },
  diaryText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(20) },
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
