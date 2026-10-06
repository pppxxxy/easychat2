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
            <Text style={styles.labelInline}>模型 ID</Text>
            <TouchableOpacity
              style={styles.searchModelButton}
              onPress={onOpenSearch}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="搜索模型"
            >
              <Ionicons name="search" size={14} color={theme.colors.primarySoft} />
              <Text style={styles.searchModelText}>搜索模型</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            style={styles.input}
            value={downloadDraft.modelId}
            onChangeText={text => onDownloadDraftChange(current => ({ ...current, modelId: text }))}
            placeholder="例如 qwen2.5-1.5b"
            placeholderTextColor={theme.colors.textFaint}
          />
          <View style={styles.summaryCard}>
            <Text style={styles.summaryName} numberOfLines={1}>{downloadDraft.name || downloadDraft.modelId || '未选择模型'}</Text>
            <View style={styles.summaryRow}>
              {draftSummary.quantLabel ? <Text style={styles.summaryChip}>量化 {draftSummary.quantLabel}</Text> : null}
              {draftSummary.paramLabel ? <Text style={styles.summaryChip}>规模 {draftSummary.paramLabel}</Text> : null}
              {draftSummary.memory.totalBytes > 0 ? <Text style={styles.summaryChip}>占用约 {formatBytes(draftSummary.memory.totalBytes)}</Text> : null}
              <Text style={[styles.summaryTier, { color: tierColor(theme, draftSummary.compatibility.tier) }]}>{draftSummary.compatibility.label}</Text>
            </View>
            <Text style={styles.summaryHint}>
              内存占用随上下文长度增加；若加载失败或闪退，请改用更小的模型或降低上下文。
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
                accessibilityLabel={`使用 ${source.name} 下载源`}
              >
                <Text style={[styles.sourceChipText, downloadDraft.sourceId === source.id && styles.sourceChipTextActive]}>{source.name}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>GGUF 下载地址</Text>
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
              <Text style={styles.label}>配套 mmproj（可选，多模态）</Text>
              <View style={styles.sourceRow}>
                <TouchableOpacity
                  style={[styles.sourceChip, !downloadDraft.mmprojUrl && styles.sourceChipActive]}
                  onPress={() => onDownloadDraftChange(current => ({ ...current, mmprojUrl: '' }))}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.sourceChipText, !downloadDraft.mmprojUrl && styles.sourceChipTextActive]}>不下载</Text>
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
            <View style={styles.downloadProgressWrap} accessibilityLabel={`下载进度 ${Math.round(task.progress * 100)}%`}>
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
              <Text style={styles.primaryText}>{downloading ? '下载中...' : '下载并登记模型'}</Text>
            </TouchableOpacity>
            {downloading ? (
              <TouchableOpacity
                style={styles.downloadCancelButton}
                onPress={onCancelDownload}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="取消下载"
              >
                <Text style={styles.downloadCancelText}>取消</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </>
      ) : (
        <>
          <Text style={styles.hint}>把设备上已有的 GGUF 文件复制进应用目录并登记。</Text>
          <TouchableOpacity style={styles.secondary} onPress={onPickGguf} activeOpacity={0.8}>
            <Text style={styles.secondaryText}>{importDraft.sourceUri ? `已选择：${importDraft.name || 'GGUF 文件'}` : '选择 GGUF 文件'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondary} onPress={onPickMmproj} activeOpacity={0.8}>
            <Text style={styles.secondaryText}>{importDraft.mmprojSourceUri ? `mmproj：${importDraft.mmprojSourceName || '已选择'}` : '选择 mmproj（可选）'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.primary} onPress={onImport} disabled={importing} activeOpacity={0.8}>
            <Text style={styles.primaryText}>{importing ? '导入中...' : '导入到应用'}</Text>
          </TouchableOpacity>
        </>
      )}
    </>
  );
}
