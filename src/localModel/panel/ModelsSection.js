// 「模型」段：状态行 + 启用/多媒体开关 + 已装列表（两行式行组件 + 长按操作单钩子）。
// 纯渲染：数据与回调由壳装配；行内长按（参数/删除）走壳的 onEntryActions。

import React from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { buildModelSummary } from '../modelCompatibility.js';
import { formatBytes } from '../../utils/format.js';
import { tierColor } from './panelShared.js';
import EngineCard from './EngineCard.js';

export default function ModelsSection({
  styles,
  theme,
  t,
  moduleAvailable,
  settings,
  entries,
  deviceMemoryBytes,
  cleanupBusy,
  runtime,
  onCleanupOrphans,
  onToggleEnabled,
  onToggleMediaInput,
  onSelectActive,
  onLoadModel,
  onUnloadModel,
  onOpenLogs,
  onEntryActions,
  onDeleteEntry,
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
        accessibilityLabel={t('localModel.a11y.expand', { name: entry.name || entry.id })}
      >
        <View style={styles.itemHeader}>
          <View style={styles.itemInfo}>
            <Text style={styles.itemName} numberOfLines={1}>{entry.name || entry.id}{active ? t('localModel.currentSuffix') : ''}</Text>
            <View style={styles.chipRow}>
              <Text style={[styles.tierChip, { color: tierColor(theme, summary.compatibility.tier) }]}>{summary.compatibility.label}</Text>
              {summary.quantLabel ? <Text style={styles.chip}>{t('localModel.chip.quant', { label: summary.quantLabel })}</Text> : null}
              {summary.paramLabel ? <Text style={styles.chip}>{t('localModel.chip.size', { label: summary.paramLabel })}</Text> : null}
              {(entry.hasVision || entry.hasAudio) ? <Text style={styles.chip}>{t('localModel.chip.multimodal')}</Text> : null}
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
            accessibilityLabel={active ? t('localModel.a11y.activeModel') : t('localModel.a11y.selectModel', { name: entry.name || entry.id })}
          >
            <Text style={styles.selectButtonText}>{active ? t('localModel.selected') : t('localModel.select')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.iconButton, loading && styles.loadButtonBusy]}
            onPress={() => onLoadModel(entry)}
            disabled={Boolean(loadBusyId)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={
              loadedModelId === entry.id ? t('localModel.a11y.modelLoaded') : t('localModel.a11y.loadModel', { name: entry.name || entry.id })
            }
          >
            <Ionicons name="hardware-chip-outline" size={16} color={theme.colors.primarySoft} />
            <Text style={styles.iconButtonText}>
              {loading ? t('localModel.loading', { progress: loadProgress }) : loadedModelId === entry.id ? t('localModel.loaded') : t('localModel.load')}
            </Text>
          </TouchableOpacity>
          {/* 删除（2026-10-07）：此前只能长按唤出操作单，卡片上没有可见入口。
              直接接壳的 confirmDelete——它已带确认弹窗 + 卸载 + 停服务 + 重置选用
              的完整善后链，不另起一套删除逻辑；长按操作单保留（双入口无害）。 */}
          <TouchableOpacity
            style={[styles.iconButton, styles.deleteIconButton]}
            onPress={() => onDeleteEntry(entry)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={t('localModel.a11y.deleteModel', { name: entry.name || entry.id })}
          >
            <Ionicons name="trash-bin-outline" size={16} color={theme.colors.danger || theme.colors.textFaint} />
            <Text style={[styles.iconButtonText, styles.deleteIconButtonText]}>{t('common.delete')}</Text>
          </TouchableOpacity>
        </View>
        {loading ? (
          <View style={styles.loadProgressRow} accessibilityLabel={t('localModel.a11y.loadProgress', { progress: loadProgress })}>
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
      <Text style={styles.hint}>{t('localModel.hint')}</Text>
      <Text style={styles.status}>{moduleAvailable ? t('localModel.modulePresent') : t('localModel.hint')}</Text>

      {/* 运行状态卡（v5 Stage C）：模型库页顶常驻，读 runtime 单例——就绪/加载/失败三态
          与聊天层引擎状态条同源；卸载入口收在这里（模型中心成为唯一卸载点）。 */}
      <EngineCard
        styles={styles}
        theme={theme}
        t={t}
        runtime={runtime}
        entries={entries}
        onUnloadModel={onUnloadModel}
        onOpenLogs={onOpenLogs}
      />

      <View style={styles.activeRow}>
        <Text style={styles.activeText}>
          {settings && settings.activeModelId
            ? t('localModel.currentModel', {
              name: (entries.find(item => item.id === settings.activeModelId) || {}).name || settings.activeModelId,
            })
            : t('localModel.viewLogs')}
        </Text>
        <SwitchRow
          theme={theme}
          value={Boolean(settings && settings.enabled)}
          disabled={!settings}
          onToggle={onToggleEnabled}
          accessibilityLabel={t('localModel.a11y.enableToggle')}
        />
      </View>

      <View style={styles.mediaRow}>
        <View style={styles.mediaInfo}>
          <Text style={styles.mediaTitle}>{t('localModel.mediaInput.title')}</Text>
          <Text style={styles.mediaHint}>
            {settings && settings.enableMediaInput
              ? t('localModel.mediaInput.hintOn')
              : t('localModel.mediaInput.hintOff')}
          </Text>
        </View>
        <SwitchRow
          theme={theme}
          value={Boolean(settings && settings.enableMediaInput)}
          disabled={!settings}
          onToggle={onToggleMediaInput}
          accessibilityLabel={t('localModel.mediaInput.title')}
        />
      </View>

      <View style={styles.labelRow}>
        <Text style={styles.labelInline}>{t('localModel.installedCount', { count: entries.length })}</Text>
        <TouchableOpacity
          style={styles.searchModelButton}
          onPress={onCleanupOrphans}
          disabled={cleanupBusy}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={t('localModel.cleanup.button')}
        >
          <Ionicons name="trash-bin-outline" size={14} color={theme.colors.primarySoft} />
          <Text style={styles.searchModelText}>{cleanupBusy ? t('localModel.cleanup.busy') : t('localModel.cleanup.button')}</Text>
        </TouchableOpacity>
      </View>
      {entries.length === 0 ? (
        <View>
          <Text style={styles.empty}>{t('localModel.empty')}</Text>
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
