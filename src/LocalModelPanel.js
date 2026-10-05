import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';

import { useTranslation } from './i18n/I18nContext.js';

import {
  deleteLocalModelItem,
  getLocalModelIndex,
  getLocalModelItem,
  getLocalModelSettings,
  saveLocalModelItem,
  saveLocalModelSettings,
} from './storage.js';
import { cleanupOrphanLocalModelFiles, deleteLocalModel, downloadLocalModel, getLocalModelFileInfo, importLocalModel } from './localModel/modelManager.js';
import { isLocalModelLoaded, isLocalModelModuleAvailable, loadLocalModel, unloadLocalModel } from './localModel/adapter.js';
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

const PARAM_LABELS = {
  contextSize: '上下文长度（tokens）',
  gpuLayers: 'GPU 层数',
  threads: '线程数（0=自动）',
  temperature: '温度',
  topP: 'Top P',
  topK: 'Top K（0=关闭）',
  maxTokens: '最大生成长度（-1=不限）',
};

// 下载与导入是两条互斥路径：草稿分开持有，切换子 Tab 时各自保留（U2）。
// 此前共用一个 14 字段 draft，两个表单常驻、字段大量空置。
function emptyDownloadDraft() {
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
  };
}

function emptyImportDraft() {
  return {
    sourceUri: '',
    name: '',
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
  const [entries, setEntries] = useState([]);
  const [settings, setSettings] = useState(null);
  // 三段式分区（U1）：模型（状态/开关/列表）/ 获取（下载与导入两个互斥子 Tab）/ 服务。
  const [section, setSection] = useState('models');
  const [acquireTab, setAcquireTab] = useState('download');
  const [downloadDraft, setDownloadDraft] = useState(emptyDownloadDraft);
  const [importDraft, setImportDraft] = useState(emptyImportDraft);
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
  // 端口在编辑态统一存 string（TextInput 的值），落盘时才 parseInt——
  // 此前初始 number、编辑后 string 的类型漂移全靠渲染处 String() 兜底（C6）。
  const [apiServer, setApiServer] = useState({ enabled: false, host: '127.0.0.1', port: '8080', apiKey: '' });
  const [apiStatus, setApiStatus] = useState({ running: false, port: 0 });
  const [apiBusy, setApiBusy] = useState(false);
  // 显式加载：面板里的加载按钮状态（加载中的条目 id、进度百分比、已加载条目 id）。
  const [loadBusyId, setLoadBusyId] = useState('');
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadedModelId, setLoadedModelId] = useState('');

  const refresh = useCallback(async (options = {}) => {
    const [list, current] = await Promise.all([
      getLocalModelIndex().catch(() => []),
      getLocalModelSettings().catch(() => null),
    ]);
    setEntries(list);
    setSettings(current);
    // hydrateApi 只在打开面板的全量水合时使用：操作后刷新（删除/存参数）绝不能
    // 回填 apiServer 编辑态，否则用户正在输入的端口/密钥会被存储旧值打回（C7）。
    if (options.hydrateApi === true) {
      if (current && current.apiServer) {
        setApiServer({ ...current.apiServer, port: String(current.apiServer.port || '') });
      }
      const status = await getLocalApiServerStatus().catch(() => ({ running: false, port: 0 }));
      setApiStatus({ running: Boolean(status && status.running), port: Number(status && status.port) || 0 });
    }
  }, []);

  useEffect(() => {
    setDeviceMemoryBytes(getDeviceMemoryInfo().totalMemoryBytes);
  }, []);

  useEffect(() => {
    if (!visible) return;
    refresh({ hydrateApi: true });
  }, [visible, refresh]);

  const draftSummary = useMemo(() => buildModelSummary(
    { name: `${downloadDraft.name} ${downloadDraft.modelId}`, quant: downloadDraft.quant, paramSize: downloadDraft.paramSize },
    { totalMemoryBytes: deviceMemoryBytes, contextSize: 2048 }
  ), [downloadDraft, deviceMemoryBytes]);

  const selectActive = async entry => {
    const item = await getLocalModelItem(entry.id).catch(() => null);
    if (!item) return;
    const info = await getLocalModelFileInfo(item).catch(() => ({ exists: false }));
    if (!info || info.exists === false) {
      Alert.alert('模型未就绪', '模型文件缺失，请重新下载或删除该条。');
      return;
    }
    try {
      const next = await saveLocalModelSettings(applyActiveLocalModel(settings, item));
      setSettings(next);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  };

  const toggleEnabled = async () => {
    if (!settings) return;
    if (!settings.activeModelId) {
      Alert.alert('未选择模型', '请先在列表中选用一个本地模型。');
      return;
    }
    if (!settings.enabled) {
      const item = await getLocalModelItem(settings.activeModelId).catch(() => null);
      const info = item ? await getLocalModelFileInfo(item).catch(() => ({ exists: false })) : { exists: false };
      if (!info.exists) {
        Alert.alert('模型未就绪', '请先下载模型文件。');
        return;
      }
    }
    try {
      const next = await saveLocalModelSettings({ ...settings, enabled: !settings.enabled });
      setSettings(next);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  };

  const toggleMediaInput = async () => {
    if (!settings) return;
    try {
      const next = await saveLocalModelSettings({ ...settings, enableMediaInput: !settings.enableMediaInput });
      setSettings(next);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  };

  const persistApiServer = async patch => {
    // 编辑态端口是 string：落盘统一转 number（非法值回退 8080，与存储层
    // normalizeLocalModelApiServer 的口径一致），读回后再转 string 回填编辑态。
    const parsedPort = Math.trunc(Number(apiServer.port));
    const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8080;
    const next = await saveLocalModelSettings({
      ...(settings || {}),
      apiServer: { ...apiServer, ...patch, port },
    });
    setSettings(next);
    setApiServer({ ...next.apiServer, port: String(next.apiServer.port) });
    return next;
  };

  const startApi = async () => {
    if (apiBusy) return;
    if (!isLocalApiServerAvailable()) {
      Alert.alert('不可用', '当前构建未包含本地 API 服务模块。');
      return;
    }
    setApiBusy(true);
    try {
      // 留空即自动生成随机密钥（两端都强制鉴权）；生成后持久化，重启不变。
      const keyWasEmpty = !String(apiServer.apiKey || '').trim();
      const saved = await persistApiServer({ enabled: true });
      const status = await startLocalApiServer({
        port: Number((saved.apiServer && saved.apiServer.port) || apiServer.port) || 8080,
        apiKey: apiServer.apiKey,
        modelId: saved.activeModelId || 'local-model',
      });
      const effectiveKey = String((status && status.apiKey) || apiServer.apiKey || '');
      if (keyWasEmpty && effectiveKey) {
        // 把生成的密钥写回设置（幂等带上 enabled，避免与旧闭包状态合并后丢失开关），
        // persistApiServer 内部会同步 setApiServer；客户端照此携带 Bearer。
        await persistApiServer({ enabled: true, apiKey: effectiveKey });
      }
      setApiStatus({ running: true, port: Number(status && status.port) || Number(apiServer.port) || 8080 });
      if (keyWasEmpty) {
        Alert.alert(
          '已生成随机密钥',
          `未填写 API Key，已自动生成并保存：\n${effectiveKey}\n\n客户端请求需携带 Authorization: Bearer <此密钥>，可在上方输入框查看或修改。`
        );
      }
    } catch (error) {
      Alert.alert('启动失败', error.message || '请检查端口是否被占用。');
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
      Alert.alert('停止失败', error.message || '请重试。');
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
        '已复制',
        `${apiAddress}\n\n在同机客户端的 base_url / 接口地址中填入此地址。${
          apiServer.apiKey?.trim()
            ? '请求需携带 Authorization: Bearer <上方输入框里的密钥>。'
            : '启动时会自动生成随机密钥，请从上方输入框复制。'
        }`
      );
    } catch (error) {
      Alert.alert('复制失败', `请手动记录：${apiAddress}`);
    }
  }, [apiAddress, apiServer.apiKey]);

  const openParams = async entry => {
    const item = await getLocalModelItem(entry.id).catch(() => null);
    if (!item) {
      Alert.alert('参数不可用', '模型条目读取失败。');
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
      Alert.alert('参数有误', check.errors.map(item => `${PARAM_LABELS[item.field] || item.field}：${item.message}`).join('\n'));
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
      Alert.alert('保存失败', error.message || '请重试。');
    } finally {
      setParamsBusy(false);
    }
  };

  const confirmDelete = entry => {
    Alert.alert('删除本地模型', `确定删除「${entry.name || entry.id}」及其文件与参数？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          const item = await getLocalModelItem(entry.id).catch(() => null);
          // 顺序必须按依赖反向拆（C4，2026-10-06 审核发现）：停服务 → 卸载内存 →
          // 删文件与登记 → 清设置。此前的实现直接删文件却从不卸载：文件没了，
          // 数 GB 的 llama 上下文还驻留内存，且再也无法通过「重载再释放」找回。
          const wasActive = Boolean(settings && settings.activeModelId === entry.id);
          const wasLoaded = item ? isLocalModelLoaded(item) : false;
          // API 服务复用当前加载的上下文：被删模型已加载时，无论它是不是「当前选用」，
          // 都得先停服务再卸载，否则服务端口背后指向一个即将删除的文件。
          if ((wasActive || wasLoaded) && apiStatus.running) await stopLocalApiServer().catch(() => {});
          if (wasLoaded) {
            const released = await unloadLocalModel().catch(() => false);
            if (released === false) {
              Alert.alert('卸载失败', '模型内存释放未完全成功，已中止删除。请重启应用后重试。');
              return;
            }
          }
          if (loadedModelId === entry.id) setLoadedModelId('');
          if (item) await deleteLocalModel(item).catch(() => {});
          await deleteLocalModelItem(entry.id).catch(() => {});
          if (wasActive) {
            try {
              const next = await saveLocalModelSettings(clearActiveLocalModel(settings));
              setSettings(next);
            } catch (error) {
              Alert.alert('保存失败', '请检查存储空间或权限。');
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
        Alert.alert('清理完成', '没有发现可回收的下载残留。');
      } else {
        Alert.alert('清理完成', `已删除 ${removed} 个下载残留，回收约 ${formatBytes(freedBytes) || '0B'}。`);
      }
    } catch (error) {
      Alert.alert('清理失败', error.message || '请重试。');
    } finally {
      setCleanupBusy(false);
    }
  };

  const handleDownload = async () => {
    if (busy) return;
    const url = downloadDraft.modelUrl.trim();
    if (!downloadDraft.modelId.trim() || !/^https?:\/\//i.test(url)) {
      Alert.alert('信息不完整', '请填写模型 ID 与有效的 GGUF 下载地址。');
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const item = await downloadLocalModel({
        modelId: downloadDraft.modelId,
        modelName: downloadDraft.name || downloadDraft.modelId,
        modelUrl: url,
        sourceId: downloadDraft.sourceId,
        repoPath: downloadDraft.repoPath,
        quant: downloadDraft.quant,
        paramSize: downloadDraft.paramSize,
        modelExpectedBytes: downloadDraft.modelExpectedBytes,
        modelSha256: downloadDraft.modelSha256,
        mmprojUrl: downloadDraft.mmprojUrl,
        onProgress: setProgress,
      });
      Alert.alert('模型下载完成', `已保存「${item.name || item.id}」，可在上方列表选用。`);
      setDownloadDraft(emptyDownloadDraft());
      await refresh();
    } catch (error) {
      Alert.alert('模型下载失败', error.message || '请检查地址与网络。');
    } finally {
      setBusy(false);
    }
  };

  const pickGguf = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
      const asset = getPickedAsset(result);
      if (!asset || !asset.uri) return;
      setImportDraft(current => ({ ...current, sourceUri: asset.uri, name: asset.name || '' }));
    } catch (error) {
      Alert.alert('选择文件失败', error.message || '请重试。');
    }
  };

  const pickMmproj = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
      const asset = getPickedAsset(result);
      if (!asset || !asset.uri) return;
      setImportDraft(current => ({ ...current, mmprojSourceUri: asset.uri, mmprojSourceName: asset.name || '' }));
    } catch (error) {
      Alert.alert('选择文件失败', error.message || '请重试。');
    }
  };

  const handleImport = async () => {
    if (importBusy) return;
    if (!importDraft.sourceUri) {
      Alert.alert('未选择文件', '请先选择要导入的 GGUF 文件。');
      return;
    }
    setImportBusy(true);
    try {
      const item = await importLocalModel({
        sourceUri: importDraft.sourceUri,
        name: importDraft.name,
        mmprojSourceUri: importDraft.mmprojSourceUri,
      });
      Alert.alert('导入完成', `已导入「${item.name || item.id}」，可在上方列表选用。`);
      setImportDraft(emptyImportDraft());
      await refresh();
    } catch (error) {
      Alert.alert('导入失败', error.message || '请重试。');
    } finally {
      setImportBusy(false);
    }
  };

  const handleSearchSelect = selection => {
    if (!selection) return;
    const mmprojUrls = Array.isArray(selection.mmprojUrls) ? selection.mmprojUrls : [];
    setDownloadDraft(current => ({
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
      ? `预计占用约 ${formatBytes(summary.memory.totalBytes)}（含权重 + 上下文缓存 + 运行时开销）`
      : '（未能读取设备内存，请优先选体积较小、量化等级较低的模型）';
    const tierText = summary.compatibility.label ? `兼容评估：${summary.compatibility.label}\n` : '';
    Alert.alert(
      '下载前请确认',
      `${tierText}${memText}\n\n`
      + '注意：上下文长度（context size）越长，KV 缓存占用越大，总内存会明显增加。'
      + '请优先选择标「推荐」的量化，并在选用后把上下文设为能跑稳的档位；'
      + '若加载失败或闪退，多半是内存超出上限，改用更小的模型/更低的上下文即可。'
    );
  };

  const rewriteSource = source => {
    setDownloadDraft(current => {
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
      Alert.alert('资源忙', '录音、语音合成或本地推理正在进行，请稍后再加载。');
      return;
    }
    setLoadBusyId(entry.id);
    setLoadProgress(0);
    try {
      const item = await getLocalModelItem(entry.id).catch(() => null);
      if (!item) throw new Error('模型条目不存在');
      const info = await getLocalModelFileInfo(item).catch(() => ({ exists: false }));
      if (!info || info.exists === false) throw new Error('模型文件缺失，请重新下载或导入');
      await loadLocalModel(item, {
        onProgress: p => setLoadProgress(Math.max(0, Math.min(100, Math.round(Number(p) || 0)))),
      });
      setLoadedModelId(entry.id);
      setLoadProgress(100);
      Alert.alert('已加载', '模型已加载到内存，聊天页选择「本地」来源即可使用。');
    } catch (error) {
      Alert.alert('加载失败', error.message || '请检查模型文件与设备内存。');
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
          accessibilityLabel={`展开 ${entry.name || entry.id}`}
        >
          <View style={styles.itemInfo}>
            <Text style={styles.itemName} numberOfLines={1}>{entry.name || entry.id}{active ? ' · 当前' : ''}</Text>
            <View style={styles.chipRow}>
              {summary.quantLabel ? <Text style={styles.chip}>量化 {summary.quantLabel}</Text> : null}
              {summary.paramLabel ? <Text style={styles.chip}>规模 {summary.paramLabel}</Text> : null}
              {entry.modelBytes > 0 ? <Text style={styles.chip}>{formatBytes(entry.modelBytes)}</Text> : null}
              {entry.hasVision ? <Text style={styles.chip}>识图</Text> : null}
              {entry.hasAudio ? <Text style={styles.chip}>听声</Text> : null}
              {entry.imported ? <Text style={styles.chip}>本地导入</Text> : null}
              <Text style={[styles.tierChip, { color: tierColor(theme, summary.compatibility.tier) }]}>{summary.compatibility.label}</Text>
            </View>
          </View>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textMuted} />
        </TouchableOpacity>
        {expanded ? (
          <>
            <View style={styles.itemActions}>
              {active ? (
                <View style={styles.activeCheck} accessibilityLabel="当前选用的模型">
                  <Ionicons name="checkmark-circle" size={18} color={theme.colors.primary} />
                </View>
              ) : null}
              <TouchableOpacity
                style={[styles.selectButton, active && styles.selectButtonActive]}
                onPress={() => selectActive(entry)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={active ? '当前活动模型' : `选用 ${entry.name || entry.id}`}
              >
                <Text style={styles.selectButtonText}>{active ? '已选用' : '选用'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.iconButton, loadBusyId === entry.id && styles.loadButtonBusy]}
                onPress={() => handleLoadModel(entry)}
                disabled={Boolean(loadBusyId)}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={
                  loadedModelId === entry.id ? '模型已加载' : `加载 ${entry.name || entry.id}`
                }
              >
                <Ionicons name="hardware-chip-outline" size={16} color={theme.colors.primarySoft} />
                <Text style={styles.iconButtonText}>
                  {loadBusyId === entry.id ? `加载中 ${loadProgress}%` : loadedModelId === entry.id ? '已加载' : '加载'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.iconButton} onPress={() => openParams(entry)} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="参数">
                <Ionicons name="options-outline" size={16} color={theme.colors.primarySoft} />
                <Text style={styles.iconButtonText}>参数</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.iconButton} onPress={() => confirmDelete(entry)} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="删除">
                <Ionicons name="trash-outline" size={16} color={theme.colors.dangerSoft} />
                <Text style={styles.dangerText}>删除</Text>
              </TouchableOpacity>
            </View>
            {loadBusyId === entry.id ? (
              <View style={styles.loadProgressRow} accessibilityLabel={`加载进度 ${loadProgress}%`}>
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
              <Text style={styles.title}>本地模型</Text>
              <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel="关闭">
                <Ionicons name="close" size={22} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>
            <View style={styles.tabRow}>
              {[
                { id: 'models', label: t('localModel.tabs.models') },
                { id: 'acquire', label: t('localModel.tabs.acquire') },
                { id: 'serve', label: t('localModel.tabs.serve') },
              ].map(tab => (
                <TouchableOpacity
                  key={tab.id}
                  style={[styles.tabItem, section === tab.id && styles.tabItemActive]}
                  onPress={() => setSection(tab.id)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityState={{ selected: section === tab.id }}
                  accessibilityLabel={tab.label}
                >
                  <Text style={[styles.tabText, section === tab.id && styles.tabTextActive]}>{tab.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              {section === 'models' ? (
                <>
                  <Text style={styles.hint}>本地模型需要包含 llama.rn 的原生构建。未完成原生构建或模型未就绪时，聊天继续使用在线 API。</Text>
                  <Text style={styles.status}>{isLocalModelModuleAvailable() ? '当前构建已包含本地模型模块' : '当前构建未包含本地模型模块'}</Text>

                  <View style={styles.activeRow}>
                    <Text style={styles.activeText}>
                      {settings && settings.activeModelId
                        ? `当前模型：${settings.modelName || settings.activeModelId}`
                        : '当前未选用本地模型'}
                    </Text>
                    <Switch
                      value={Boolean(settings && settings.enabled)}
                      onValueChange={() => toggleEnabled()}
                      disabled={!settings}
                      trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                      thumbColor={theme.colors.primaryContrast}
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
                    <Switch
                      value={Boolean(settings && settings.enableMediaInput)}
                      onValueChange={() => toggleMediaInput()}
                      disabled={!settings}
                      trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                      thumbColor={theme.colors.primaryContrast}
                      accessibilityLabel="允许图片/音频输入"
                    />
                  </View>

                  <View style={styles.labelRow}>
                    <Text style={styles.labelInline}>已安装模型（{entries.length}）</Text>
                    <TouchableOpacity
                      style={styles.searchModelButton}
                      onPress={handleCleanupOrphans}
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
                        onPress={() => setSection('acquire')}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        accessibilityLabel={t('localModel.empty.goAcquire')}
                      >
                        <Text style={styles.secondaryText}>{t('localModel.empty.goAcquire')}</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    entries.map(renderEntry)
                  )}
                </>
              ) : null}

              {section === 'acquire' ? (
                <>
                  <View style={styles.subTabRow}>
                    {[
                      { id: 'download', label: t('localModel.acquire.download') },
                      { id: 'import', label: t('localModel.acquire.import') },
                    ].map(tab => (
                      <TouchableOpacity
                        key={tab.id}
                        style={[styles.tabItem, acquireTab === tab.id && styles.tabItemActive]}
                        onPress={() => setAcquireTab(tab.id)}
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
                          onPress={() => setSearchVisible(true)}
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
                        onChangeText={text => setDownloadDraft(current => ({ ...current, modelId: text }))}
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
                            onPress={() => rewriteSource(source)}
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
                        onChangeText={text => setDownloadDraft(current => ({ ...current, modelUrl: text }))}
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
                              onPress={() => setDownloadDraft(current => ({ ...current, mmprojUrl: '' }))}
                              activeOpacity={0.8}
                            >
                              <Text style={[styles.sourceChipText, !downloadDraft.mmprojUrl && styles.sourceChipTextActive]}>不下载</Text>
                            </TouchableOpacity>
                            {downloadDraft.mmprojUrls.map((url, index) => (
                              <TouchableOpacity
                                key={url}
                                style={[styles.sourceChip, downloadDraft.mmprojUrl === url && styles.sourceChipActive]}
                                onPress={() => setDownloadDraft(current => ({ ...current, mmprojUrl: url }))}
                                activeOpacity={0.8}
                              >
                                <Text style={[styles.sourceChipText, downloadDraft.mmprojUrl === url && styles.sourceChipTextActive]}>mmproj {index + 1}</Text>
                              </TouchableOpacity>
                            ))}
                          </View>
                        </>
                      ) : null}
                      {busy ? <Text style={styles.progress}>下载进度：{Math.round(progress * 100)}%</Text> : null}
                      <TouchableOpacity style={styles.primary} onPress={handleDownload} disabled={busy} activeOpacity={0.8}>
                        <Text style={styles.primaryText}>{busy ? '下载中...' : '下载并登记模型'}</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <Text style={styles.hint}>把设备上已有的 GGUF 文件复制进应用目录并登记。</Text>
                      <TouchableOpacity style={styles.secondary} onPress={pickGguf} activeOpacity={0.8}>
                        <Text style={styles.secondaryText}>{importDraft.sourceUri ? `已选择：${importDraft.name || 'GGUF 文件'}` : '选择 GGUF 文件'}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.secondary} onPress={pickMmproj} activeOpacity={0.8}>
                        <Text style={styles.secondaryText}>{importDraft.mmprojSourceUri ? `mmproj：${importDraft.mmprojSourceName || '已选择'}` : '选择 mmproj（可选）'}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.primary} onPress={handleImport} disabled={importBusy} activeOpacity={0.8}>
                        <Text style={styles.primaryText}>{importBusy ? '导入中...' : '导入到应用'}</Text>
                      </TouchableOpacity>
                    </>
                  )}
                </>
              ) : null}

              {section === 'serve' ? (
                <>
                  <Text style={styles.hint}>固定监听 127.0.0.1，供同机客户端调用；推理复用当前加载的本地模型。请求强制携带 Bearer 密钥（留空会自动生成），同机其他应用无法匿名调用。</Text>
                  <View style={styles.apiPortRow}>
                    <Text style={styles.labelInline}>端口</Text>
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
                    placeholder="API Key（留空将自动生成随机密钥）"
                    placeholderTextColor={theme.colors.textFaint}
                    autoCapitalize="none"
                  />
                  <View style={styles.apiSwitchRow}>
                    <Text style={styles.mediaTitle}>
                      {apiStatus.running ? `运行中（端口 ${apiStatus.port}）` : '启用本地 API 服务'}
                    </Text>
                    <Switch
                      value={Boolean(apiStatus.running)}
                      onValueChange={value => (value ? startApi() : stopApi())}
                      disabled={apiBusy}
                      trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
                      thumbColor={theme.colors.primaryContrast}
                      accessibilityLabel="启用本地 API 服务"
                    />
                  </View>
                  <TouchableOpacity
                    style={styles.apiAddressRow}
                    onPress={copyApiAddress}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={`复制本地 API 地址 ${apiAddress}`}
                  >
                    <Text style={styles.apiAddress} numberOfLines={1}>{apiAddress}</Text>
                    <View style={styles.apiCopyChip}>
                      <Ionicons name="copy-outline" size={14} color={theme.colors.primarySoft} />
                      <Text style={styles.apiCopyText}>复制</Text>
                    </View>
                  </TouchableOpacity>
                  <Text style={styles.apiAddressHint}>在「模型」页选择模型并加载后开启服务，把此地址填入同机客户端的 base_url。</Text>
                  <TouchableOpacity style={styles.logsButton} onPress={() => setLogsOpen(true)} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="查看运行日志">
                    <Ionicons name="document-text-outline" size={14} color={theme.colors.primarySoft} />
                    <Text style={styles.logsButtonText}>查看运行日志</Text>
                  </TouchableOpacity>
                </>
              ) : null}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={Boolean(paramsTarget)} transparent animationType="slide" onRequestClose={() => setParamsTarget(null)}>
        <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.sheet}>
            <View style={styles.header}>
              <Text style={styles.title}>推理参数</Text>
              <TouchableOpacity onPress={() => setParamsTarget(null)} hitSlop={8} accessibilityLabel="关闭">
                <Ionicons name="close" size={22} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={styles.hint}>{paramsTarget ? `${paramsTarget.name || paramsTarget.id}：参数只作用于该模型。` : ''}</Text>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              {Object.keys(LOCAL_MODEL_PARAM_FIELDS).map(field => (
                <View key={field} style={styles.paramField}>
                  <Text style={styles.label}>{PARAM_LABELS[field] || field}</Text>
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
                <Text style={styles.primaryText}>{paramsBusy ? '保存中...' : '保存参数'}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ModelSearchModal
        visible={searchVisible}
        onClose={() => setSearchVisible(false)}
        initialSourceId={downloadDraft.sourceId || LOCAL_MODEL_DOWNLOAD_SOURCES[0].id}
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
  tabRow: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    padding: 3,
    marginBottom: 10,
  },
  subTabRow: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    padding: 3,
    marginBottom: 12,
  },
  tabItem: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: tokens.radius.sm },
  tabItemActive: { backgroundColor: theme.colors.primaryAlpha(0.2) },
  tabText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), fontWeight: '700' },
  tabTextActive: { color: theme.colors.primary },
  hint: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginBottom: 10 },
  status: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), marginBottom: 10 },
  logsButton: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginBottom: 10 },
  logsButtonText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },
  activeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.surfaceBorder, borderRadius: tokens.radius.md, paddingHorizontal: 12, paddingVertical: 10 },
  activeText: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700', marginRight: 8 },
  mediaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.surfaceBorder, borderRadius: tokens.radius.md, paddingHorizontal: 12, paddingVertical: 10, marginTop: 8 },
  mediaInfo: { flex: 1, marginRight: 8 },
  mediaTitle: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '700' },
  mediaHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), lineHeight: fonts.scaled(16), marginTop: 2 },
  apiPortRow: { flexDirection: 'row', alignItems: 'center' },
  apiPortInput: { flex: 1, marginLeft: 10 },
  apiSwitchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.surfaceBorder, borderRadius: tokens.radius.md, paddingHorizontal: 12, paddingVertical: 8, marginTop: 10 },
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
