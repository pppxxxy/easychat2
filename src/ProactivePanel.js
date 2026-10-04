import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { normalizeChatUrl } from './network/api.js';
import {
  getProactiveSettings,
  makeProactiveSlotId,
  saveProactiveSettings,
  getApiConfigs,
  getChatOptions,
} from './storage.js';
import {
  cancelDailySchedule,
  canScheduleExactAlarms,
  getPermissionStatus,
  isProactiveMessageAvailable,
  openAutostartSettings,
  openBatteryOptimizationSettings,
  openExactAlarmSettings,
  requestNotificationPermission,
  scheduleDailyMessage,
  setProactiveApiSettings,
} from './proactive/proactiveMessage.js';
import { useApp } from './context/AppContext.js';
import { useTheme } from './theme/ThemeContext.js';
import { buildProactiveRequestJson } from './proactive/proactiveRequest.js';

// 互动：让角色在指定时间主动发消息。面板负责编辑（角色 / 多个时间 / 模式 / API 来源），
// 实际调度交给原生（WorkManager 或精确闹钟），原生侧另存一份配置供后台发送。
function rolePersona(character) {
  const parts = [character.systemPrompt, character.description, character.personality, character.scenario]
    .map(item => String(item || '').trim())
    .filter(Boolean);
  return parts.join('；');
}

// 折叠选择器：避免把一大堆 API / 模型 / 角色一次性罗列出来，先展示当前选择项，
// 点开才展开候选列表，选中后自动收起。
function CollapsibleSelect({ label, value, options, onSelect, emptyHint, styles, theme }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.collapsible}>
      <TouchableOpacity
        style={styles.collapsibleHead}
        onPress={() => setOpen(v => !v)}
        activeOpacity={0.8}
        accessibilityRole="button"
      >
        <Text style={styles.collapsibleLabel}>{label}</Text>
        <Text style={styles.collapsibleValue} numberOfLines={1}>{value || '未选择'}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textFaint} />
      </TouchableOpacity>
      {open ? (
        options.length === 0 ? (
          <Text style={styles.hint}>{emptyHint || '暂无可选项'}</Text>
        ) : (
          <View style={styles.collapsibleBody}>
            {options.map(option => {
              const active = option.value === value;
              return (
                <TouchableOpacity
                  key={option.value}
                  style={[styles.optionRow, active && styles.optionRowActive]}
                  onPress={() => { onSelect(option.value); setOpen(false); }}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.optionText, active && styles.optionTextActive]} numberOfLines={1}>
                    {option.label}
                  </Text>
                  {active ? <Ionicons name="checkmark" size={16} color={theme.colors.primary} /> : null}
                </TouchableOpacity>
              );
            })}
          </View>
        )
      ) : null}
    </View>
  );
}

// 主动消息类型：与原生 MessageType 对齐。问好的早/中/晚由原生按触发时刻自动选。
const MESSAGE_TYPE_OPTIONS = [
  { value: 'DEFAULT', label: '默认' },
  { value: 'CARE', label: '关心心情' },
  { value: 'GREETING', label: '问好' },
  { value: 'CUSTOM', label: '自定义' },
];

function TimeField({ value, onCommit, theme, styles }) {
  const [text, setText] = useState(String(value).padStart(2, '0'));
  const [focused, setFocused] = useState(false);
  // 仅在不聚焦时用外部值同步显示：编辑中若被外部值回写，会打断输入（如先输 0 再输 9 变成 09 时被重置）。
  useEffect(() => {
    if (!focused) setText(String(value).padStart(2, '0'));
  }, [value, focused]);
  const handleChange = next => {
    const digits = String(next).replace(/[^0-9]/g, '').slice(0, 2);
    setText(digits);
    // 即时提交：避免「编辑后直接点保存并启用」时 onBlur 未触发、改动丢失（保存读到旧值）。
    if (digits.length > 0) onCommit(digits);
  };
  return (
    <TextInput
      style={styles.timeInput}
      value={text}
      keyboardType="number-pad"
      maxLength={2}
      onChangeText={handleChange}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        onCommit(text);
      }}
      placeholderTextColor={theme.colors.textFaint}
    />
  );
}

