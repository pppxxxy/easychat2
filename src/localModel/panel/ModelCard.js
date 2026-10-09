// 模型卡（v5 Stage C）：本地模型列表的唯一交互原语。三态（当前高亮 / 已安装常态 /
// 未安装灰态）+ 状态徽章 + 单行摘要（量化·规模·体积·识图/听声）+ 操作
// （设为当前或下载为主 + 参数·预设 + ⋯ 菜单：加载/卸载、删除）。纯渲染。

import React, { useState } from 'react';
import { Modal, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { buildModelSummary } from '../modelCompatibility.js';
import { LOCAL_MODEL_PARAM_PRESETS } from '../modelParams.js';
import { formatBytes } from '../../utils/format.js';
import { tierColor } from './panelShared.js';

// 归一化的类目预设：按温度粗略匹配（预设只改采样字段，温度是最可辨识的一个）。
function matchingPreset(params) {
  const temperature = Number(params && params.temperature);
  if (!Number.isFinite(temperature)) return null;
  const preset = LOCAL_MODEL_PARAM_PRESETS.find(item => Math.abs(Number(item.params.temperature) - temperature) < 0.001);
  return preset ? preset.id : null;
}

export default function ModelCard({
  styles,
  theme,
  t,
  entry,
  active,
  loaded,
  loading,
  progress,
  uninstalled = false,
  onSelectActive,
  onLoadModel,
  onUnloadModel,
  onEditParams,
  onDelete,
  onDownload,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const summary = buildModelSummary(entry, { totalMemoryBytes: 0, contextSize: 2048 });
  const name = entry.name || entry.id;

  const badgeKey = active
    ? 'localModel.badge.current'
    : uninstalled
      ? 'localModel.badge.notInstalled'
      : 'localModel.badge.installed';
  const badgeStyle = active
    ? styles.cardBadgeActive
    : uninstalled
      ? styles.cardBadgeMissing
      : styles.cardBadgeInstalled;

  const visionLabel = entry.hasVision ? t('localModel.chip.vision') : t('localModel.chip.noVision');
  const summaryParts = [
    summary.quantLabel,
    summary.paramLabel,
    entry.modelBytes > 0 ? formatBytes(entry.modelBytes) : '',
    visionLabel,
    entry.hasAudio ? t('localModel.chip.audio') : '',
  ].filter(Boolean);

  const presetId = matchingPreset(entry.params);
  const paramsLabel = presetId
    ? t('localModel.card.paramsWithPreset', { preset: t(`localModel.params.preset.${presetId}`) })
    : t('localModel.params');

  return (
    <View style={[styles.item, active && styles.itemActive, uninstalled && styles.cardMissing]}>
      <View style={styles.itemHeader}>
        <Text style={styles.itemName} numberOfLines={1}>{name}</Text>
        <Text style={[styles.cardBadge, badgeStyle]} numberOfLines={1}>{t(badgeKey)}</Text>
      </View>
      {/* 兼容分级（设计书 §6）：行尾只留一个颜色标记、不上文字——这一行已含量化·
          规模·体积·识图/听声，再缀「较难/难跑」必然被单行截断把信息挤掉；
          完整分级进无障碍标签，读屏用户仍能听到。 */}
      <Text
        style={styles.cardSummary}
        numberOfLines={1}
        accessibilityLabel={summary.compatibility && summary.compatibility.label
          ? `${summaryParts.join(' · ')} · ${summary.compatibility.label}`
          : undefined}
      >
        {summaryParts.join(' · ')}
        {summary.compatibility && summary.compatibility.label ? (
          <Text style={{ color: tierColor(theme, summary.compatibility.tier) }}> ●</Text>
        ) : null}
      </Text>

      <View style={styles.itemActions}>
        {uninstalled ? (
          <TouchableOpacity
            style={styles.selectButton}
            onPress={() => onDownload(entry)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={t('localModel.card.download')}
          >
            <Text style={styles.selectButtonText}>{t('localModel.card.download')}</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.selectButton, active && styles.selectButtonActive]}
            onPress={() => onSelectActive(entry)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={active ? t('localModel.a11y.activeModel') : t('localModel.a11y.selectModel', { name })}
          >
            <Text style={styles.selectButtonText}>{active ? t('localModel.selected') : t('localModel.card.setCurrent')}</Text>
          </TouchableOpacity>
        )}
        {!uninstalled ? (
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => onEditParams(entry)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={paramsLabel}
          >
            <Ionicons name="options-outline" size={15} color={theme.colors.primarySoft} />
            <Text style={styles.iconButtonText}>{paramsLabel}</Text>
          </TouchableOpacity>
        ) : null}
        {!uninstalled ? (
          <TouchableOpacity
            style={[styles.iconButton, styles.deleteIconButton]}
            onPress={() => setMenuOpen(true)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={t('localModel.card.more')}
          >
            <Ionicons name="ellipsis-horizontal" size={16} color={theme.colors.primarySoft} />
          </TouchableOpacity>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.loadProgressRow} accessibilityLabel={t('localModel.a11y.loadProgress', { progress })}>
          <View style={styles.loadProgressBar}>
            <View style={[styles.loadProgressFill, { width: `${progress}%` }]} />
          </View>
          <Text style={styles.loadProgressText}>{progress}%</Text>
        </View>
      ) : null}

      {menuOpen ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
          <TouchableOpacity style={styles.cardMenuBackdrop} activeOpacity={1} onPress={() => setMenuOpen(false)}>
            <View style={styles.cardMenuSheet}>
              <TouchableOpacity
                style={styles.cardMenuRow}
                onPress={() => { setMenuOpen(false); if (loaded) onUnloadModel(entry); else onLoadModel(entry); }}
                activeOpacity={0.8}
              >
                <Ionicons name="hardware-chip-outline" size={16} color={theme.colors.primaryMuted} style={styles.cardMenuIcon} />
                <Text style={styles.cardMenuText}>{loaded ? t('localModel.engine.unload') : t('localModel.load')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.cardMenuRow}
                onPress={() => { setMenuOpen(false); onDelete(entry); }}
                activeOpacity={0.8}
              >
                <Ionicons name="trash-bin-outline" size={16} color={theme.colors.danger || theme.colors.textFaint} style={styles.cardMenuIcon} />
                <Text style={[styles.cardMenuText, styles.cardMenuDanger]}>{t('common.delete')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>
      ) : null}
    </View>
  );
}