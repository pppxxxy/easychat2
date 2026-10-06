// 本地模型面板 · 壳（Phase 2 拆分后只做三件事）：
//   1) 组合三个数据域 hook（usePanelModels / useAcquireModel / useApiServer）；
//   2) 三段式分区渲染（模型/获取/服务，渲染细节在各 Section 组件）；
//   3) 把各域返回的 { ok, code, message } 统一映射成用户可见反馈（Alert）。
// 本文件保留在 no-hardcoded-chinese 豁免清单内（存量债归属《中英文切换修复
// 任务书》A4 组）；panel/ 下的新文件不背新债——hook 一律返回编码结果不弹 Alert。
// C4 删除链也留在壳里：它横跨三个域（服务/内存/文件登记），是典型的组合职责。

import React, { useEffect, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTranslation } from './i18n/I18nContext.js';
import { useTheme } from './theme/ThemeContext.js';
import { deleteLocalModelItem, getLocalModelItem, saveLocalModelItem } from './storage.js';
import { deleteLocalModel } from './localModel/modelManager.js';
import { isLocalModelLoaded, isLocalModelModuleAvailable, unloadLocalModel } from './localModel/adapter.js';
import { stopLocalApiServer } from './localModel/localApiServer.js';
import { clearActiveLocalModel } from './localModel/modelState.js';
import { LOCAL_MODEL_PARAM_FIELDS, normalizeLocalModelParams, validateLocalModelParams } from './localModel/modelParams.js';
import { usePanelModels } from './localModel/panel/usePanelModels.js';
import { useAcquireModel } from './localModel/panel/useAcquireModel.js';
import { useApiServer } from './localModel/panel/useApiServer.js';
import { createPanelStyles } from './localModel/panel/panelStyles.js';
import { PARAM_LABELS } from './localModel/panel/panelShared.js';
import ModelsSection from './localModel/panel/ModelsSection.js';
import AcquireSection from './localModel/panel/AcquireSection.js';
import ApiServerSection from './localModel/panel/ApiServerSection.js';
import ModelParamsModal from './localModel/panel/ModelParamsModal.js';
import ModelSearchModal from './localModel/ModelSearchModal.js';
import ModelLogsModal from './localModel/ModelLogsModal.js';
import { formatBytes } from './utils/format.js';

const SAVE_HINT = '请检查存储空间或权限。';

