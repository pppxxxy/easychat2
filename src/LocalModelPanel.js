import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';

import {
  deleteLocalModelItem,
  getLocalModelIndex,
  getLocalModelItem,
  getLocalModelSettings,
  saveLocalModelItem,
  saveLocalModelSettings,
} from './storage.js';
import { cleanupOrphanLocalModelFiles, deleteLocalModel, downloadLocalModel, getLocalModelFileInfo, importLocalModel } from './localModel/modelManager.js';
import { isLocalModelModuleAvailable, loadLocalModel } from './localModel/adapter.js';
import { tryAcquireResource } from './resourceMutex.js';
import {
  getLocalApiServerStatus,
  isLocalApiServerAvailable,
  startLocalApiServer,
  stopLocalApiServer,
} from './localModel/localApiServer.js';
import { LOCAL_MODEL_DOWNLOAD_SOURCES, applyActiveLocalModel, clearActiveLocalModel } from './localModel/modelState.js';
import { rewriteDownloadSourceUrl } from './localModel/modelCatalog.js';
import { buildModelSummary } from './localModel/modelCompatibility.js';
import { getDeviceMemoryInfo } from './localModel/deviceMemory.js';
import { LOCAL_MODEL_PARAM_FIELDS, normalizeLocalModelParams, validateLocalModelParams } from './localModel/modelParams.js';
import { getPickedAsset } from './character/cardHelpers.js';
import ModelSearchModal from './localModel/ModelSearchModal.js';
import ModelLogsModal from './localModel/ModelLogsModal.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';

const PARAM_LABEL_KEYS = {
  contextSize: 'localModel.param.contextSize',
  gpuLayers: 'localModel.param.gpuLayers',
  threads: 'localModel.param.threads',
  temperature: 'localModel.param.temperature',
  topP: 'localModel.param.topP',
  topK: 'localModel.param.topK',
  maxTokens: 'localModel.param.maxTokens',
};

