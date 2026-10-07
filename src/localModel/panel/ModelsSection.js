// 「模型库」段：状态行 + 启用/多媒体开关 + 运行状态卡 + 下载任务卡 + 已装模型卡列表。
// 纯渲染：数据与回调由壳装配；模型卡是唯一交互原语（ModelCard）。

import React from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import EngineCard from './EngineCard.js';
import DownloadTasks from './DownloadTasks.js';
import ModelCard from './ModelCard.js';

export default function ModelsSection({
  styles,
  theme,
  t,
  moduleAvailable,
  settings,
  entries,
  cleanupBusy,
  runtime,
  onCleanupOrphans,
  onToggleEnabled,
  onToggleMediaInput,
  onSelectActive,
  onLoadModel,
  onUnloadModel,
  onOpenLogs,
  onEditParams,
  onDeleteEntry,
  loadBusyId,
  loadProgress,
  loadedModelId,
  onGoAcquire,
  goAcquireLabel,
  featuredEntries,
  onDownloadFeatured,
}) {
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

      {/* 下载任务卡（v5 Stage B/C）：队列任务可多张，面板关掉/重启后仍在推进。 */}
      <DownloadTasks styles={styles} theme={theme} t={t} />

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
        entries.map(entry => (
          <ModelCard
            key={entry.id}
            styles={styles}
            theme={theme}
            t={t}
            entry={entry}
            active={Boolean(settings && settings.activeModelId === entry.id)}
            loaded={loadedModelId === entry.id}
            loading={loadBusyId === entry.id}
            progress={loadProgress}
            onSelectActive={onSelectActive}
            onLoadModel={onLoadModel}
            onUnloadModel={onUnloadModel}
            onEditParams={onEditParams}
            onDelete={onDeleteEntry}
          />
        ))
      )}
      {/* 未安装精选卡（v5 Stage C/E）：目录精选项，灰态，一键进入获取区文件层。 */}
      {(Array.isArray(featuredEntries) ? featuredEntries : []).map(entry => (
        <ModelCard
          key={entry.id}
          styles={styles}
          theme={theme}
          t={t}
          entry={entry}
          active={false}
          loaded={false}
          loading={false}
          progress={0}
          uninstalled
          onDownload={onDownloadFeatured}
        />
      ))}
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

