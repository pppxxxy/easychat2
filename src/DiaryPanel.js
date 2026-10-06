import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import PaneHeader from './ui/PaneHeader.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';
import { useNavigation } from '@react-navigation/native';

// 日记：为每个角色单独开关「自动写日记」，并可为该角色指定写日记用的 API（不选则用默认）。
// 角色用折叠选择器挑选，避免一次罗列一大堆角色卡；每个角色对应一页，页内左右滑动翻阅日记。
// 日记在「过了一天之后的第一次启动」由 runDiaryForNewDay 生成；这里只做设置与查看。
// Stack 化后面板自带滚动容器。
export default function DiaryPanel() {
  const { theme, fonts } = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation();
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
  // 开关类控件必须「改了就落盘」（2026-10-07）：此前只改内存 state、要额外点
  // 底部保存才写盘，用户开完就走 = @easychat2_diary_settings 里 enabled 始终
  // false，执行器永远筛不到该角色，日记一篇都不会生成。
  // settingsRef 同步镜像最新设置（函数式更新里读不到最新值时用）；
  // writeChainRef 串行化写盘（防两次快速点击互相覆盖）；inFlightRef 记在途
  // 写数，离开面板前若 > 0 先等落盘再走，绝不静默丢弃。
  const settingsRef = useRef(settings);
  // 渲染期同步镜像：load() 从存储读回后若不同步，首次改开关会以空设置整表覆盖。
  settingsRef.current = settings;
  const writeChainRef = useRef(Promise.resolve());
  const inFlightRef = useRef(0);
  const leavingRef = useRef(false);
  // 翻页按钮的程序化滚动目标：按钮与手势翻页共用一个计数器，
  // 按钮只改 state 不滚 ScrollView 的话页面不会动（手势翻页仍由 onMomentumScrollEnd 回写）。
  const pagerRef = useRef(null);

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
      setNotice(t('diary.notice.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

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

  // 按钮翻页：diaryIndex 变化时同步滚动（手势滑动结束回写同值时滚动是 no-op，无循环）。
  useEffect(() => {
    if (pagerRef.current && viewWidth > 0) {
      pagerRef.current.scrollTo({ x: diaryIndex * viewWidth, animated: true });
    }
  }, [diaryIndex, viewWidth]);

  // 乐观更新 + 立即落盘（串行队列）。失败时不猜、以存储真实值为准回滚并明确
  // 提示（禁止「catch 后无条件报已保存」的反模式）；旧写的返回值只有在仍是
  // 最新一次修改时才回写 state，防止慢写覆盖新状态。
  const persistSettings = useCallback(mutate => {
    const next = mutate(settingsRef.current);
    settingsRef.current = next;
    setSettings(next);
    setNotice('');
    inFlightRef.current += 1;
    const write = writeChainRef.current
      .catch(() => {})
      .then(() => saveDiarySettings(next))
      .then(saved => {
        if (settingsRef.current === next) {
          settingsRef.current = saved;
          setSettings(saved);
          setNotice(t('diary.notice.saved'));
        }
        return saved;
      })
      .catch(async () => {
        const stored = await getDiarySettings().catch(() => null);
        if (stored) {
          settingsRef.current = stored;
          setSettings(stored);
        }
        setNotice(t('diary.notice.saveFailed'));
        return null;
      })
      .finally(() => {
        inFlightRef.current = Math.max(0, inFlightRef.current - 1);
      });
    writeChainRef.current = write;
    return write;
  }, [t]);

  const toggleRole = useCallback((id, enabled, roleName) => {
    persistSettings(current => setRoleDiarySetting(current, id, { enabled, roleName }));
  }, [persistSettings]);

  const chooseRoleApi = useCallback((id, apiConfigId) => {
    persistSettings(current => setRoleDiarySetting(current, id, { apiConfigId }));
  }, [persistSettings]);

  // 底部保存按钮保留为兜底（把当前设置整体再落一次盘），不再是唯一落盘路径。
  const save = useCallback(async () => {
    setSaving(true);
    try {
      await persistSettings(current => current);
    } finally {
      setSaving(false);
    }
  }, [persistSettings]);

  // 离开前 flush：有在途写盘时先等它落地再放行（leavingRef 防重复拦截）。
  useEffect(() => {
    if (!navigation || typeof navigation.addListener !== 'function') return undefined;
    const unsubscribe = navigation.addListener('beforeRemove', event => {
      if (leavingRef.current || inFlightRef.current === 0) return;
      event.preventDefault();
      leavingRef.current = true;
      writeChainRef.current.finally(() => {
        navigation.dispatch(event.data.action);
      });
    });
    return unsubscribe;
  }, [navigation]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  if (characters.length === 0) {
    return (
      <EmptyState
        icon="book-outline"
        title={t('diary.empty.title')}
        description={t('diary.empty.description')}
      />
    );
  }

  const roleName = (activeRole && activeRole.name) || t('diary.roleFallback');
  const roleApiName = (configs.find(item => item.id === roleSetting.apiConfigId) || {}).name || '';

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <PaneHeader title={t('diary.title')} onBack={() => navigation.goBack()} />
      <Text style={styles.hint}>
        {t('diary.intro')}
      </Text>

      {/* 折叠选择角色：避免一次把所有角色卡都列出来。 */}
      <View style={styles.collapsible}>
        <TouchableOpacity
          style={styles.collapsibleHead}
          onPress={() => setRolePickerOpen(v => !v)}
          activeOpacity={0.8}
          accessibilityRole="button"
        >
          <Text style={styles.collapsibleLabel}>{t('diary.roleLabel')}</Text>
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
                    {item.name || t('diary.unnamed')}
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
          <Text style={styles.switchLabel}>{t('diary.enableFor', { name: roleName })}</Text>
          <Text style={styles.switchHint}>{t('diary.enableHint')}</Text>
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
          <Text style={styles.collapsibleLabel}>{t('diary.apiLabel', { name: roleName })}</Text>
          <Text style={styles.collapsibleValue} numberOfLines={1}>{roleApiName || t('diary.apiDefaultShort')}</Text>
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
                {t('diary.apiDefault')}
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
              <Text style={styles.hint}>{t('diary.apiEmpty')}</Text>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* 日记翻阅：整个区域是一页一页的日记，左右滑动查看不同日期。 */}
      <View style={styles.diaryHeaderRow}>
        <Text style={styles.sectionTitle}>{t('diary.sectionTitle', { name: roleName })}</Text>
        {roleDiaries.length > 0 ? (
          <Text style={styles.diaryCounter}>{`${diaryIndex + 1} / ${roleDiaries.length}`}</Text>
        ) : null}
      </View>
      {roleDiaries.length === 0 ? (
        <Text style={styles.hint}>{t('diary.empty')}</Text>
      ) : (
        <View style={styles.diaryPager} onLayout={e => setViewWidth(e.nativeEvent.layout.width - 24)}>
          <ScrollView
            ref={pagerRef}
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
                accessibilityLabel={t('diary.prevDay')}
              >
                <Ionicons name="chevron-back" size={18} color={theme.colors.textMuted} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.diaryNavBtn, diaryIndex >= roleDiaries.length - 1 && styles.diaryNavDisabled]}
                disabled={diaryIndex >= roleDiaries.length - 1}
                onPress={() => setDiaryIndex(i => Math.min(roleDiaries.length - 1, i + 1))}
                accessibilityLabel={t('diary.nextDay')}
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
        <Text style={styles.saveButtonText}>{saving ? t('diary.saving') : t('diary.save')}</Text>
      </TouchableOpacity>
    </ScrollView>
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