function emptyDraft() {
  return {
    modelId: '',
    name: '',
    modelUrl: '',
    sourceId: '',
    repoPath: '',
    quant: '',
    paramSize: 0,
    // 目录声明的精确字节数与 sha256（来自文件列表），用于下载完整性校验。
    modelExpectedBytes: 0,
    modelSha256: '',
    mmprojUrl: '',
    mmprojUrls: [],
    importSourceUri: '',
    importName: '',
    mmprojSourceUri: '',
    mmprojSourceName: '',
  };
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)}${units[index]}`;
}

function tierColor(theme, tier) {
  if (tier === 'recommended') return theme.colors.primary;
  if (tier === 'incompatible') return theme.colors.danger;
  return theme.colors.dangerSoft;
}

export default function LocalModelPanel({ visible, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const paramLabel = useCallback(field => t(PARAM_LABEL_KEYS[field] || '') || field, [t]);
  const [entries, setEntries] = useState([]);
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [expandedId, setExpandedId] = useState('');
  const [deviceMemoryBytes, setDeviceMemoryBytes] = useState(0);
  const [paramsTarget, setParamsTarget] = useState(null);
  const [paramsForm, setParamsForm] = useState({});
  const [paramsBusy, setParamsBusy] = useState(false);
  const [apiServer, setApiServer] = useState({ enabled: false, host: '127.0.0.1', port: 8080, apiKey: '' });
  const [apiStatus, setApiStatus] = useState({ running: false, port: 0 });
  const [apiBusy, setApiBusy] = useState(false);
  // 显式加载：面板里的加载按钮状态（加载中的条目 id、进度百分比、已加载条目 id）。
  const [loadBusyId, setLoadBusyId] = useState('');
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadedModelId, setLoadedModelId] = useState('');

  const refresh = useCallback(async () => {
    const [list, current] = await Promise.all([
      getLocalModelIndex().catch(() => []),
      getLocalModelSettings().catch(() => null),
    ]);
    setEntries(list);
    setSettings(current);
  }, []);

  useEffect(() => {
    setDeviceMemoryBytes(getDeviceMemoryInfo().totalMemoryBytes);
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    Promise.all([
      getLocalModelIndex().catch(() => []),
      getLocalModelSettings().catch(() => null),
      getLocalApiServerStatus().catch(() => ({ running: false, port: 0 })),
    ]).then(([list, current, status]) => {
      if (cancelled) return;
      setEntries(list);
      setSettings(current);
      if (current && current.apiServer) setApiServer(current.apiServer);
      setApiStatus({ running: Boolean(status && status.running), port: Number(status && status.port) || 0 });
    });
    return () => { cancelled = true; };
  }, [visible]);

  const draftSummary = useMemo(() => buildModelSummary(
    { name: `${draft.name} ${draft.modelId}`, quant: draft.quant, paramSize: draft.paramSize },
    { totalMemoryBytes: deviceMemoryBytes, contextSize: 2048 }
  ), [draft, deviceMemoryBytes]);

  const selectActive = async entry => {
    const item = await getLocalModelItem(entry.id).catch(() => null);
    if (!item) return;
    const info = await getLocalModelFileInfo(item).catch(() => ({ exists: false }));
    if (!info || info.exists === false) {
      Alert.alert(t('localModel.alert.modelNotReady.title'), t('localModel.alert.modelNotReady.fileMissing'));
      return;
    }
    try {
      const next = await saveLocalModelSettings(applyActiveLocalModel(settings, item));
      setSettings(next);
    } catch (error) {
      Alert.alert(t('localModel.alert.saveFailed.title'), t('localModel.alert.saveFailed.body'));
    }
  };

  const toggleEnabled = async () => {
    if (!settings) return;
    if (!settings.activeModelId) {
      Alert.alert(t('localModel.alert.noModelSelected.title'), t('localModel.alert.noModelSelected.body'));
      return;
    }
    if (!settings.enabled) {
      const item = await getLocalModelItem(settings.activeModelId).catch(() => null);
      const info = item ? await getLocalModelFileInfo(item).catch(() => ({ exists: false })) : { exists: false };
      if (!info.exists) {
        Alert.alert(t('localModel.alert.modelNotReady.title'), t('localModel.alert.modelNotReady.downloadFirst'));
        return;
      }
    }
    try {
      const next = await saveLocalModelSettings({ ...settings, enabled: !settings.enabled });
      setSettings(next);
    } catch (error) {
      Alert.alert(t('localModel.alert.saveFailed.title'), t('localModel.alert.saveFailed.body'));
    }
  };

  const toggleMediaInput = async () => {
    if (!settings) return;
    try {
      const next = await saveLocalModelSettings({ ...settings, enableMediaInput: !settings.enableMediaInput });
      setSettings(next);
    } catch (error) {
      Alert.alert(t('localModel.alert.saveFailed.title'), t('localModel.alert.saveFailed.body'));
    }
  };

  const persistApiServer = async patch => {
    const next = await saveLocalModelSettings({
      ...(settings || {}),
      apiServer: { ...apiServer, ...patch },
    });
    setSettings(next);
    setApiServer(next.apiServer);
    return next;
  };

  const startApi = async () => {
    if (apiBusy) return;
    if (!isLocalApiServerAvailable()) {
      Alert.alert(t('localModel.alert.apiUnavailable.title'), t('localModel.alert.apiUnavailable.body'));
      return;
    }
    setApiBusy(true);
    try {
      // 留空即自动生成随机密钥（两端都强制鉴权）；生成后持久化，重启不变。
      const keyWasEmpty = !String(apiServer.apiKey || '').trim();
      const saved = await persistApiServer({ enabled: true });
      const status = await startLocalApiServer({
        port: apiServer.port,
        apiKey: apiServer.apiKey,
        modelId: saved.activeModelId || 'local-model',
      });
      const effectiveKey = String((status && status.apiKey) || apiServer.apiKey || '');
      if (keyWasEmpty && effectiveKey) {
        // 把生成的密钥写回设置（幂等带上 enabled，避免与旧闭包状态合并后丢失开关），
        // persistApiServer 内部会同步 setApiServer；客户端照此携带 Bearer。
        await persistApiServer({ enabled: true, apiKey: effectiveKey });
      }
      setApiStatus({ running: true, port: Number(status && status.port) || apiServer.port });
      if (keyWasEmpty) {
        Alert.alert(
          t('localModel.alert.apiKeyGenerated.title'),
          t('localModel.alert.apiKeyGenerated.body', { key: effectiveKey })
        );
      }
    } catch (error) {
      Alert.alert(t('localModel.alert.apiStartFailed.title'), error.message || t('localModel.alert.apiStartFailed.body'));
    } finally {
      setApiBusy(false);
    }
  };

  const stopApi = async () => {
    if (apiBusy) return;
    setApiBusy(true);
    try {
      await stopLocalApiServer();
      await persistApiServer({ enabled: false });
      setApiStatus({ running: false, port: 0 });
    } catch (error) {
      Alert.alert(t('localModel.alert.apiStopFailed.title'), error.message || t('localModel.alert.apiStopFailed.body'));
    } finally {
      setApiBusy(false);
    }
  };

  // 展示给用户复制的本地地址：运行中用实际监听端口，未启动时用配置端口，
  // 始终以 /v1 结尾（OpenAI 兼容 base_url）。startLocalApiServer 可能因端口
  // 被占用回落到其他端口，故以 apiStatus.port 为准。
  const apiAddress = useMemo(() => {
    const port = apiStatus.running && apiStatus.port ? apiStatus.port : apiServer.port;
    const effectivePort = Number(port) > 0 ? Number(port) : 8080;
    return `http://127.0.0.1:${effectivePort}/v1`;
  }, [apiStatus.running, apiStatus.port, apiServer.port]);

  const copyApiAddress = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(apiAddress);
      Alert.alert(
        t('localModel.alert.addressCopied.title'),
        t(
          apiServer.apiKey?.trim()
            ? 'localModel.alert.addressCopied.bodyWithKey'
            : 'localModel.alert.addressCopied.bodyNoKey',
          { address: apiAddress }
        )
      );
    } catch (error) {
      Alert.alert(t('localModel.alert.copyFailed.title'), t('localModel.alert.copyFailed.body', { address: apiAddress }));
    }
  }, [apiAddress, apiServer.apiKey]);

  const openParams = async entry => {
    const item = await getLocalModelItem(entry.id).catch(() => null);
    if (!item) {
      Alert.alert(t('localModel.alert.paramsUnavailable.title'), t('localModel.alert.paramsUnavailable.body'));
      return;
    }
    setParamsTarget(item);
    const form = {};
    Object.keys(LOCAL_MODEL_PARAM_FIELDS).forEach(field => { form[field] = String(item.params[field]); });
    setParamsForm(form);
  };

  const saveParams = async () => {
    if (!paramsTarget || paramsBusy) return;
    const check = validateLocalModelParams(paramsForm);
    if (!check.valid) {
      Alert.alert(t('localModel.alert.paramsInvalid.title'), check.errors.map(item => `${paramLabel(item.field)}：${item.message}`).join('\n'));
      return;
    }
    setParamsBusy(true);
    try {
      const saved = await saveLocalModelItem({ ...paramsTarget, params: normalizeLocalModelParams(paramsForm) });
      if (settings && settings.activeModelId === saved.id) {
        setSettings(await saveLocalModelSettings({
          ...settings,
          contextSize: saved.params.contextSize,
          gpuLayers: saved.params.gpuLayers,
        }));
      }
      setParamsTarget(null);
      await refresh();
    } catch (error) {
      Alert.alert(t('localModel.alert.saveFailed.title'), error.message || t('localModel.alert.saveFailed.retry'));
    } finally {
      setParamsBusy(false);
    }
  };

  const confirmDelete = entry => {
    Alert.alert(t('localModel.alert.deleteModel.title'), t('localModel.alert.deleteModel.body', { name: entry.name || entry.id }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          const item = await getLocalModelItem(entry.id).catch(() => null);
          if (item) await deleteLocalModel(item).catch(() => {});
          await deleteLocalModelItem(entry.id).catch(() => {});
          if (settings && settings.activeModelId === entry.id) {
            if (apiStatus.running) await stopLocalApiServer().catch(() => {});
            try {
              const next = await saveLocalModelSettings(clearActiveLocalModel(settings));
              setSettings(next);
            } catch (error) {
              Alert.alert(t('localModel.alert.saveFailed.title'), t('localModel.alert.saveFailed.body'));
            }
            setApiStatus({ running: false, port: 0 });
          } else {
            setSettings(await getLocalModelSettings().catch(() => settings));
          }
          setExpandedId('');
          await refresh();
        },
      },
    ]);
  };

  const [cleanupBusy, setCleanupBusy] = useState(false);

  // 扫描并清理下载/导入被杀留下的 .download/.old/.import 残留（数 GB 隐形占用）。
  const handleCleanupOrphans = async () => {
    if (cleanupBusy) return;
    setCleanupBusy(true);
    try {
      const { removed, freedBytes } = await cleanupOrphanLocalModelFiles();
      if (removed === 0) {
        Alert.alert(t('localModel.alert.cleanupDone.title'), t('localModel.alert.cleanupDone.empty'));
      } else {
        Alert.alert(t('localModel.alert.cleanupDone.title'), t('localModel.alert.cleanupDone.body', { count: removed, size: formatBytes(freedBytes) || '0B' }));
      }
    } catch (error) {
      Alert.alert(t('localModel.alert.cleanupFailed.title'), error.message || t('localModel.alert.cleanupFailed.body'));
    } finally {
      setCleanupBusy(false);
    }
  };

  const handleDownload = async () => {
    if (busy) return;
    const url = draft.modelUrl.trim();
    if (!draft.modelId.trim() || !/^https?:\/\//i.test(url)) {
      Alert.alert(t('localModel.alert.downloadInfoIncomplete.title'), t('localModel.alert.downloadInfoIncomplete.body'));
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const item = await downloadLocalModel({
        modelId: draft.modelId,
        modelName: draft.name || draft.modelId,
        modelUrl: url,
        sourceId: draft.sourceId,
        repoPath: draft.repoPath,
        quant: draft.quant,
        paramSize: draft.paramSize,
        modelExpectedBytes: draft.modelExpectedBytes,
        modelSha256: draft.modelSha256,
        mmprojUrl: draft.mmprojUrl,
        onProgress: setProgress,
      });
      Alert.alert(t('localModel.alert.downloadDone.title'), t('localModel.alert.downloadDone.body', { name: item.name || item.id }));
      setDraft(emptyDraft());
      await refresh();
    } catch (error) {
      Alert.alert(t('localModel.alert.downloadFailed.title'), error.message || t('localModel.alert.downloadFailed.body'));
    } finally {
      setBusy(false);
    }
  };

  const pickGguf = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
      const asset = getPickedAsset(result);
      if (!asset || !asset.uri) return;
      setDraft(current => ({ ...current, importSourceUri: asset.uri, importName: asset.name || '' }));
    } catch (error) {
      Alert.alert(t('localModel.alert.pickFileFailed.title'), error.message || t('localModel.alert.pickFileFailed.body'));
    }
  };

  const pickMmproj = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
      const asset = getPickedAsset(result);
      if (!asset || !asset.uri) return;
      setDraft(current => ({ ...current, mmprojSourceUri: asset.uri, mmprojSourceName: asset.name || '' }));
    } catch (error) {
      Alert.alert(t('localModel.alert.pickFileFailed.title'), error.message || t('localModel.alert.pickFileFailed.body'));
    }
  };

  const handleImport = async () => {
    if (importBusy) return;
    if (!draft.importSourceUri) {
      Alert.alert(t('localModel.alert.noFileSelected.title'), t('localModel.alert.noFileSelected.body'));
      return;
    }
    setImportBusy(true);
    try {
      const item = await importLocalModel({
        sourceUri: draft.importSourceUri,
        name: draft.importName,
        mmprojSourceUri: draft.mmprojSourceUri,
      });
      Alert.alert(t('localModel.alert.importDone.title'), t('localModel.alert.importDone.body', { name: item.name || item.id }));
      setDraft(current => ({ ...current, importSourceUri: '', importName: '', mmprojSourceUri: '', mmprojSourceName: '' }));
      await refresh();
    } catch (error) {
      Alert.alert(t('localModel.alert.importFailed.title'), error.message || t('localModel.alert.importFailed.body'));
    } finally {
      setImportBusy(false);
    }
  };

  const handleSearchSelect = selection => {
    if (!selection) return;
    const mmprojUrls = Array.isArray(selection.mmprojUrls) ? selection.mmprojUrls : [];
    setDraft(current => ({
      ...current,
      modelId: selection.modelId || current.modelId,
      name: selection.modelName || current.name,
      modelUrl: selection.modelUrl || current.modelUrl,
      sourceId: selection.sourceId || current.sourceId,
      repoPath: selection.repoId || '',
      modelExpectedBytes: Number(selection.fileSize) > 0 ? Number(selection.fileSize) : 0,
      modelSha256: selection.fileSha256 || '',
      mmprojUrl: mmprojUrls[0] || '',
      mmprojUrls,
    }));
    // 下载前提醒：模型体积 + 上下文长度共同决定内存占用，选错量化或把上下文设太长
    // 都可能超出上限导致加载失败/OOM。用当前设备内存给出「推荐/难跑/跑不了」判断。
    const summary = buildModelSummary(
      { name: selection.modelId || selection.modelName || '' },
      { totalMemoryBytes: deviceMemoryBytes, contextSize: 2048 }
    );
    const memText = summary.memory.totalBytes > 0
      ? t('localModel.alert.preDownload.memory', { size: formatBytes(summary.memory.totalBytes) })
      : t('localModel.alert.preDownload.memoryUnknown');
    const tierText = summary.compatibility.label ? t('localModel.alert.preDownload.tier', { label: summary.compatibility.label }) : '';
    Alert.alert(
      t('localModel.alert.preDownload.title'),
      `${tierText}${memText}\n\n${t('localModel.alert.preDownload.body')}`
    );
  };

  const rewriteSource = source => {
    setDraft(current => {
      const rewritten = rewriteDownloadSourceUrl(current.modelUrl, source.id);
      if (rewritten) return { ...current, modelUrl: rewritten, sourceId: source.id };
      const repoPath = String(current.modelUrl || '').replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '');
      return { ...current, modelUrl: repoPath ? `${source.baseUrl}/${repoPath}` : `${source.baseUrl}/`, sourceId: source.id };
    });
  };

  // 面板内的显式加载：与聊天页加载共用 local-model 互斥锁；进度 0-100，
  // 完成后标记「已加载」。加载前先确认文件存在，缺失给明确指引。
  const handleLoadModel = async entry => {
    if (!entry || loadBusyId) return;
    const release = tryAcquireResource('local-model');
    if (!release) {
      Alert.alert(t('localModel.alert.resourceBusy.title'), t('localModel.alert.resourceBusy.body'));
      return;
    }
    setLoadBusyId(entry.id);
    setLoadProgress(0);
    try {
      const item = await getLocalModelItem(entry.id).catch(() => null);
      if (!item) throw new Error(t('localModel.error.itemMissing'));
      const info = await getLocalModelFileInfo(item).catch(() => ({ exists: false }));
      if (!info || info.exists === false) throw new Error(t('localModel.error.fileMissing'));
      await loadLocalModel(item, {
        onProgress: p => setLoadProgress(Math.max(0, Math.min(100, Math.round(Number(p) || 0)))),
      });
      setLoadedModelId(entry.id);
      setLoadProgress(100);
      Alert.alert(t('localModel.alert.modelLoaded.title'), t('localModel.alert.modelLoaded.body'));
    } catch (error) {
      Alert.alert(t('localModel.alert.loadFailed.title'), error.message || t('localModel.alert.loadFailed.body'));
    } finally {
      release();
      setLoadBusyId('');
    }
  };

  const renderEntry = entry => {
    const summary = buildModelSummary(entry, { totalMemoryBytes: deviceMemoryBytes, contextSize: 2048 });
    const active = Boolean(settings && settings.activeModelId === entry.id);
    const expanded = expandedId === entry.id;
    return (
      <View key={entry.id} style={[styles.item, active && styles.itemActive]}>
        <TouchableOpacity
          style={styles.itemHeader}
          onPress={() => setExpandedId(expanded ? '' : entry.id)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={t('localModel.a11y.expand', { name: entry.name || entry.id })}
        >
          <View style={styles.itemInfo}>
            <Text style={styles.itemName} numberOfLines={1}>{entry.name || entry.id}{active ? t('localModel.currentSuffix') : ''}</Text>
            <View style={styles.chipRow}>
              {summary.quantLabel ? <Text style={styles.chip}>{t('localModel.chip.quant', { label: summary.quantLabel })}</Text> : null}
              {summary.paramLabel ? <Text style={styles.chip}>{t('localModel.chip.size', { label: summary.paramLabel })}</Text> : null}
              {entry.modelBytes > 0 ? <Text style={styles.chip}>{formatBytes(entry.modelBytes)}</Text> : null}
              {entry.hasVision ? <Text style={styles.chip}>{t('localModel.chip.vision')}</Text> : null}
              {entry.hasAudio ? <Text style={styles.chip}>{t('localModel.chip.audio')}</Text> : null}
              {entry.imported ? <Text style={styles.chip}>{t('localModel.chip.imported')}</Text> : null}
              <Text style={[styles.tierChip, { color: tierColor(theme, summary.compatibility.tier) }]}>{summary.compatibility.label}</Text>
            </View>
          </View>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textMuted} />
        </TouchableOpacity>
        {expanded ? (
          <>
            <View style={styles.itemActions}>
              {active ? (
                <View style={styles.activeCheck} accessibilityLabel={t('localModel.a11y.currentModel')}>
                  <Ionicons name="checkmark-circle" size={18} color={theme.colors.primary} />
                </View>
              ) : null}
              <TouchableOpacity
                style={[styles.selectButton, active && styles.selectButtonActive]}
                onPress={() => selectActive(entry)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={active ? t('localModel.a11y.activeModel') : t('localModel.a11y.selectModel', { name: entry.name || entry.id })}
              >
                <Text style={styles.selectButtonText}>{active ? t('localModel.selected') : t('localModel.select')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.iconButton, loadBusyId === entry.id && styles.loadButtonBusy]}
                onPress={() => handleLoadModel(entry)}
                disabled={Boolean(loadBusyId)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={
                  loadedModelId === entry.id ? t('localModel.a11y.modelLoaded') : t('localModel.a11y.loadModel', { name: entry.name || entry.id })
                }
              >
                <Ionicons name="hardware-chip-outline" size={16} color={theme.colors.primarySoft} />
                <Text style={styles.iconButtonText}>
                  {loadBusyId === entry.id ? t('localModel.loading', { progress: loadProgress }) : loadedModelId === entry.id ? t('localModel.loaded') : t('localModel.load')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.iconButton} onPress={() => openParams(entry)} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={t('localModel.params')}>
                <Ionicons name="options-outline" size={16} color={theme.colors.primarySoft} />
                <Text style={styles.iconButtonText}>{t('localModel.params')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.iconButton} onPress={() => confirmDelete(entry)} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={t('common.delete')}>
                <Ionicons name="trash-outline" size={16} color={theme.colors.dangerSoft} />
                <Text style={styles.dangerText}>{t('common.delete')}</Text>
              </TouchableOpacity>
            </View>
            {loadBusyId === entry.id ? (
              <View style={styles.loadProgressRow} accessibilityLabel={t('localModel.a11y.loadProgress', { progress: loadProgress })}>
                <View style={styles.loadProgressBar}>
                  <View style={[styles.loadProgressFill, { width: `${loadProgress}%` }]} />
                </View>
                <Text style={styles.loadProgressText}>{loadProgress}%</Text>
              </View>
            ) : null}
          </>
        ) : null}
      </View>
    );
  };

  return (
    <>
      <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
        <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.sheet}>
            <View style={styles.header}>
              <Text style={styles.title}>{t('localModel.title')}</Text>
              <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('common.close')}>
                <Ionicons name="close" size={22} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              <Text style={styles.hint}>{t('localModel.hint')}</Text>
              <Text style={styles.status}>{isLocalModelModuleAvailable() ? t('localModel.moduleAvailable') : t('localModel.moduleUnavailable')}</Text>
              <TouchableOpacity style={styles.logsButton} onPress={() => setLogsOpen(true)} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={t('localModel.viewLogs')}>
                <Ionicons name="document-text-outline" size={14} color={theme.colors.primarySoft} />
                <Text style={styles.logsButtonText}>{t('localModel.viewLogs')}</Text>
              </TouchableOpacity>

              <View style={styles.activeRow}>
                <Text style={styles.activeText}>
                  {settings && settings.activeModelId
                    ? t('localModel.currentModel', { name: settings.modelName || settings.activeModelId })
                    : t('localModel.noCurrentModel')}
                </Text>
                <TouchableOpacity
                  style={[styles.toggle, settings && settings.enabled && styles.toggleOn]}
                  onPress={toggleEnabled}
                  activeOpacity={0.8}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: Boolean(settings && settings.enabled) }}
                  accessibilityLabel={t('localModel.a11y.enableToggle')}
                >
                  <Text style={styles.toggleText}>{settings && settings.enabled ? t('localModel.enabled') : t('localModel.disabled')}</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={styles.mediaRow}
                onPress={toggleMediaInput}
                activeOpacity={0.8}
                accessibilityRole="switch"
                accessibilityState={{ checked: Boolean(settings && settings.enableMediaInput) }}
                accessibilityLabel={t('localModel.mediaInput.title')}
              >
                <View style={styles.mediaInfo}>
                  <Text style={styles.mediaTitle}>{t('localModel.mediaInput.title')}</Text>
                  <Text style={styles.mediaHint}>
                    {settings && settings.enableMediaInput
                      ? t('localModel.mediaInput.hintOn')
                      : t('localModel.mediaInput.hintOff')}
                  </Text>
                </View>
                <View style={[styles.toggle, settings && settings.enableMediaInput && styles.toggleOn]}>
                  <Text style={styles.toggleText}>{settings && settings.enableMediaInput ? t('common.on') : t('common.off')}</Text>
                </View>
              </TouchableOpacity>

              <View style={styles.labelRow}>
                <Text style={styles.labelInline}>{t('localModel.installedCount', { count: entries.length })}</Text>
                <TouchableOpacity
                  style={styles.searchModelButton}
                  onPress={handleCleanupOrphans}
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
                <Text style={styles.empty}>{t('localModel.empty')}</Text>
              ) : (
                entries.map(renderEntry)
              )}

              <Text style={styles.label}>{t('localModel.download.section')}</Text>
              <View style={styles.labelRow}>
                <Text style={styles.labelInline}>{t('localModel.download.modelId')}</Text>
                <TouchableOpacity
                  style={styles.searchModelButton}
                  onPress={() => setSearchVisible(true)}
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
                value={draft.modelId}
                onChangeText={text => setDraft(current => ({ ...current, modelId: text }))}
                placeholder={t('localModel.download.modelIdPlaceholder')}
                placeholderTextColor={theme.colors.textFaint}
              />
              <View style={styles.summaryCard}>
                <Text style={styles.summaryName} numberOfLines={1}>{draft.name || draft.modelId || t('localModel.summary.noModel')}</Text>
                <View style={styles.summaryRow}>
                  {draftSummary.quantLabel ? <Text style={styles.summaryChip}>{t('localModel.chip.quant', { label: draftSummary.quantLabel })}</Text> : null}
                  {draftSummary.paramLabel ? <Text style={styles.summaryChip}>{t('localModel.chip.size', { label: draftSummary.paramLabel })}</Text> : null}
                  {draftSummary.memory.totalBytes > 0 ? <Text style={styles.summaryChip}>{t('localModel.summary.memory', { size: formatBytes(draftSummary.memory.totalBytes) })}</Text> : null}
                  <Text style={[styles.summaryTier, { color: tierColor(theme, draftSummary.compatibility.tier) }]}>{draftSummary.compatibility.label}</Text>
                </View>
                <Text style={styles.summaryHint}>
                  {t('localModel.summary.hint')}
                </Text>
              </View>

              <View style={styles.sourceRow}>
                {LOCAL_MODEL_DOWNLOAD_SOURCES.map(source => (
                  <TouchableOpacity
                    key={source.id}
                    style={[styles.sourceChip, draft.sourceId === source.id && styles.sourceChipActive]}
                    onPress={() => rewriteSource(source)}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={t('localModel.a11y.useSource', { name: source.name })}
                  >
                    <Text style={[styles.sourceChipText, draft.sourceId === source.id && styles.sourceChipTextActive]}>{source.name}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.label}>{t('localModel.download.urlLabel')}</Text>
              <TextInput
                style={styles.input}
                value={draft.modelUrl}
                onChangeText={text => setDraft(current => ({ ...current, modelUrl: text }))}
                placeholder="https://huggingface.co/<repo>/resolve/main/model.gguf"
                placeholderTextColor={theme.colors.textFaint}
                autoCapitalize="none"
              />
              {draft.mmprojUrls.length > 0 ? (
                <>
                  <Text style={styles.label}>{t('localModel.download.mmprojLabel')}</Text>
                  <View style={styles.sourceRow}>
                    <TouchableOpacity
                      style={[styles.sourceChip, !draft.mmprojUrl && styles.sourceChipActive]}
                      onPress={() => setDraft(current => ({ ...current, mmprojUrl: '' }))}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.sourceChipText, !draft.mmprojUrl && styles.sourceChipTextActive]}>{t('localModel.download.mmprojSkip')}</Text>
                    </TouchableOpacity>
                    {draft.mmprojUrls.map((url, index) => (
                      <TouchableOpacity
                        key={url}
                        style={[styles.sourceChip, draft.mmprojUrl === url && styles.sourceChipActive]}
                        onPress={() => setDraft(current => ({ ...current, mmprojUrl: url }))}
                        activeOpacity={0.8}
                      >
                        <Text style={[styles.sourceChipText, draft.mmprojUrl === url && styles.sourceChipTextActive]}>mmproj {index + 1}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              ) : null}
              {busy ? <Text style={styles.progress}>{t('localModel.download.progress', { progress: Math.round(progress * 100) })}</Text> : null}
              <TouchableOpacity style={styles.primary} onPress={handleDownload} disabled={busy} activeOpacity={0.8}>
                <Text style={styles.primaryText}>{busy ? t('localModel.download.busy') : t('localModel.download.button')}</Text>
              </TouchableOpacity>

              <Text style={styles.label}>{t('localModel.import.section')}</Text>
              <TouchableOpacity style={styles.secondary} onPress={pickGguf} activeOpacity={0.8}>
                <Text style={styles.secondaryText}>{draft.importSourceUri ? t('localModel.import.selectedGguf', { name: draft.importName || t('localModel.import.ggufFile') }) : t('localModel.import.pickGguf')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondary} onPress={pickMmproj} activeOpacity={0.8}>
                <Text style={styles.secondaryText}>{draft.mmprojSourceUri ? t('localModel.import.selectedMmproj', { name: draft.mmprojSourceName || t('localModel.import.mmprojSelected') }) : t('localModel.import.pickMmproj')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primary} onPress={handleImport} disabled={importBusy} activeOpacity={0.8}>
                <Text style={styles.primaryText}>{importBusy ? t('localModel.import.busy') : t('localModel.import.button')}</Text>
              </TouchableOpacity>

              <Text style={styles.label}>{t('localModel.api.section')}</Text>
              <Text style={styles.hint}>{t('localModel.api.hint')}</Text>
              <View style={styles.apiPortRow}>
                <Text style={styles.labelInline}>{t('localModel.api.port')}</Text>
                <TextInput
                  style={[styles.input, styles.apiPortInput]}
                  value={String(apiServer.port)}
                  onChangeText={text => setApiServer(current => ({ ...current, port: text }))}
                  keyboardType="numeric"
                  placeholderTextColor={theme.colors.textFaint}
                />
              </View>
              <TextInput
                style={styles.input}
                value={apiServer.apiKey}
                onChangeText={text => setApiServer(current => ({ ...current, apiKey: text }))}
                placeholder={t('localModel.api.keyPlaceholder')}
                placeholderTextColor={theme.colors.textFaint}
                autoCapitalize="none"
              />
              <Text style={styles.apiStatus}>
                {apiStatus.running ? t('localModel.api.running') : t('localModel.api.stopped')}
              </Text>
              <TouchableOpacity
                style={styles.apiAddressRow}
                onPress={copyApiAddress}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={t('localModel.a11y.copyApiAddress', { address: apiAddress })}
              >
                <Text style={styles.apiAddress} numberOfLines={1}>{apiAddress}</Text>
                <View style={styles.apiCopyChip}>
                  <Ionicons name="copy-outline" size={14} color={theme.colors.primarySoft} />
                  <Text style={styles.apiCopyText}>{t('common.copy')}</Text>
                </View>
              </TouchableOpacity>
              <Text style={styles.apiAddressHint}>{t('localModel.api.addressHint')}</Text>
              <View style={styles.apiButtonRow}>
                <TouchableOpacity style={[styles.secondary, styles.apiButton]} onPress={startApi} disabled={apiBusy} activeOpacity={0.8}>
                  <Text style={styles.secondaryText}>{apiBusy ? t('common.loading') : t('localModel.api.start')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.secondary, styles.apiButton]} onPress={stopApi} disabled={apiBusy} activeOpacity={0.8}>
                  <Text style={styles.secondaryText}>{t('localModel.api.stop')}</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={Boolean(paramsTarget)} transparent animationType="slide" onRequestClose={() => setParamsTarget(null)}>
        <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.sheet}>
            <View style={styles.header}>
              <Text style={styles.title}>{t('localModel.paramsModal.title')}</Text>
              <TouchableOpacity onPress={() => setParamsTarget(null)} hitSlop={8} accessibilityLabel={t('common.close')}>
                <Ionicons name="close" size={22} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={styles.hint}>{paramsTarget ? t('localModel.paramsModal.hint', { name: paramsTarget.name || paramsTarget.id }) : ''}</Text>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              {Object.keys(LOCAL_MODEL_PARAM_FIELDS).map(field => (
                <View key={field} style={styles.paramField}>
                  <Text style={styles.label}>{paramLabel(field)}</Text>
                  <TextInput
                    style={styles.input}
                    value={paramsForm[field] ?? ''}
                    onChangeText={text => setParamsForm(current => ({ ...current, [field]: text }))}
                    placeholderTextColor={theme.colors.textFaint}
                  />
                </View>
              ))}
              {paramsBusy ? <ActivityIndicator color={theme.colors.primary} style={styles.loading} /> : null}
              <TouchableOpacity style={styles.primary} onPress={saveParams} disabled={paramsBusy} activeOpacity={0.8}>
                <Text style={styles.primaryText}>{paramsBusy ? t('common.saving') : t('localModel.paramsModal.save')}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ModelSearchModal
        visible={searchVisible}
        onClose={() => setSearchVisible(false)}
        initialSourceId={draft.sourceId || LOCAL_MODEL_DOWNLOAD_SOURCES[0].id}
        onSelect={handleSearchSelect}
        totalMemoryBytes={deviceMemoryBytes}
      />

      <ModelLogsModal visible={logsOpen} onClose={() => setLogsOpen(false)} />
    </>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.overlay },
  sheet: { maxHeight: '90%', backgroundColor: theme.colors.surfaceAlt, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { color: theme.colors.text, fontSize: fonts.scaled(18), fontWeight: '800' },
  content: { paddingBottom: 18 },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 10 },
  status: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginBottom: 10 },
  logsButton: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginBottom: 10 },
  logsButtonText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },
  activeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.surfaceBorder, borderRadius: tokens.radius.md, paddingHorizontal: 12, paddingVertical: 10 },
  activeText: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700', marginRight: 8 },
  toggle: { borderRadius: tokens.radius.pill, borderWidth: 1, borderColor: theme.colors.surfaceBorder, paddingHorizontal: 12, paddingVertical: 6 },
  toggleOn: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryAlpha(0.18) },
  toggleText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700' },
  mediaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.surfaceBorder, borderRadius: tokens.radius.md, paddingHorizontal: 12, paddingVertical: 10, marginTop: 8 },
  mediaInfo: { flex: 1, marginRight: 8 },
  mediaTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  mediaHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 2 },
  apiPortRow: { flexDirection: 'row', alignItems: 'center' },
  apiPortInput: { flex: 1, marginLeft: 10 },
  apiStatus: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginTop: 8 },
  apiAddressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
  },
  apiAddress: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(13), fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  apiCopyChip: { flexDirection: 'row', alignItems: 'center', marginLeft: 10 },
  apiCopyText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },
  apiAddressHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 6 },
  apiButtonRow: { flexDirection: 'row', marginTop: 4 },
  apiButton: { flex: 1, marginRight: 8, marginTop: 10 },
  item: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.surfaceBorder, borderRadius: tokens.radius.md, padding: 10, marginBottom: 8 },
  itemActive: { borderColor: theme.colors.primary },
  itemHeader: { flexDirection: 'row', alignItems: 'center' },
  itemInfo: { flex: 1, marginRight: 8 },
  itemName: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 6 },
  chip: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginRight: 10, marginBottom: 4 },
  tierChip: { fontSize: fonts.scaled(11), fontWeight: '800', marginBottom: 4 },
  itemActions: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  activeCheck: { marginRight: 6, alignItems: 'center', justifyContent: 'center' },
  selectButton: { borderRadius: tokens.radius.pill, borderWidth: 1, borderColor: theme.colors.primaryMutedAlpha(0.5), paddingHorizontal: 14, paddingVertical: 6, marginRight: 10 },
  loadButtonBusy: { opacity: 0.75 },
  loadProgressRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  loadProgressBar: { flex: 1, height: 4, borderRadius: 2, backgroundColor: theme.colors.surfaceBorder, overflow: 'hidden' },
  loadProgressFill: { height: '100%', borderRadius: 2, backgroundColor: theme.colors.primary },
  loadProgressText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(11), fontWeight: '700', marginLeft: 8, minWidth: 36, textAlign: 'right' },
  selectButtonActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryAlpha(0.18) },
  selectButtonText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700' },
  iconButton: { flexDirection: 'row', alignItems: 'center', marginRight: 14 },
  iconButtonText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },
  dangerText: { color: theme.colors.dangerSoft, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },
  empty: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 8 },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
  sourceChip: { borderRadius: tokens.radius.pill, borderWidth: 1, borderColor: theme.colors.primaryMutedAlpha(0.45), backgroundColor: theme.colors.primaryAlpha(0.12), paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, marginBottom: 8 },
  sourceChipActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryAlpha(0.22) },
  sourceChipText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), fontWeight: '700' },
  sourceChipTextActive: { color: theme.colors.primary },
  label: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginTop: 10, marginBottom: 5 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, marginBottom: 5 },
  labelInline: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700' },
  searchModelButton: { flexDirection: 'row', alignItems: 'center' },
  searchModelText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },
  summaryCard: { backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.surfaceBorder, borderRadius: tokens.radius.md, padding: 12, marginTop: 10 },
  summaryName: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 8 },
  summaryChip: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginRight: 12, marginBottom: 4 },
  summaryTier: { fontSize: fonts.scaled(12), fontWeight: '800', marginBottom: 4 },
  summaryHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 8 },
  input: { minHeight: 42, borderWidth: 1, borderColor: theme.colors.surfaceBorder, borderRadius: tokens.radius.md, backgroundColor: theme.colors.surface, color: theme.colors.text, paddingHorizontal: 12, paddingVertical: 9 },
  progress: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginTop: 10 },
  loading: { marginVertical: 10 },
  primary: { backgroundColor: theme.colors.primary, borderRadius: tokens.radius.md, paddingVertical: 12, alignItems: 'center', marginTop: 16 },
  primaryText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '700' },
  secondary: { backgroundColor: theme.colors.primaryAlpha(0.12), borderWidth: 1, borderColor: theme.colors.primaryMutedAlpha(0.4), borderRadius: tokens.radius.md, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  secondaryText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(14), fontWeight: '700' },
});
