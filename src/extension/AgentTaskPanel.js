// 定时 Agent 任务面板：为角色设置「每天 X 点执行一段 Agent 任务」。
//
// 与「主动消息」面板的区别：这里执行的是带工具的 Agent 循环（联网搜索 + 只读工作区），
// 需要回到 JS 运行；因此调度复用原生 ProactiveMessage（executor=AGENT 时前台服务唤醒
// Headless JS），任务配置存在 @easychat2_agent_tasks。
//
// 入口在拓展页（ext-agent-task）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
  cancelAgentTask,
  isAgentTaskNativeAvailable,
  scheduleAgentTask,
} from '../agent/task/agentTaskNative.js';
import {
  makeAgentTaskId,
  normalizeAgentTask,
  parseAgentTaskTimeInput,
  rolePersonaFromCharacter,
} from '../agent/task/taskModel.js';
import {
  getAgentTasks,
  saveAgentTasks,
} from '../storage/agentTasks.js';
import {
  canScheduleExactAlarms,
  getPermissionStatus,
  openExactAlarmSettings,
  requestNotificationPermission,
} from '../proactive/proactiveMessage.js';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function CollapsibleSelect({ label, value, options, onSelect, styles, theme }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.selectWrap}>
      <TouchableOpacity
        style={styles.select}
        onPress={() => setOpen(current => !current)}
        activeOpacity={0.8}
        accessibilityRole="button"
      >
        <Text style={styles.selectLabel}>{label}</Text>
        <Text style={styles.selectValue} numberOfLines={1}>{value}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textFaint} />
      </TouchableOpacity>
      {open ? (
        <View style={styles.pickerBody}>
          {options.map(option => (
            <TouchableOpacity
              key={option.value || '__empty'}
              style={styles.pickerRow}
              onPress={() => { onSelect(option.value); setOpen(false); }}
              activeOpacity={0.8}
            >
              <Text style={styles.pickerText} numberOfLines={1}>{option.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export default function AgentTaskPanel() {
  const navigation = useNavigation();
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { characters, sessions } = useApp();

  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [selectedRoleId, setSelectedRoleId] = useState('');
  // 时间输入框的原始文本：受控于 task.hour/minute 会在输入中途（如「0」「08」）被格式化回填，
  // 导致无法连续输入。用一个草稿态承接输入，失焦时再规整为「HH:MM」。
  const [timeDrafts, setTimeDrafts] = useState({});
  const persistedIdsRef = useRef([]);

  const available = isAgentTaskNativeAvailable();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const stored = await getAgentTasks().catch(() => []);
      setTasks(stored);
      persistedIdsRef.current = stored.map(item => item.taskId);
    } catch (error) {
      setNotice(t('agentTask.notice.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const roleList = useMemo(
    () => (Array.isArray(characters) ? characters : []).map(item => ({ id: item.id, name: item.name || '' })),
    [characters]
  );
  const activeRoleId = selectedRoleId
    || (roleList[0] && roleList[0].id)
    || '';

  const roleTasks = useMemo(
    () => tasks.filter(item => item.roleId === activeRoleId),
    [tasks, activeRoleId]
  );

  const sessionOptions = useMemo(() => {
    const list = (Array.isArray(sessions) ? sessions : [])
      .filter(item => item && item.type !== 'group' && item.characterId === activeRoleId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(item => ({ value: String(item.id || ''), label: String(item.preview || '').trim() || t('proactive.session.empty') }));
    return [{ value: '', label: t('proactive.session.new') }, ...list];
  }, [sessions, activeRoleId, t]);

  const sessionLabel = useCallback(value => {
    const found = sessionOptions.find(option => option.value === String(value || ''));
    return found ? found.label : t('proactive.session.new');
  }, [sessionOptions, t]);

  const updateTask = useCallback((taskId, patch) => {
    setTasks(prev => prev.map(item => (item.taskId === taskId ? { ...item, ...patch } : item)));
    setNotice('');
  }, []);

  const addTask = useCallback(() => {
    const character = roleList.find(item => item.id === activeRoleId);
    if (!character) return;
    const full = (Array.isArray(characters) ? characters : []).find(item => item.id === activeRoleId);
    setTasks(prev => [...prev, normalizeAgentTask({
      taskId: makeAgentTaskId(),
      roleId: character.id,
      roleName: character.name,
      persona: full ? rolePersonaFromCharacter(full) : '',
      hour: 8,
      minute: 0,
      mode: 'EXACT',
      enabled: true,
      instruction: '',
      sessionTargetId: '',
      revision: '',
    })]);
  }, [roleList, activeRoleId, characters]);

  const removeTask = useCallback(taskId => {
    setTasks(prev => prev.filter(item => item.taskId !== taskId));
  }, []);

  const save = useCallback(async () => {
    if (!available) {
      setNotice(t('agentTask.notice.nativeUnavailable'));
      return;
    }
    setSaving(true);
    setNotice('');
    const newIdsThisRun = [];
    try {
      // 1. 取消本次被删除的任务。
      const removed = persistedIdsRef.current.filter(id => !tasks.some(item => item.taskId === id));
      for (const taskId of removed) {
        await cancelAgentTask(taskId).catch(() => {});
      }

      // 2. 逐条排定原生并规整会话绑定。
      const persisted = [];
      for (const task of tasks) {
        const character = (Array.isArray(characters) ? characters : []).find(item => item.id === task.roleId);
        const boundId = String(task.sessionTargetId || '');
        const boundValid = boundId && (Array.isArray(sessions) ? sessions : []).some(item => (
          item && item.type !== 'group'
          && String(item.id || '') === boundId
          && String(item.characterId || '') === String(task.roleId || '')
        ));
        const normalized = normalizeAgentTask({
          ...task,
          roleName: (character && character.name) || task.roleName,
          persona: character ? rolePersonaFromCharacter(character) : task.persona,
          sessionTargetId: boundValid ? boundId : '',
          // 每次保存换新 revision，让队列中未执行的旧配置自动失效。
          revision: makeAgentTaskId(),
        });
        if (!character) continue;
        if (!persistedIdsRef.current.includes(normalized.taskId)) newIdsThisRun.push(normalized.taskId);
        await scheduleAgentTask({
          ...normalized,
          avatarUri: (character && character.avatarUri) || '',
        });
        persisted.push(normalized);
      }

      const saved = await saveAgentTasks(persisted);
      persistedIdsRef.current = saved.map(item => item.taskId);
      setTasks(saved);
      setNotice(t('agentTask.notice.saved', { n: saved.filter(item => item.enabled).length }));
    } catch (error) {
      // 回滚本轮新排进原生的任务，避免留下 JS 无记录的幽灵定时任务。
      for (const taskId of newIdsThisRun) {
        await cancelAgentTask(taskId).catch(() => {});
      }
      setNotice(t('agentTask.notice.saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [available, tasks, characters, sessions, t]);

  const requestNotification = useCallback(async () => {
    const granted = await requestNotificationPermission();
    setNotice(granted ? t('agentTask.notice.notificationGranted') : t('agentTask.notice.notificationDenied'));
  }, [t]);

  const ensureExactAlarm = useCallback(async () => {
    if (await canScheduleExactAlarms().catch(() => false)) {
      setNotice(t('agentTask.notice.exactAlarmOk'));
      return;
    }
    await openExactAlarmSettings().catch(() => {});
    setNotice(t('agentTask.notice.exactAlarmGuide'));
  }, [t]);

  // 权限状态一次性读取，用于顶部提示（不阻塞界面）。
  const [permissionOk, setPermissionOk] = useState(true);
  useEffect(() => {
    let cancelled = false;
    getPermissionStatus()
      .then(status => {
        if (!cancelled) setPermissionOk(status.notification !== false);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const renderTask = task => {
    return (
      <View key={task.taskId} style={styles.taskCard}>
        <View style={styles.taskHead}>
          <TextInput
            style={styles.timeInput}
            value={timeDrafts[task.taskId] !== undefined
              ? timeDrafts[task.taskId]
              : `${pad2(task.hour)}:${pad2(task.minute)}`}
            onChangeText={text => {
              setTimeDrafts(prev => ({ ...prev, [task.taskId]: text }));
              updateTask(task.taskId, parseAgentTaskTimeInput(text, `${pad2(task.hour)}:${pad2(task.minute)}`));
            }}
            onBlur={() => setTimeDrafts(prev => {
              const next = { ...prev };
              delete next[task.taskId];
              return next;
            })}
            placeholder="08:00"
            placeholderTextColor={theme.colors.textFaint}
            keyboardType="numbers-and-punctuation"
            maxLength={5}
            autoCorrect={false}
          />
          <View style={styles.modeRow}>
            {['WORK', 'EXACT'].map(modeId => {
              const active = (task.mode || 'EXACT') === modeId;
              return (
                <TouchableOpacity
                  key={modeId}
                  style={[styles.modeChip, active && styles.modeChipActive]}
                  onPress={() => updateTask(task.taskId, { mode: modeId })}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.modeChipText, active && styles.modeChipTextActive]}>
                    {t(modeId === 'EXACT' ? 'agentTask.mode.exact' : 'agentTask.mode.work')}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Switch
            value={task.enabled === true}
            onValueChange={value => updateTask(task.taskId, { enabled: value })}
          />
          <TouchableOpacity onPress={() => removeTask(task.taskId)} activeOpacity={0.7} style={styles.removeBtn}>
            <Ionicons name="trash-outline" size={18} color={theme.colors.textFaint} />
          </TouchableOpacity>
        </View>

        <TextInput
          style={styles.instructionInput}
          value={String(task.instruction || '')}
          onChangeText={text => updateTask(task.taskId, { instruction: text })}
          placeholder={t('agentTask.instruction.placeholder')}
          placeholderTextColor={theme.colors.textFaint}
          multiline
          autoCorrect={false}
        />

        <CollapsibleSelect
          label={t('agentTask.session.label')}
          value={sessionLabel(task.sessionTargetId)}
          options={sessionOptions}
          onSelect={value => updateTask(task.taskId, { sessionTargetId: value })}
          styles={styles}
          theme={theme}
        />
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <PaneHeader title={t('agentTask.title')} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? (
          <ActivityIndicator color={theme.colors.primary} style={styles.loading} />
        ) : roleList.length === 0 ? (
          <Text style={styles.hint}>{t('agentTask.noRoles')}</Text>
        ) : (
          <>
            {!available ? <Text style={styles.warning}>{t('agentTask.nativeUnavailable')}</Text> : null}
            {available && !permissionOk ? (
              <View style={styles.permCard}>
                <Text style={styles.permText}>{t('agentTask.permission.notification')}</Text>
                <TouchableOpacity style={styles.permBtn} onPress={requestNotification} activeOpacity={0.85}>
                  <Text style={styles.permBtnText}>{t('agentTask.permission.grant')}</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            <CollapsibleSelect
              label={t('agentTask.selectRole')}
              value={(roleList.find(item => item.id === activeRoleId) || {}).name || ''}
              options={roleList.map(item => ({ value: item.id, label: item.name }))}
              onSelect={setSelectedRoleId}
              styles={styles}
              theme={theme}
            />

            <Text style={styles.sectionLabel}>{t('agentTask.tasksForRole')}</Text>
            {roleTasks.length === 0 ? (
              <Text style={styles.empty}>{t('agentTask.empty')}</Text>
            ) : roleTasks.map(renderTask)}

            <TouchableOpacity style={styles.addBtn} onPress={addTask} activeOpacity={0.85}>
              <Ionicons name="add" size={18} color={theme.colors.primary} />
              <Text style={styles.addBtnText}>{t('agentTask.add')}</Text>
            </TouchableOpacity>

            <Text style={styles.hint}>{t('agentTask.hint')}</Text>
            {available ? (
              <TouchableOpacity onPress={ensureExactAlarm} activeOpacity={0.7}>
                <Text style={styles.link}>{t('agentTask.exactAlarmLink')}</Text>
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity
              style={[styles.saveButton, saving && styles.saveButtonDisabled]}
              onPress={save}
              disabled={saving}
              activeOpacity={0.85}
            >
              <Text style={styles.saveButtonText}>
                {saving ? t('agentTask.saving') : t('agentTask.save')}
              </Text>
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
  loading: { marginTop: 40 },
  warning: { color: theme.colors.danger || '#ff9b9b', fontSize: fonts.scaled(13), marginBottom: 12 },
  permCard: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    padding: 12,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  permText: { flex: 1, color: theme.colors.textMuted, fontSize: fonts.scaled(13), marginRight: 10 },
  permBtn: { paddingVertical: 7, paddingHorizontal: 14, borderRadius: tokens.radius.md, backgroundColor: theme.colors.primary },
  permBtnText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '700' },
  selectWrap: { marginBottom: 12 },
  select: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  selectLabel: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), marginRight: 10 },
  selectValue: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '600' },
  pickerBody: { backgroundColor: theme.colors.surfaceAlt, borderRadius: tokens.radius.md, marginTop: 6, paddingVertical: 4 },
  pickerRow: { paddingVertical: 10, paddingHorizontal: 12 },
  pickerText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14) },
  sectionLabel: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(12), fontWeight: '800', marginTop: 8, marginBottom: 8, letterSpacing: 0.4 },
  empty: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), marginBottom: 12 },
  taskCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: 12,
    marginBottom: 12,
  },
  taskHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  timeInput: {
    minWidth: 72,
    textAlign: 'center',
    color: theme.colors.text,
    fontSize: fonts.scaled(15),
    fontWeight: '700',
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  modeRow: { flexDirection: 'row', marginLeft: 8, flex: 1 },
  modeChip: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    marginRight: 6,
  },
  modeChipActive: { backgroundColor: theme.colors.primary },
  modeChipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600' },
  modeChipTextActive: { color: theme.colors.primaryContrast },
  removeBtn: { padding: 6, marginLeft: 4 },
  instructionInput: {
    minHeight: 64,
    color: theme.colors.text,
    fontSize: fonts.scaled(14),
    lineHeight: fonts.scaled(20),
    padding: 10,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    textAlignVertical: 'top',
    marginBottom: 10,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primaryMuted,
    borderStyle: 'dashed',
    marginBottom: 16,
  },
  addBtnText: { color: theme.colors.primary, fontSize: fonts.scaled(14), fontWeight: '700', marginLeft: 6 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 12 },
  link: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), marginBottom: 16 },
  saveButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.primary,
  },
  saveButtonDisabled: { opacity: 0.6 },
  saveButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(15), fontWeight: '700' },
  notice: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), textAlign: 'center', marginTop: 10 },
});
