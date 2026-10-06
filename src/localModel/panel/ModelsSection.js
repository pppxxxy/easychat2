// 「模型」段：状态行 + 启用/多媒体开关 + 已装列表（两行式行组件 + 长按操作单钩子）。
// 纯渲染：数据与回调由壳装配；行内长按（参数/删除）走壳的 onEntryActions。

import React from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { buildModelSummary } from '../modelCompatibility.js';
import { formatBytes } from '../../utils/format.js';
import { tierColor } from './panelShared.js';

export default function ModelsSection({
  styles,
  theme,
  moduleAvailable,
  settings,
  entries,
  deviceMemoryBytes,
  cleanupBusy,
  onCleanupOrphans,
  onToggleEnabled,
  onToggleMediaInput,
  onSelectActive,
  onLoadModel,
  onEntryActions,
  loadBusyId,
  loadProgress,
  loadedModelId,
  onGoAcquire,
  goAcquireLabel,
}) {
  const renderEntry = entry => {
    const summary = buildModelSummary(entry, { totalMemoryBytes: deviceMemoryBytes, contextSize: 2048 });
    const active = Boolean(settings && settings.activeModelId === entry.id);
    const loading = loadBusyId === entry.id;
    return (
      <TouchableOpacity
        key={entry.id}
        style={[styles.item, active && styles.itemActive]}
        activeOpacity={0.75}
        onLongPress={() => onEntryActions(entry)}
        delayLongPress={320}
        accessibilityRole="button"
        accessibilityLabel={`${entry.name || entry.id}，长按显示参数与删除`}
      >
        <View style={styles.itemHeader}>
          <View style={styles.itemInfo}>
            <Text style={styles.itemName} numberOfLines={1}>{entry.name || entry.id}{active ? ' · 当前' : ''}</Text>
            <View style={styles.chipRow}>
              <Text style={[styles.tierChip, { color: tierColor(theme, summary.compatibility.tier) }]}>{summary.compatibility.label}</Text>
              {summary.quantLabel ? <Text style={styles.chip}>量化 {summary.quantLabel}</Text> : null}
              {summary.paramLabel ? <Text style={styles.chip}>规模 {summary.paramLabel}</Text> : null}
              {(entry.hasVision || entry.hasAudio) ? <Text style={styles.chip}>多模态</Text> : null}
            </View>
          </View>
          {entry.modelBytes > 0 ? <Text style={styles.itemBytes}>{formatBytes(entry.modelBytes)}</Text> : null}
        </View>
        <View style={styles.itemActions}>
          <TouchableOpacity
            style={[styles.selectButton, active && styles.selectButtonActive]}
            onPress={() => onSelectActive(entry)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={active ? '当前活动模型' : `选用 ${entry.name || entry.id}`}
          >
            <Text style={styles.selectButtonText}>{active ? '已选用' : '选用'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.iconButton, loading && styles.loadButtonBusy]}
            onPress={() => onLoadModel(entry)}
            disabled={Boolean(loadBusyId)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={
              loadedModelId === entry.id ? '模型已加载' : `加载 ${entry.name || entry.id}`
            }
          >
            <Ionicons name="hardware-chip-outline" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.iconButtonText}>
              {loading ? `加载中 ${loadProgress}%` : loadedModelId === entry.id ? '已加载' : '加载'}
            </Text>
          </TouchableOpacity>
        </View>
        {loading ? (
          <View style={styles.loadProgressRow} accessibilityLabel={`加载进度 ${loadProgress}%`}>
            <View style={styles.loadProgressBar}>
              <View style={[styles.loadProgressFill, { width: `${loadProgress}%` }]} />
            </View>
            <Text style={styles.loadProgressText}>{loadProgress}%</Text>
          </View>
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <>
      <Text style={styles.hint}>本地模型需要包含 llama.rn 的原生构建。未完成原生构建或模型未就绪时，聊天继续使用在线 API。</Text>
      <Text style={styles.status}>{moduleAvailable ? '当前构建已包含本地模型模块' : '当前构建未包含本地模型模块'}</Text>

      <View style={styles.activeRow}>
        <Text style={styles.activeText}>
          {settings && settings.activeModelId
            ? `当前模型：${settings.modelName || settings.activeModelId}`
            : '当前未选用本地模型'}
        </Text>
        <SwitchRow
          theme={theme}
          value={Boolean(settings && settings.enabled)}
          disabled={!settings}
          onToggle={onToggleEnabled}
          accessibilityLabel="启用本地模型"
        />
      </View>

      <View style={styles.mediaRow}>
        <View style={styles.mediaInfo}>
          <Text style={styles.mediaTitle}>允许图片/音频输入</Text>
          <Text style={styles.mediaHint}>
            {settings && settings.enableMediaInput
              ? '已开启：模型支持识图/听声时，图片与音频会发给本地推理'
              : '默认关闭：本地推理只发送文字'}
          </Text>
        </View>
        <SwitchRow
          theme={theme}
          value={Boolean(settings && settings.enableMediaInput)}
          disabled={!settings}
          onToggle={onToggleMediaInput}
          accessibilityLabel="允许图片/音频输入"
        />
      </View>

      <View style={styles.labelRow}>
        <Text style={styles.labelInline}>已安装模型（{entries.length}）</Text>
        <TouchableOpacity
          style={styles.searchModelButton}
          onPress={onCleanupOrphans}
          disabled={cleanupBusy}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="清理下载残留"
        >
          <Ionicons name="trash-bin-outline" size={14} color={theme.colors.primarySoft} />
          <Text style={styles.searchModelText}>{cleanupBusy ? '清理中…' : '清理残留'}</Text>
        </TouchableOpacity>
      </View>
      {entries.length === 0 ? (
        <View>
          <Text style={styles.empty}>还没有本地模型，可前往「获取」搜索下载或导入本地 GGUF 文件。</Text>
          <TouchableOpacity
            style={styles.secondary}
            onPress={onGoAcquire}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={goAcquireLabel}
          >
            <Text style={styles.secondaryText}>{goAcquireLabel}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        entries.map(renderEntry)
      )}
    </>
  );
}

function SwitchRow({ theme, value, disabled, onToggle, accessibilityLabel }) {
  return (
    <Switch
      value={value}
      onValueChange={() => onToggle()}
      disabled={disabled}
      trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
      thumbColor={theme.colors.primaryContrast}
      accessibilityLabel={accessibilityLabel}
    />
  );
}