export default function LocalModelPanel({ visible, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createPanelStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [section, setSection] = useState('models');
  const [searchVisible, setSearchVisible] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  // 参数弹窗的打开/校验/保存留在壳里：反馈（Alert）集中在豁免文件。
  const [paramsTarget, setParamsTarget] = useState(null);
  const [paramsForm, setParamsForm] = useState({});
  const [paramsBusy, setParamsBusy] = useState(false);

  const models = usePanelModels({ visible });
  const { settings, refresh, updateSettings } = models;
  const acquire = useAcquireModel({ deviceMemoryBytes: models.deviceMemoryBytes, onChanged: refresh });
  const api = useApiServer({ updateSettings });

  useEffect(() => {
    if (!visible) return;
    refresh();
    api.hydrate();
    // api.hydrate 由 useApiServer 以 useCallback 稳定提供，只在打开面板时全量水合。
  }, [visible, refresh]);

  // ---- 反馈映射：各域返回 { ok, code, ... }，这里统一弹 Alert ----

  const onSelectActive = async entry => {
    const result = await models.selectActive(entry);
    if (result.ok) return;
    if (result.code === 'MODEL_ITEM_MISSING') Alert.alert('参数不可用', '模型条目读取失败。');
    else if (result.code === 'MODEL_FILE_MISSING') Alert.alert('模型未就绪', '模型文件缺失，请重新下载或删除该条。');
    else Alert.alert('保存失败', SAVE_HINT);
  };

  const onToggleEnabled = async () => {
    const result = await models.toggleEnabled();
    if (result.ok) return;
    if (result.code === 'NO_MODEL_SELECTED') Alert.alert('未选择模型', '请先在列表中选用一个本地模型。');
    else if (result.code === 'MODEL_FILE_MISSING') Alert.alert('模型未就绪', '请先下载模型文件。');
    else if (result.code !== 'NO_SETTINGS') Alert.alert('保存失败', SAVE_HINT);
  };

  const onToggleMediaInput = async () => {
    const result = await models.toggleMediaInput();
    if (!result.ok && result.code !== 'NO_SETTINGS') Alert.alert('保存失败', SAVE_HINT);
  };

  const onLoadModel = async entry => {
    const result = await models.handleLoadModel(entry);
    if (result.ok) {
      Alert.alert('已加载', '模型已加载到内存，聊天页选择「本地」来源即可使用。');
      return;
    }
    if (result.code === 'RESOURCE_BUSY') Alert.alert('资源忙', '录音、语音合成或本地推理正在进行，请稍后再加载。');
    else if (result.code === 'MODEL_ITEM_MISSING') Alert.alert('加载失败', '模型条目不存在');
    else if (result.code === 'MODEL_FILE_MISSING') Alert.alert('加载失败', '模型文件缺失，请重新下载或导入');
    else Alert.alert('加载失败', (result && result.message) || '请检查模型文件与设备内存。');
  };

  const onCleanupOrphans = async () => {
    const result = await models.handleCleanupOrphans();
    if (!result.ok) {
      Alert.alert('清理失败', (result && result.message) || '请重试。');
      return;
    }
    if (result.removed === 0) Alert.alert('清理完成', '没有发现可回收的下载残留。');
    else Alert.alert('清理完成', `已删除 ${result.removed} 个下载残留，回收约 ${formatBytes(result.freedBytes) || '0B'}。`);
  };

  const onDownload = async () => {
    const result = await acquire.handleDownload();
    if (result.ok) Alert.alert('模型下载完成', `已保存「${result.name}」，可在上方列表选用。`);
    else if (result.code === 'INCOMPLETE_INPUT') Alert.alert('信息不完整', '请填写模型 ID 与有效的 GGUF 下载地址。');
    else if (result.code === 'CANCELLED') {
      // 用户主动取消不是失败：半成品已由 modelManager 的失败清理路径删除，不弹错误。
    } else Alert.alert('模型下载失败', (result && result.message) || '请检查地址与网络。');
  };

  const onPick = pickResult => {
    if (!pickResult.ok && pickResult.code === 'PICK_FAILED') {
      Alert.alert('选择文件失败', (pickResult && pickResult.message) || '请重试。');
    }
  };

  const onImport = async () => {
    const result = await acquire.handleImport();
    if (result.ok) Alert.alert('导入完成', `已导入「${result.name}」，可在上方列表选用。`);
    else if (result.code === 'NO_FILE') Alert.alert('未选择文件', '请先选择要导入的 GGUF 文件。');
    else Alert.alert('导入失败', (result && result.message) || '请重试。');
  };

  // 选中文件后静默回填（U5）：只有「跑不了」档弹一条警示，其余信息由 summaryCard 常驻。
  const onSearchSelect = selection => {
    const summary = acquire.handleSearchSelect(selection);
    if (!summary || summary.compatibility.tier !== 'incompatible') return;
    const memText = summary.memory.totalBytes > 0
      ? `预计占用约 ${formatBytes(summary.memory.totalBytes)}（含权重 + 上下文缓存 + 运行时开销）`
      : '请优先选体积较小、量化等级较低的模型';
    Alert.alert(
      '该模型可能跑不动',
      `兼容评估：${summary.compatibility.label}\n${memText}\n\n若坚持下载并加载失败或闪退，改用更小的模型/更低的上下文即可。`
    );
  };

  const onStartApi = async () => {
    const result = await api.startApi();
    if (result.ok) {
      if (result.generatedKey) {
        Alert.alert('已生成随机密钥', `未填写 API Key，已自动生成并保存：\n${result.generatedKey}\n\n客户端请求需携带 Authorization: Bearer <此密钥>，可在上方输入框查看或修改。`);
      }
      return;
    }
    if (result.code === 'UNAVAILABLE') Alert.alert('不可用', '当前构建未包含本地 API 服务模块。');
    else if (result.code === 'START_FAILED') Alert.alert('启动失败', (result && result.message) || '请检查端口是否被占用。');
  };

  const onStopApi = async () => {
    const result = await api.stopApi();
    if (!result.ok && result.code === 'STOP_FAILED') Alert.alert('停止失败', (result && result.message) || '请重试。');
  };

  const onCopyAddress = async () => {
    const result = await api.copyApiAddress();
    if (result.ok) {
      Alert.alert('已复制', `${api.apiAddress}\n\n在同机客户端的 base_url / 接口地址中填入此地址。${
        api.apiServer.apiKey?.trim()
          ? '请求需携带 Authorization: Bearer <上方输入框里的密钥>。'
          : '启动时会自动生成随机密钥，请从上方输入框复制。'
      }`);
    } else {
      Alert.alert('复制失败', `请手动记录：${api.apiAddress}`);
    }
  };

  // ---- 跨域组合：删除链（C4：判加载→停服务→卸载→（失败中止）→删文件→删登记）----
  const { apiStatus, setApiStatus } = api;
  const confirmDelete = entry => {
    Alert.alert('删除本地模型', `确定删除「${entry.name || entry.id}」及其文件与参数？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          const item = await getLocalModelItem(entry.id).catch(() => null);
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
          if (models.loadedModelId === entry.id) models.setLoadedModelId('');
          if (item) await deleteLocalModel(item).catch(() => {});
          await deleteLocalModelItem(entry.id).catch(() => {});
          if (wasActive) {
            try {
              await updateSettings(base => clearActiveLocalModel(base));
            } catch (error) {
              Alert.alert('保存失败', SAVE_HINT);
            }
            setApiStatus({ running: false, port: 0 });
          }
          await refresh();
        },
      },
    ]);
  };

  // 长按操作单（U6）：参数/删除收进来，来源信息进副标题。
  const onEntryActions = entry => {
    const buttons = [
      { text: '参数', onPress: () => openParams(entry) },
      { text: '删除', style: 'destructive', onPress: () => confirmDelete(entry) },
    ];
    if (Platform.OS === 'ios') buttons.push({ text: '取消', style: 'cancel' });
    Alert.alert(entry.name || entry.id, entry.imported ? '来源：本地导入' : '来源：在线下载', buttons);
  };

  // ---- 参数弹窗 ----
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
        await updateSettings(base => ({
          ...base,
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
                <ModelsSection
                  styles={styles}
                  theme={theme}
                  moduleAvailable={isLocalModelModuleAvailable()}
                  settings={settings}
                  entries={models.entries}
                  deviceMemoryBytes={models.deviceMemoryBytes}
                  cleanupBusy={models.cleanupBusy}
                  onCleanupOrphans={onCleanupOrphans}
                  onToggleEnabled={onToggleEnabled}
                  onToggleMediaInput={onToggleMediaInput}
                  onSelectActive={onSelectActive}
                  onLoadModel={onLoadModel}
                  onEntryActions={onEntryActions}
                  loadBusyId={models.loadBusyId}
                  loadProgress={models.loadProgress}
                  loadedModelId={models.loadedModelId}
                  onGoAcquire={() => setSection('acquire')}
                  goAcquireLabel={t('localModel.empty.goAcquire')}
                />
              ) : null}
              {section === 'acquire' ? (
                <AcquireSection
                  styles={styles}
                  theme={theme}
                  t={t}
                  acquireTab={acquire.acquireTab}
                  onAcquireTab={acquire.setAcquireTab}
                  downloadDraft={acquire.downloadDraft}
                  onDownloadDraftChange={acquire.setDownloadDraft}
                  importDraft={acquire.importDraft}
                  task={acquire.task}
                  draftSummary={acquire.draftSummary}
                  onRewriteSource={acquire.rewriteSource}
                  onOpenSearch={() => setSearchVisible(true)}
                  onDownload={onDownload}
                  onCancelDownload={acquire.handleCancelDownload}
                  onPickGguf={() => onPick(acquire.pickGguf())}
                  onPickMmproj={() => onPick(acquire.pickMmproj())}
                  onImport={onImport}
                />
              ) : null}
              {section === 'serve' ? (
                <ApiServerSection
                  styles={styles}
                  theme={theme}
                  apiServer={api.apiServer}
                  onApiServerChange={api.setApiServer}
                  apiStatus={api.apiStatus}
                  apiBusy={api.apiBusy}
                  apiAddress={api.apiAddress}
                  onStart={onStartApi}
                  onStop={onStopApi}
                  onCopyAddress={onCopyAddress}
                  onOpenLogs={() => setLogsOpen(true)}
                />
              ) : null}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ModelParamsModal
        visible={Boolean(paramsTarget)}
        target={paramsTarget}
        form={paramsForm}
        busy={paramsBusy}
        styles={styles}
        theme={theme}
        onFieldChange={(field, text) => setParamsForm(current => ({ ...current, [field]: text }))}
        onClose={() => setParamsTarget(null)}
        onSave={saveParams}
      />

      <ModelSearchModal
        visible={searchVisible}
        onClose={() => setSearchVisible(false)}
        initialSourceId={acquire.downloadDraft.sourceId || 'huggingface'}
        onSelect={onSearchSelect}
        totalMemoryBytes={models.deviceMemoryBytes}
      />

      <ModelLogsModal visible={logsOpen} onClose={() => setLogsOpen(false)} />
    </>
  );
}
