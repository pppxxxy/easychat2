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

import { normalizeChatUrl } from './api';
import {
  getProactiveSettings,
  makeProactiveSlotId,
  saveProactiveSettings,
  getApiConfigs,
} from './storage';
import {
  cancelDailySchedule,
  canScheduleExactAlarms,
  isProactiveMessageAvailable,
  openAutostartSettings,
  openBatteryOptimizationSettings,
  openExactAlarmSettings,
  requestNotificationPermission,
  scheduleDailyMessage,
  setProactiveApiSettings,
} from './proactiveMessage';
import { useApp } from './context/AppContext';
import { useTheme } from './theme/ThemeContext';

// 互动：让角色在指定时间主动发消息。面板负责编辑（角色 / 多个时间 / 模式 / API 来源），
// 实际调度交给原生（WorkManager 或精确闹钟），原生侧另存一份配置供后台发送。
function rolePersona(character) {
  const parts = [character.systemPrompt, character.description, character.personality, character.scenario]
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return parts.join('；');
}

function TimeField({ value, onCommit, theme, styles }) {
  const [text, setText] = useState(String(value).padStart(2, '0'));
  useEffect(() => {
    setText(String(value).padStart(2, '0'));
  }, [value]);
  return (
    <TextInput
      style={styles.timeInput}
      value={text}
      keyboardType="number-pad"
      maxLength={2}
      onChangeText={setText}
      onBlur={() => onCommit(text)}
      placeholderTextColor={theme.colors.textFaint}
    />
  );
}

