// 本地模型搜索选择弹窗：按下载源搜索仓库（仅 GGUF），再选择具体量化文件回填。
// 组件只做展示与交互，解析/请求逻辑在 modelCatalog.js（可单测）。

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { LOCAL_MODEL_DOWNLOAD_SOURCES } from './modelState.js';
import { buildDownloadUrl, catalogProviderForSource, listModelFiles, searchModels } from './modelCatalog.js';
import { selectFeaturedModels } from './featured.js';
import { rankModelFiles } from './modelCompatibility.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { formatBytes } from '../utils/format.js';

function fileBaseName(filePath) {
  return String(filePath || '').split('/').pop().replace(/\.gguf$/i, '');
}

// 兼容分级的展示色：推荐=主色、难跑=警告、跑不了=危险、未知=弱化。
function tierColor(theme, tier) {
  if (tier === 'recommended') return theme.colors.primarySoft;
  if (tier === 'tight') return theme.colors.star || theme.colors.dangerSoft;
  if (tier === 'incompatible') return theme.colors.dangerSoft;
  return theme.colors.textFaint;
}

export default function ModelSearchModal({ visible, onClose, initialSourceId, initialQuery = '', onSelect, totalMemoryBytes = 0 }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [sourceId, setSourceId] = useState(initialSourceId || 'huggingface');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [filesBusy, setFilesBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState(null);
  const [activeRepo, setActiveRepo] = useState(null);
  const [files, setFiles] = useState(null);

  // 为每个量化文件附上「参数规模 + 估算内存 + 兼容分级」，并按推荐程度排序：
  // 推荐（绰绰有余）在前，跑不了的沉底，帮助用户优先挑能稳跑的量化。
  const rankedFiles = useMemo(
    () => rankModelFiles((files && files.modelFiles) || [], { totalMemoryBytes, contextSize: 2048 }),
    [files, totalMemoryBytes]
  );

  // 精选目录（v5 Stage E）：按设备内存挑选的小尺寸仓库，点击直接进入该仓库文件层。
  const featured = useMemo(
    () => selectFeaturedModels({ totalMemoryBytes, sourceId }),
    [totalMemoryBytes, sourceId]
  );

  useEffect(() => {
    if (!visible) return;
    setSourceId(initialSourceId || 'huggingface');
    setQuery(initialQuery || '');
    setBusy(false);
    setFilesBusy(false);
    setError('');
    setResults(null);
    setActiveRepo(null);
    setFiles(null);
    // 从模型库「未安装精选卡」进入：带上仓库坐标，自动搜一次直达文件层。
    const seed = String(initialQuery || '').trim();
    if (seed) {
      runSearch(seed);
    }
  }, [visible, initialSourceId, initialQuery]);

  const runSearch = async override => {
    const text = String(override !== undefined ? override : query).trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    setActiveRepo(null);
    setFiles(null);
    try {
      const list = await searchModels(sourceId, text);
      setResults(list);
    } catch (searchError) {
      setResults([]);
      setError(searchError && searchError.message ? searchError.message : t('localModel.search.errorSearch'));
    } finally {
      setBusy(false);
    }
  };

  const openRepo = async repo => {
    if (filesBusy) return;
    setFilesBusy(true);
    setError('');
    setActiveRepo(repo);
    setFiles(null);
    try {
      const list = await listModelFiles(sourceId, repo.repoId);
      setFiles(list);
    } catch (filesError) {
      setFiles({ modelFiles: [], projectorFiles: [] });
      setError(filesError && filesError.message ? filesError.message : t('localModel.search.errorFiles'));
    } finally {
      setFilesBusy(false);
    }
  };

  const selectFile = file => {
    if (!activeRepo) return;
    const modelUrl = buildDownloadUrl(sourceId, activeRepo.repoId, activeRepo.revision, file.path);
    if (!modelUrl) {
      setError(t('localModel.search.errorNoUrl'));
      return;
    }
    if (typeof onSelect === 'function') {
      const projectorFiles = (files && files.projectorFiles) || [];
      onSelect({
        sourceId,
        provider: activeRepo.provider,
        repoId: activeRepo.repoId,
        revision: activeRepo.revision,
        modelId: fileBaseName(file.path),
        modelName: activeRepo.name,
        modelUrl,
        filePath: file.path,
        fileSize: file.size,
        fileSha256: file.sha256 || '',
        projectorFiles,
        mmprojUrls: projectorFiles
          .map(projector => buildDownloadUrl(sourceId, activeRepo.repoId, activeRepo.revision, projector.path))
          .filter(Boolean),
      });
    }
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{activeRepo ? t('localModel.search.titlePick') : t('localModel.search.titleSearch')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('common.close')}>
              <Ionicons name="close" size={22} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={styles.sourceRow}>
            {LOCAL_MODEL_DOWNLOAD_SOURCES.map(source => {
              const active = source.id === sourceId;
              return (
                <TouchableOpacity
                  key={source.id}
                  style={[styles.sourceChip, active && styles.sourceChipActive]}
                  onPress={() => {
                    setSourceId(source.id);
                    setResults(null);
                    setActiveRepo(null);
                    setFiles(null);
                    setError('');
                  }}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={t('localModel.a11y.useSource', { name: source.name })}
                >
                  <Text style={[styles.sourceChipText, active && styles.sourceChipTextActive]}>{source.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {activeRepo ? (
            <View style={styles.repoHeader}>
              <TouchableOpacity
                style={styles.backButton}
                onPress={() => {
                  setActiveRepo(null);
                  setFiles(null);
                  setError('');
                }}
                accessibilityRole="button"
                accessibilityLabel={t('localModel.search.backA11y')}
              >
                <Ionicons name="chevron-back" size={16} color={theme.colors.primarySoft} />
                <Text style={styles.backText}>{t('localModel.search.back')}</Text>
              </TouchableOpacity>
              <Text style={styles.repoName} numberOfLines={1}>{activeRepo.repoId}</Text>
            </View>
          ) : (
            <View style={styles.searchRow}>
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder={t('localModel.search.placeholder')}
                placeholderTextColor={theme.colors.textFaint}
                autoCapitalize="none"
                returnKeyType="search"
                onSubmitEditing={runSearch}
              />
              <TouchableOpacity
                style={[styles.searchButton, (!query.trim() || busy) && styles.searchButtonDisabled]}
                onPress={runSearch}
                disabled={!query.trim() || busy}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={t('localModel.search.buttonA11y')}
              >
                <Ionicons name="search" size={16} color={theme.colors.primaryContrast} />
              </TouchableOpacity>
            </View>
          )}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {activeRepo ? (
              filesBusy ? (
                <ActivityIndicator color={theme.colors.primary} style={styles.loading} />
              ) : (
                <>
                  {rankedFiles.map(({ file, summary }) => (
                    <TouchableOpacity
                      key={file.path}
                      style={styles.fileRow}
                      onPress={() => selectFile(file)}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={t('localModel.search.a11yPickFile', { name: file.path })}
                    >
                      <View style={styles.fileInfo}>
                        <View style={styles.fileNameRow}>
                          <Text style={styles.fileName} numberOfLines={1}>{fileBaseName(file.path)}</Text>
                          {summary.compatibility.label ? (
                            <Text style={[styles.tierChip, { color: tierColor(theme, summary.compatibility.tier) }]}>
                              {summary.compatibility.label}
                            </Text>
                          ) : null}
                        </View>
                        <Text style={styles.fileMeta}>
                          {formatBytes(file.size) || file.path}
                          {summary.memory.totalBytes > 0 ? t('localModel.search.metaMemory', { size: formatBytes(summary.memory.totalBytes) }) : ''}
                          {summary.paramLabel ? ` · ${summary.paramLabel}` : ''}
                          {totalMemoryBytes <= 0 ? t('localModel.search.metaMemoryUnknown') : ''}
                        </Text>
                      </View>
                      <Ionicons name="download-outline" size={18} color={theme.colors.primary} />
                    </TouchableOpacity>
                  ))}
                  {rankedFiles.length === 0 ? (
                    <Text style={styles.empty}>{t('localModel.search.noFiles')}</Text>
                  ) : null}
                  {totalMemoryBytes <= 0 ? (
                    <Text style={styles.compatHint}>{t('localModel.search.compatHint')}</Text>
                  ) : null}
                  {files && files.projectorFiles && files.projectorFiles.length > 0 ? (
                    <>
                      <Text style={styles.groupLabel}>{t('localModel.search.mmprojGroup')}</Text>
                      {files.projectorFiles.map(file => (
                        <View key={file.path} style={styles.projectorRow}>
                          <Text style={styles.fileName} numberOfLines={1}>{fileBaseName(file.path)}</Text>
                          <Text style={styles.fileMeta}>{formatBytes(file.size)}</Text>
                        </View>
                      ))}
                    </>
                  ) : null}
                </>
              )
            ) : busy ? (
              <ActivityIndicator color={theme.colors.primary} style={styles.loading} />
            ) : results && results.length > 0 ? (
              results.map(repo => (
                <TouchableOpacity
                  key={repo.repoId}
                  style={styles.resultRow}
                  onPress={() => openRepo(repo)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={t('localModel.search.a11yOpenRepo', { name: repo.repoId })}
                >
                  <View style={styles.fileInfo}>
                    <Text style={styles.fileName} numberOfLines={1}>{repo.name}</Text>
                    <Text style={styles.fileMeta} numberOfLines={1}>{repo.repoId}</Text>
                    <Text style={styles.fileMeta}>
                      {repo.downloads > 0 ? t('localModel.search.metaDownloads', { count: repo.downloads }) : ''}
                      {repo.likes > 0 ? t('localModel.search.metaLikes', { count: repo.likes }) : ''}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
                </TouchableOpacity>
              ))
            ) : results ? (
              <Text style={styles.empty}>{t('localModel.search.noResults')}</Text>
            ) : (
              <>
                {featured.length > 0 ? (
                  <>
                    <Text style={styles.groupLabel}>{t('localModel.featured.title')}</Text>
                    {featured.map(item => (
                      <TouchableOpacity
                        key={item.id}
                        style={styles.featuredRow}
                        onPress={() => openRepo({
                          repoId: item.repoId,
                          name: item.name,
                          provider: catalogProviderForSource(sourceId),
                          revision: 'main',
                        })}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        accessibilityLabel={t('localModel.featured.a11yPick', { name: item.name })}
                      >
                        <View style={styles.fileInfo}>
                          <Text style={styles.fileName} numberOfLines={1}>{item.name}</Text>
                          <Text style={styles.fileMeta} numberOfLines={1}>{item.repoId}</Text>
                          <Text style={styles.fileMeta}>
                            {t(item.noteKey)}
                            {item.memoryKnown && !item.fits ? ` · ${t('localModel.featured.tooBig')}` : ''}
                          </Text>
                        </View>
                        <Ionicons name="download-outline" size={16} color={theme.colors.primary} />
                      </TouchableOpacity>
                    ))}
                  </>
                ) : null}
                <Text style={styles.empty}>{t('localModel.search.hint')}</Text>
              </>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.overlay },
  sheet: { maxHeight: '88%', backgroundColor: theme.colors.surfaceAlt, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800' },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 },
  sourceChip: {
    borderRadius: tokens.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primaryMutedAlpha(0.45),
    backgroundColor: theme.colors.primaryAlpha(0.12),
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 8,
  },
  sourceChipActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryAlpha(0.22) },
  sourceChipText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700' },
  sourceChipTextActive: { color: theme.colors.primary },
  searchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  searchInput: { flex: 1, minHeight: 42, borderWidth: 1, borderColor: theme.colors.surfaceBorder, borderRadius: tokens.radius.md, backgroundColor: theme.colors.surface, color: theme.colors.text, paddingHorizontal: 12, paddingVertical: 9 },
  searchButton: { marginLeft: 8, width: 42, height: 42, borderRadius: tokens.radius.md, backgroundColor: theme.colors.primary, alignItems: 'center', justifyContent: 'center' },
  searchButtonDisabled: { opacity: 0.5 },
  repoHeader: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  backButton: { flexDirection: 'row', alignItems: 'center', marginRight: 8 },
  backText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), fontWeight: '700' },
  repoName: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  content: { paddingTop: 8, paddingBottom: 18 },
  loading: { marginVertical: 20 },
  error: { color: theme.colors.dangerSoft, fontSize: fonts.scaled(12), marginTop: 8 },
  empty: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginTop: 14, textAlign: 'center' },
  resultRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.surfaceBorder },
  featuredRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 10, marginBottom: 8, borderRadius: tokens.radius.md, borderWidth: 1, borderColor: theme.colors.primaryMutedAlpha(0.45), backgroundColor: theme.colors.primaryAlpha(0.08) },
  fileRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.surfaceBorder },
  fileInfo: { flex: 1, marginRight: 8 },
  fileNameRow: { flexDirection: 'row', alignItems: 'center' },
  fileName: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  tierChip: { fontSize: fonts.scaled(11), fontWeight: '800', marginLeft: 8 },
  fileMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  compatHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 12 },
  groupLabel: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginTop: 14, marginBottom: 4 },
  projectorRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
});
