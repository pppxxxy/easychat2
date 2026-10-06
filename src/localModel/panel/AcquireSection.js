// 「获取」段：在线下载 / 本地导入两个互斥子 Tab（U2），下载表单带进度条与取消（U4）。
// 纯渲染：草稿、任务态与处理器由壳经 useAcquireModel 装配。

import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { formatBytes } from '../../utils/format.js';
import { LOCAL_MODEL_DOWNLOAD_SOURCES } from '../modelState.js';
import { tierColor } from './panelShared.js';

export default function AcquireSection({
  styles,
  theme,
  t,
  acquireTab,
  onAcquireTab,
  downloadDraft,
  onDownloadDraftChange,
  importDraft,
  task,
  draftSummary,
  onRewriteSource,
  onOpenSearch,
  onDownload,
  onCancelDownload,
  onPickGguf,
  onPickMmproj,
  onImport,
}) {
  const downloading = task.kind === 'download';
  const importing = task.kind === 'import';
  return (
    <>
      <View style={styles.subTabRow}>
        {[
          { id: 'download', label: t('localModel.acquire.download') },
          { id: 'import', label: t('localModel.acquire.import') },
        ].map(tab => (
          <TouchableOpacity
            key={tab.id}
            style={[styles.tabItem, acquireTab === tab.id && styles.tabItemActive]}
            onPress={() => onAcquireTab(tab.id)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityState={{ selected: acquireTab === tab.id }}
            accessibilityLabel={tab.label}
          >
            <Text style={[styles.tabText, acquireTab === tab.id && styles.tabTextActive]}>{tab.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {acquireTab === 'download' ? (
        <>
          <View style={styles.labelRow}>
            <Text style={styles.labelInline}>{t('localModel.download.modelId')}</Text>
            <TouchableOpacity
              style={styles.searchModelButton}
              onPress={onOpenSearch}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel={t('localModel.download.search')}
            >
              <Ionicons name="search" size={14} color={theme.colors.primarySoft} />
              <Text style={styles.searchModelText}>{t('localModel.download.search')}</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.input}
            value={downloadDraft.modelId}
            onChangeText={text => onDownloadDraftChange(current => ({ ...current, modelId: text }))}
            placeholder={t('localModel.download.modelIdPlaceholder')}
            placeholderTextColor={theme.colors.textFaint}
          />
          <View style={styles.summaryCard}>
            <Text style={styles.summaryName} numberOfLines={1}>{downloadDraft.name || downloadDraft.modelId || t('localModel.summary.noModel')}</Text>
            <View style={styles.summaryRow}>
              {draftSummary.quantLabel ? <Text style={styles.summaryChip}>{t('localModel.chip.quant', { label: draftSummary.quantLabel })}</Text> : null}
              {draftSummary.paramLabel ? <Text style={styles.summaryChip}>{t('localModel.chip.size', { label: draftSummary.paramLabel })}</Text> : null}
              {draftSummary.memory.totalBytes > 0 ? <Text style={styles.summaryChip}>{t('localModel.summary.memory', { size: formatBytes(draftSummary.memory.totalBytes) })}</Text> : null}
              <Text style={[styles.summaryTier, { color: tierColor(theme, draftSummary.compatibility.tier) }]}>{draftSummary.compatibility.label}</Text>
            </View>
            <Text style={styles.summaryHint}>
              {t('localModel.summary.memoryHint')}
            </Text>
          </View>

          <View style={styles.sourceRow}>
            {LOCAL_MODEL_DOWNLOAD_SOURCES.map(source => (
              <TouchableOpacity
                key={source.id}
                style={[styles.sourceChip, downloadDraft.sourceId === source.id && styles.sourceChipActive]}
                onPress={() => onRewriteSource(source)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={t('localModel.a11y.useSource', { name: source.name })}
              >
                <Text style={[styles.sourceChipText, downloadDraft.sourceId === source.id && styles.sourceChipTextActive]}>{source.name}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>{t('localModel.download.urlLabel')}</Text>
          <TextInput
            style={styles.input}
            value={downloadDraft.modelUrl}
            onChangeText={text => onDownloadDraftChange(current => ({ ...current, modelUrl: text }))}
            placeholder="https://huggingface.co/<repo>/resolve/main/model.gguf"
            placeholderTextColor={theme.colors.textFaint}
            autoCapitalize="none"
          />
          {downloadDraft.mmprojUrls.length > 0 ? (
            <>
              <Text style={styles.label}>{t('localModel.download.mmprojLabel')}</Text>
              <View style={styles.sourceRow}>
                <TouchableOpacity
                  style={[styles.sourceChip, !downloadDraft.mmprojUrl && styles.sourceChipActive]}
                  onPress={() => onDownloadDraftChange(current => ({ ...current, mmprojUrl: '' }))}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.sourceChipText, !downloadDraft.mmprojUrl && styles.sourceChipTextActive]}>{t('localModel.download.mmprojSkip')}</Text>
                </TouchableOpacity>
                {downloadDraft.mmprojUrls.map((url, index) => (
                  <TouchableOpacity
                    key={url}
                    style={[styles.sourceChip, downloadDraft.mmprojUrl === url && styles.sourceChipActive]}
                    onPress={() => onDownloadDraftChange(current => ({ ...current, mmprojUrl: url }))}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.sourceChipText, downloadDraft.mmprojUrl === url && styles.sourceChipTextActive]}>mmproj {index + 1}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : null}
          {downloading ? (
            <View style={styles.downloadProgressWrap} accessibilityLabel={t('localModel.download.progressA11y', { progress: Math.round(task.progress * 100) })}>
              <View style={styles.downloadProgressBar}>
                <View style={[styles.downloadProgressFill, { width: `${Math.round(task.progress * 100)}%` }]} />
              </View>
              <Text style={styles.downloadProgressText}>
                {task.totalBytes > 0
                  ? `${Math.round(task.progress * 100)}% · ${formatBytes(task.writtenBytes) || '0B'}/${formatBytes(task.totalBytes)}`
                  : `${Math.round(task.progress * 100)}%`}
              </Text>
            </View>
          ) : null}
          <View style={styles.downloadButtons}>
            <TouchableOpacity style={[styles.primary, styles.downloadMainButton]} onPress={onDownload} disabled={downloading} activeOpacity={0.8}>
              <Text style={styles.primaryText}>{downloading ? t('localModel.download.progress') : t('localModel.download.busy')}</Text>
            </TouchableOpacity>
            {downloading ? (
              <TouchableOpacity
                style={styles.downloadCancelButton}
                onPress={onCancelDownload}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={t('localModel.download.cancelA11y')}
              >
                <Text style={styles.downloadCancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </>
      ) : (
        <>
          <Text style={styles.hint}>{t('localModel.import.hint')}</Text>
          <TouchableOpacity style={styles.secondary} onPress={onPickGguf} activeOpacity={0.8}>
            <Text style={styles.secondaryText}>{importDraft.sourceUri ? t('localModel.import.selectedGguf', { name: importDraft.name || t('localModel.import.ggufFile') }) : t('localModel.import.ggufFile')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondary} onPress={onPickMmproj} activeOpacity={0.8}>
            <Text style={styles.secondaryText}>{importDraft.mmprojSourceUri ? t('localModel.import.mmprojSelected', { name: importDraft.mmprojSourceName || t('localModel.import.selected') }) : t('localModel.import.pickMmproj')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.primary} onPress={onImport} disabled={importing} activeOpacity={0.8}>
            <Text style={styles.primaryText}>{importing ? t('localModel.import.busy') : t('localModel.import.button')}</Text>
          </TouchableOpacity>
        </>
      )}
    </>
  );
}