// embedded=true 时不自带滚动容器，交给外层折叠分组滚动
export default function ProactivePanel({ embedded = false }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const { characters } = useApp();
  const available = isProactiveMessageAvailable();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [slots, setSlots] = useState([]);
  const [configs, setConfigs] = useState([]);
  const [configId, setConfigId] = useState('');
  const [model, setModel] = useState('');
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [exactAlarmAllowed, setExactAlarmAllowed] = useState(true);
  const [notice, setNotice] = useState('');
  // 已持久化的槽 id：保存时用于取消被删除的槽
  const persistedSlotIdsRef = useRef([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settings, api] = await Promise.all([getProactiveSettings(), getApiConfigs()]);
      setSlots(settings.slots);
      persistedSlotIdsRef.current = settings.slots.map(item => item.slotId);
      setConfigs(api.configs);
      const nextConfigId = api.configs.some(item => item.id === settings.apiConfigId)
        ? settings.apiConfigId
        : api.activeId;
      setConfigId(nextConfigId);
      const active = api.configs.find(item => item.id === nextConfigId);
      const models = active && Array.isArray(active.models) ? active.models : [];
      setModel(settings.model && models.includes(settings.model)
        ? settings.model
        : ((active && active.activeModel) || models[0] || ''));
      if (await canScheduleExactAlarms()) setExactAlarmAllowed(true);
      else setExactAlarmAllowed(false);
    } catch (error) {
      setNotice('读取互动设置失败，请重试。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const currentConfig = useMemo(
    () => configs.find(item => item.id === configId) || null,
    [configs, configId]
  );
  const models = useMemo(
    () => (currentConfig && Array.isArray(currentConfig.models) ? currentConfig.models : []),
    [currentConfig]
  );

  const activeRoleId = selectedRoleId
    || (characters[0] && characters[0].id)
    || '';
  const roleSlots = useMemo(
    () => slots.filter(item => item.roleId === activeRoleId)
      .sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute)),
    [slots, activeRoleId]
  );

  const updateSlot = useCallback((slotId, patch) => {
    setSlots(prev => prev.map(item => (item.slotId === slotId ? { ...item, ...patch } : item)));
  }, []);

  const addSlot = useCallback(() => {
    const character = characters.find(item => item.id === activeRoleId);
    if (!character) return;
    setSlots(prev => [
      ...prev,
      {
        slotId: makeProactiveSlotId(),
        roleId: character.id,
        roleName: character.name || '角色',
        persona: rolePersona(character),
        hour: 8,
        minute: 0,
        mode: 'WORK',
        enabled: true,
        apiConfigId: '',
        model: '',
        revision: '',
      },
    ]);
  }, [characters, activeRoleId]);

  const removeSlot = useCallback(slotId => {
    setSlots(prev => prev.filter(item => item.slotId !== slotId));
  }, []);

  const chooseConfig = useCallback(id => {
    setConfigId(id);
    const config = configs.find(item => item.id === id);
    const list = config && Array.isArray(config.models) ? config.models : [];
    setModel((config && config.activeModel) || list[0] || '');
  }, [configs]);

  const save = useCallback(async () => {
    if (!available) {
      setNotice('当前构建未包含互动原生能力，请更新应用。');
      return;
    }
    if (!currentConfig || !String(currentConfig.baseUrl || '').trim()) {
      setNotice('所选 API 配置缺少地址，请先在设置页补全。');
      return;
    }
    setSaving(true);
    setNotice('');
    try {
      // 1. 取消本次被删除的槽
      const removed = persistedSlotIdsRef.current.filter(
        id => !slots.some(item => item.slotId === id)
      );
      for (const slotId of removed) {
        await cancelDailySchedule(slotId);
      }

      // 2. 同步 API（原生侧单份：来源是设置页已有配置）
      await setProactiveApiSettings({
        endpoint: normalizeChatUrl(currentConfig.baseUrl),
        model,
        apiKey: currentConfig.apiKey,
      });

      // 3. 逐槽排定；角色信息随槽带上，后台无需 JS 也能组装 prompt
      const persisted = [];
      for (const slot of slots) {
        const character = characters.find(item => item.id === slot.roleId);
        const payload = {
          ...slot,
          roleName: (character && character.name) || slot.roleName || '角色',
          persona: character ? rolePersona(character) : slot.persona,
          // 每次保存生成新 revision，让队列中未执行的旧配置自动失效
          revision: makeProactiveSlotId(),
        };
        await scheduleDailyMessage(payload);
        persisted.push(payload);
      }

      const saved = await saveProactiveSettings({
        slots: persisted,
        apiConfigId: configId,
        model,
      });
      persistedSlotIdsRef.current = saved.slots.map(item => item.slotId);
      setSlots(saved.slots);
      setNotice(`已保存 ${saved.slots.filter(item => item.enabled).length} 个主动消息时间`);
    } catch (error) {
      setNotice('保存失败，请检查权限后重试。');
    } finally {
      setSaving(false);
    }
  }, [available, currentConfig, configId, model, slots, characters]);

  const requestNotification = useCallback(async () => {
    const granted = await requestNotificationPermission();
    setNotice(granted ? '通知权限已开启' : '未获得通知权限，通知将无法展示');
  }, []);

  const enableExactAlarm = useCallback(async () => {
    if (await canScheduleExactAlarms()) {
      setExactAlarmAllowed(true);
      setNotice('精确闹钟权限已可用');
      return;
    }
    await openExactAlarmSettings();
    setNotice('请在系统设置中允许「闹钟和提醒」，返回后可再次保存。');
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  const Container = embedded ? View : ScrollView;
  const containerProps = embedded ? { style: styles.content } : { contentContainerStyle: styles.content };

  return (
    <Container {...containerProps}>
      <Text style={styles.title}>互动</Text>
      <Text style={styles.hint}>
        让角色在你指定的时间主动发一条消息。默认使用普通模式（系统可能延迟数十分钟）；
        需要精确到分钟时，把某个时间设为「精确」并授予精确闹钟权限。
      </Text>

      <Text style={styles.sectionTitle}>消息来源</Text>
      {configs.length === 0 ? (
        <Text style={styles.hint}>还没有 API 配置，请先到设置页添加。</Text>
      ) : (
        <View style={styles.chipWrap}>
          {configs.map(item => (
            <TouchableOpacity
              key={item.id}
              style={[styles.chip, item.id === configId && styles.chipActive]}
              onPress={() => chooseConfig(item.id)}
              activeOpacity={0.85}
            >
              <Text style={[styles.chipText, item.id === configId && styles.chipTextActive]}>
                {item.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      {models.length > 0 ? (
        <View style={styles.chipWrap}>
          {models.map(item => (
            <TouchableOpacity
              key={item}
              style={[styles.chip, item === model && styles.chipActive]}
              onPress={() => setModel(item)}
              activeOpacity={0.85}
            >
              <Text style={[styles.chipText, item === model && styles.chipTextActive]}>
                {item}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>选择角色</Text>
      <View style={styles.chipWrap}>
        {characters.map(item => (
          <TouchableOpacity
            key={item.id}
            style={[styles.chip, item.id === activeRoleId && styles.chipActive]}
            onPress={() => setSelectedRoleId(item.id)}
            activeOpacity={0.85}
          >
            <Text style={[styles.chipText, item.id === activeRoleId && styles.chipTextActive]}>
              {item.name || '未命名'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>时间（可多个）</Text>
        <TouchableOpacity style={styles.addButton} onPress={addSlot} activeOpacity={0.85}>
          <Ionicons name="add" size={16} color={theme.colors.primaryContrast} />
          <Text style={styles.addButtonText}>添加时间</Text>
        </TouchableOpacity>
      </View>

      {roleSlots.length === 0 ? (
        <Text style={styles.hint}>该角色还没有时间，点「添加时间」开始。</Text>
      ) : null}

      {roleSlots.map(slot => (
        <View key={slot.slotId} style={styles.slotCard}>
          <View style={styles.slotTopRow}>
            <View style={styles.timeRow}>
              <TimeField
                value={slot.hour}
                theme={theme}
                styles={styles}
                onCommit={text => {
                  const value = Math.trunc(Number(text));
                  updateSlot(slot.slotId, {
                    hour: Number.isFinite(value) && value >= 0 && value <= 23 ? value : slot.hour,
                  });
                }}
              />
              <Text style={styles.colon}>:</Text>
              <TimeField
                value={slot.minute}
                theme={theme}
                styles={styles}
                onCommit={text => {
                  const value = Math.trunc(Number(text));
                  updateSlot(slot.slotId, {
                    minute: Number.isFinite(value) && value >= 0 && value <= 59 ? value : slot.minute,
                  });
                }}
              />
            </View>
            <View style={styles.slotActions}>
              <Switch
                value={slot.enabled}
                onValueChange={value => updateSlot(slot.slotId, { enabled: value })}
                trackColor={{ true: theme.colors.primary, false: theme.colors.surfaceBorder }}
              />
              <TouchableOpacity
                style={styles.deleteButton}
                onPress={() => removeSlot(slot.slotId)}
                activeOpacity={0.8}
              >
                <Ionicons name="trash-outline" size={16} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>
          </View>
          <View style={styles.chipWrap}>
            {['WORK', 'EXACT'].map(modeValue => (
              <TouchableOpacity
                key={modeValue}
                style={[styles.chip, slot.mode === modeValue && styles.chipActive]}
                onPress={() => updateSlot(slot.slotId, { mode: modeValue })}
                activeOpacity={0.85}
              >
                <Text style={[styles.chipText, slot.mode === modeValue && styles.chipTextActive]}>
                  {modeValue === 'WORK' ? '普通' : '精确'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ))}

      <Text style={styles.sectionTitle}>必要权限</Text>
      <View style={styles.chipWrap}>
        <TouchableOpacity style={styles.chip} onPress={requestNotification} activeOpacity={0.85}>
          <Text style={styles.chipText}>通知权限</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.chip} onPress={enableExactAlarm} activeOpacity={0.85}>
          <Text style={styles.chipText}>
            {exactAlarmAllowed ? '精确闹钟（已授权）' : '精确闹钟授权'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.chip}
          onPress={() => openBatteryOptimizationSettings()}
          activeOpacity={0.85}
        >
          <Text style={styles.chipText}>电池优化白名单</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.chip}
          onPress={() => openAutostartSettings()}
          activeOpacity={0.85}
        >
          <Text style={styles.chipText}>自启动设置</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.hint}>
        厂商系统需要手动允许后台运行、自启动，并在最近任务中锁定应用，否则定时消息可能不触发。
      </Text>

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <TouchableOpacity
        style={[styles.saveButton, saving && styles.saveButtonDisabled]}
        onPress={save}
        disabled={saving}
        activeOpacity={0.85}
      >
        <Text style={styles.saveButtonText}>{saving ? '保存中…' : '保存并启用'}</Text>
      </TouchableOpacity>
    </Container>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: 20, paddingBottom: 40 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800', marginTop: 6 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginTop: 8 },
  sectionTitle: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700', marginTop: 20 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 },
  chip: {
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
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    marginTop: 20,
  },
  addButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },
  slotCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    padding: 12,
    marginTop: 10,
  },
  slotTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  timeRow: { flexDirection: 'row', alignItems: 'center' },
  timeInput: {
    width: 48,
    textAlign: 'center',
    color: theme.colors.text,
    fontSize: fonts.scaled(18),
    fontWeight: '700',
    backgroundColor: theme.colors.background,
    borderRadius: 8,
    paddingVertical: 6,
  },
  colon: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '700', marginHorizontal: 6 },
  slotActions: { flexDirection: 'row', alignItems: 'center' },
  deleteButton: { marginLeft: 10, padding: 6 },
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