// embedded=true 时不自带滚动容器，交给外层折叠分组滚动
export default function ProactivePanel({ embedded = false }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const { characters, sessions } = useApp();
  const available = isProactiveMessageAvailable();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [slots, setSlots] = useState([]);
  const [configs, setConfigs] = useState([]);
  const [configId, setConfigId] = useState('');
  const [model, setModel] = useState('');
  const [selectedRoleId, setSelectedRoleId] = useState('');
  // 权限状态：true=已取得、false=未取得、null=未知（显示勾 / 叉 / 问号）
  const [permissionStatus, setPermissionStatus] = useState({
    notification: null, exactAlarm: null, battery: null, autostart: null,
  });
  const [notice, setNotice] = useState('');
  // 时间感知开关（与设置页共享同一 chatOptions）：保存槽时决定是否把当前时间写进请求。
  const [timeAware, setTimeAware] = useState(false);
  // 已展开的时间槽 id 集合：默认全部收起，避免多个时间占满屏幕。
  const [openSlotIds, setOpenSlotIds] = useState(() => new Set());
  // 权限区是否展开。
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const toggleSlotOpen = useCallback(slotId => {
    setOpenSlotIds(prev => {
      const next = new Set(prev);
      if (next.has(slotId)) next.delete(slotId);
      else next.add(slotId);
      return next;
    });
  }, []);
  // 已持久化的槽 id：保存时用于取消被删除的槽
  const persistedSlotIdsRef = useRef([]);

  const refreshPermissions = useCallback(async () => {
    const status = await getPermissionStatus();
    setPermissionStatus(status);
    return status;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settings, api, chatOptions] = await Promise.all([
        getProactiveSettings(),
        getApiConfigs(),
        getChatOptions().catch(() => ({ timeAware: false })),
      ]);
      setSlots(settings.slots);
      persistedSlotIdsRef.current = settings.slots.map(item => item.slotId);
      setTimeAware(chatOptions.timeAware === true);
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
      await refreshPermissions();
    } catch (error) {
      setNotice('读取互动设置失败，请重试。');
    } finally {
      setLoading(false);
    }
  }, [refreshPermissions]);

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
  // 保持用户添加时的顺序，不再每次渲染按时间自动排序——编辑时间时数字变化会立即换位，
  // 让人找不到自己在改哪一条，反直觉。需要整理时由用户点「按时间排序」显式触发。
  const roleSlots = useMemo(
    () => slots.filter(item => item.roleId === activeRoleId),
    [slots, activeRoleId]
  );

  // 该角色的单聊会话候选：用于把某个时间槽「衔接」到某段历史对话。
  // 空值代表「新建对话」（首次触发新建后固定复用这段）。
  const sessionOptions = useMemo(() => {
    const list = (Array.isArray(sessions) ? sessions : [])
      .filter(item => item && item.type !== 'group' && item.characterId === activeRoleId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(item => {
        const preview = String(item.preview || '').trim();
        return {
          value: String(item.id || ''),
          label: preview || '（空会话）',
        };
      });
    return [{ value: '', label: '新建对话' }, ...list];
  }, [sessions, activeRoleId]);
  const sessionLabelById = useMemo(() => {
    const map = new Map();
    sessionOptions.forEach(option => map.set(option.value, option.label));
    return map;
  }, [sessionOptions]);

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
        messageType: 'DEFAULT',
        customPrompt: '',
        sessionTargetId: '',
      },
    ]);
  }, [characters, activeRoleId]);

  const removeSlot = useCallback(slotId => {
    setSlots(prev => prev.filter(item => item.slotId !== slotId));
  }, []);

  // 仅按用户点击触发：把全部槽按时间升序排列。不做自动排序，避免编辑时跳位。
  const sortSlotsByTime = useCallback(() => {
    setSlots(prev => [...prev].sort(
      (a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute)
    ));
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
    // 本轮新加的槽（此前未排定过）：中途失败时必须回滚，
    // 否则原生留下 JS 无记录的幽灵定时任务，用户再也无法取消。
    const newSlotIdsThisRun = [];
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

      // 3. 逐槽排定；在 JS 侧用「正常对话」的同一管线组装好完整请求消息数组，
      //    连同槽配置存进原生，使后台主动消息与普通回复共用同一套提示词。
      const persisted = [];
      for (const slot of slots) {
        const character = characters.find(item => item.id === slot.roleId);
        // 绑定的会话若已不存在（被删）则规整为空串，等同「新建对话」，避免存储残留无效 id。
        const boundId = String(slot.sessionTargetId || '');
        const boundValid = boundId && (Array.isArray(sessions) ? sessions : []).some(item => (
          item
          && item.type !== 'group'
          && String(item.id || '') === boundId
          && String(item.characterId || '') === String(slot.roleId || '')
        ));
        let requestJson = '';
        if (character) {
          try {
            requestJson = await buildProactiveRequestJson({
              character,
              sessionTargetId: boundValid ? boundId : '',
              messageType: slot.messageType,
              customPrompt: slot.customPrompt,
              timeAware,
            });
          } catch (error) {
            requestJson = '';
          }
        }
        const payload = {
          ...slot,
          roleName: (character && character.name) || slot.roleName || '角色',
          persona: character ? rolePersona(character) : slot.persona,
          sessionTargetId: boundValid ? boundId : '',
          requestJson,
          // 角色头像本地 URI：通知用它当头像，避免系统用角色名首字当占位。
          // 不入 JS 设置键（normalizeProactiveSlot 会丢弃），仅随本次 schedule 传给原生。
          avatarUri: (character && character.avatarUri) || '',
          // 每次保存生成新 revision，让队列中未执行的旧配置自动失效
          revision: makeProactiveSlotId(),
        };
        if (!persistedSlotIdsRef.current.includes(slot.slotId)) {
          // 先登记再调用原生：即使原生写入后才抛错，catch 也能回滚该槽。
          newSlotIdsThisRun.push(slot.slotId);
        }
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
      // 回滚本轮已排进原生的新槽；旧槽保留原生新排期（revision 已更新且配置完整，
      // 取消反而会杀掉原本正常工作的任务），等下次成功保存时对齐 JS 记录。
      for (const slotId of newSlotIdsThisRun) {
        await cancelDailySchedule(slotId).catch(() => {});
      }
      setNotice('保存失败，请检查权限后重试。');
    } finally {
      setSaving(false);
    }
  }, [available, currentConfig, configId, model, slots, characters, sessions, timeAware]);

  const requestNotification = useCallback(async () => {
    const granted = await requestNotificationPermission();
    await refreshPermissions();
    setNotice(granted ? '通知权限已开启' : '未获得通知权限，通知将无法展示');
  }, [refreshPermissions]);

  const enableExactAlarm = useCallback(async () => {
    if (await canScheduleExactAlarms()) {
      await refreshPermissions();
      setNotice('精确闹钟权限已可用');
      return;
    }
    await openExactAlarmSettings();
    setNotice('请在系统设置中允许「闹钟和提醒」，返回后可再次保存。');
  }, [refreshPermissions]);

  const openBatterySettings = useCallback(async () => {
    await openBatteryOptimizationSettings();
    setNotice('请在系统设置中把本应用加入电池优化白名单，返回后会自动刷新状态。');
  }, []);

  const openAutostart = useCallback(async () => {
    await openAutostartSettings();
    setNotice('请在系统设置中允许自启动/后台运行，返回后会自动刷新状态。');
  }, []);

  // 从系统设置返回时刷新权限状态（点按打开设置后用户可能已授权）
  useEffect(() => {
    if (loading) return undefined;
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active') refreshPermissions().catch(() => {});
    });
    return () => subscription.remove();
  }, [loading, refreshPermissions]);

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

      <CollapsibleSelect
        label="消息来源（API）"
        value={(configs.find(item => item.id === configId) || {}).name || ''}
        options={configs.map(item => ({ value: item.id, label: item.name || '未命名配置' }))}
        onSelect={id => chooseConfig(id)}
        emptyHint="还没有 API 配置，请先到设置页添加。"
        styles={styles}
        theme={theme}
      />
      <CollapsibleSelect
        label="具体模型"
        value={model}
        options={models.map(item => ({ value: item, label: item }))}
        onSelect={value => setModel(value)}
        emptyHint="该 API 配置还没有模型，请先到设置页添加。"
        styles={styles}
        theme={theme}
      />
      <CollapsibleSelect
        label="选择角色"
        value={(characters.find(item => item.id === activeRoleId) || {}).name || ''}
        // 有主动消息（存在任何时间槽）的角色加星标，多于十多个时一眼看出哪些配过。
        options={characters.map(item => ({
          value: item.id,
          label: `${slots.some(slot => slot.roleId === item.id) ? '★ ' : ''}${item.name || '未命名'}`,
        }))}
        onSelect={id => setSelectedRoleId(id)}
        emptyHint="还没有角色，请先到角色页添加。"
        styles={styles}
        theme={theme}
      />
      <Text style={styles.hint}>★ 表示该角色已设置主动消息。</Text>
      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>时间（可多个）</Text>
        <View style={styles.sectionActions}>
          {roleSlots.length > 1 ? (
            <TouchableOpacity
              style={styles.sortButton}
              onPress={sortSlotsByTime}
              activeOpacity={0.85}
              accessibilityRole="button"
            >
              <Ionicons name="swap-vertical" size={15} color={theme.colors.primary} />
              <Text style={styles.sortButtonText}>按时间排序</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity style={styles.addButton} onPress={addSlot} activeOpacity={0.85}>
            <Ionicons name="add" size={16} color={theme.colors.primaryContrast} />
            <Text style={styles.addButtonText}>添加时间</Text>
          </TouchableOpacity>
        </View>
      </View>

      {roleSlots.length === 0 ? (
        <Text style={styles.hint}>该角色还没有时间，点「添加时间」开始。</Text>
      ) : null}

      {roleSlots.map(slot => {
        const expanded = openSlotIds.has(slot.slotId);
        return (
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
              <TouchableOpacity
                style={styles.deleteButton}
                onPress={() => toggleSlotOpen(slot.slotId)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
              >
                <Ionicons
                  name={expanded ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={theme.colors.textMuted}
                />
              </TouchableOpacity>
            </View>
          </View>
          {expanded ? (
            <>
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
              <Text style={styles.fieldLabel}>消息类型</Text>
              <View style={styles.chipWrap}>
                {MESSAGE_TYPE_OPTIONS.map(option => {
                  const active = (slot.messageType || 'DEFAULT') === option.value;
                  return (
                    <TouchableOpacity
                      key={option.value}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => updateSlot(slot.slotId, { messageType: option.value })}
                      activeOpacity={0.85}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {slot.messageType === 'CUSTOM' ? (
                <TextInput
                  style={styles.promptInput}
                  value={slot.customPrompt || ''}
                  onChangeText={text => updateSlot(slot.slotId, { customPrompt: text })}
                  placeholder="自定义提示词，例如：用略带调侃的语气问我晚饭吃了没"
                  placeholderTextColor={theme.colors.textFaint}
                  multiline
                />
              ) : null}
              <CollapsibleSelect
                label="衔接对话"
                // 槽绑定的会话若已被删除（不在候选里）则显示为空，等同「新建对话」。
                value={sessionLabelById.get(String(slot.sessionTargetId || '')) || '新建对话'}
                options={sessionOptions}
                onSelect={id => updateSlot(slot.slotId, { sessionTargetId: id })}
                emptyHint="该角色还没有历史对话，首次触发会新建一段。"
                styles={styles}
                theme={theme}
              />
              <Text style={styles.hint}>
                选「新建对话」时，到点会新开一段并固定复用；选某段历史对话则把消息续写在那段里。
              </Text>
            </>
          ) : null}
        </View>
        );
      })}

      <TouchableOpacity
        style={styles.sectionRow}
        onPress={() => setPermissionsOpen(v => !v)}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityState={{ expanded: permissionsOpen }}
      >
        <Text style={styles.sectionTitle}>必要权限</Text>
        <Ionicons
          name={permissionsOpen ? 'chevron-up' : 'chevron-down'}
          size={18}
          color={theme.colors.textFaint}
        />
      </TouchableOpacity>
      {permissionsOpen ? (
        <>
          {[
            {
              key: 'notification',
              title: '通知权限',
              hint: '用于展示角色发来的消息通知',
              onPress: requestNotification,
            },
            {
              key: 'exactAlarm',
              title: '精确闹钟权限',
              hint: '仅「精确」模式需要，可让消息准点触发',
              onPress: enableExactAlarm,
            },
            {
              key: 'battery',
              title: '电池优化白名单',
              hint: '避免系统在后台限制应用导致不触发',
              onPress: openBatterySettings,
            },
            {
              key: 'autostart',
              title: '自启动设置',
              hint: '厂商系统需手动允许后台运行与自启动',
              onPress: openAutostart,
            },
          ].map((item, index) => {
            const status = permissionStatus[item.key];
            const icon = status === true ? 'checkmark-circle' : (status === false ? 'close-circle' : 'help-circle');
            const color = status === true
              ? theme.colors.primary
              : (status === false ? theme.colors.danger : theme.colors.textFaint);
            return (
              <TouchableOpacity
                key={item.key}
                style={styles.permissionRow}
                onPress={item.onPress}
                activeOpacity={0.85}
              >
                <Text style={styles.permissionIndex}>{index + 1}</Text>
                <View style={styles.permissionText}>
                  <Text style={styles.permissionTitle}>{item.title}</Text>
                  <Text style={styles.permissionHint}>{item.hint}</Text>
                </View>
                <Ionicons name={icon} size={20} color={color} />
              </TouchableOpacity>
            );
          })}
          <Text style={styles.hint}>
            勾=已取得、叉=未取得、问号=无法自动判断（如厂商自启动白名单），点按对应行去系统设置。
          </Text>
          <Text style={styles.hint}>
            想让「横屏/横幅通知」弹出并震动？到「系统设置 → 通知 → EasyChat2 → 角色主动消息」，
            勾选「横幅通知」与「锁屏通知」，并关闭「静默通知」。
          </Text>
        </>
      ) : null}

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
  sectionActions: { flexDirection: 'row', alignItems: 'center' },
  sortButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.primary,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
  },
  sortButtonText: { color: theme.colors.primary, fontSize: fonts.scaled(12), fontWeight: '600', marginLeft: 4 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 },
  fieldLabel: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600', marginTop: 12 },
  promptInput: {
    marginTop: 8,
    minHeight: 64,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    backgroundColor: theme.colors.background,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10,
    paddingVertical: 8,
    textAlignVertical: 'top',
  },
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
  permissionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: 10,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 10,
  },
  permissionIndex: {
    width: 22,
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(14),
    fontWeight: '800',
    textAlign: 'center',
  },
  permissionText: { flex: 1, marginLeft: 8, marginRight: 8 },
  permissionTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  permissionHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
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
