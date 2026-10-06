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
import { PARAM_LABEL_KEYS } from './localModel/panel/panelShared.js';
import ModelsSection from './localModel/panel/ModelsSection.js';
import AcquireSection from './localModel/panel/AcquireSection.js';
import ApiServerSection from './localModel/panel/ApiServerSection.js';
import ModelParamsModal from './localModel/panel/ModelParamsModal.js';
import ModelSearchModal from './localModel/ModelSearchModal.js';
import ModelLogsModal from './localModel/ModelLogsModal.js';
import { formatBytes } from './utils/format.js';


export default function LocalModelPanel({ visible, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const saveHint = t('localModel.alert.saveFailed.body');
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
    if (result.code === 'MODEL_ITEM_MISSING') Alert.alert(t('localModel.alert.paramsUnavailable.title'), t('localModel.alert.paramsUnavailable.body'));
    else if (result.code === 'MODEL_FILE_MISSING') Alert.alert(t('localModel.alert.modelNotReady.title'), t('localModel.alert.modelNotReady.fileMissing'));
    else Alert.alert(t('localModel.alert.saveFailed.title'), saveHint);
  };

  const onToggleEnabled = async () => {
    const result = await models.toggleEnabled();
    if (result.ok) return;
    if (result.code === 'NO_MODEL_SELECTED') Alert.alert(t('localModel.alert.noModelSelected.title'), t('localModel.alert.noModelSelected.body'));
    else if (result.code === 'MODEL_FILE_MISSING') Alert.alert(t('localModel.alert.modelNotReady.title'), t('localModel.alert.modelNotReady.downloadFirst'));
    else if (result.code !== 'NO_SETTINGS') Alert.alert(t('localModel.alert.saveFailed.title'), saveHint);
  };

  const onToggleMediaInput = async () => {
    const result = await models.toggleMediaInput();
    if (!result.ok && result.code !== 'NO_SETTINGS') Alert.alert(t('localModel.alert.saveFailed.title'), saveHint);
  };

  const onLoadModel = async entry => {
    const result = await models.handleLoadModel(entry);
    if (result.ok) {
      Alert.alert(t('localModel.alert.modelLoaded.title'), t('localModel.alert.modelLoaded.body'));
      return;
    }
    if (result.code === 'RESOURCE_BUSY') Alert.alert(t('localModel.alert.resourceBusy.title'), t('localModel.alert.resourceBusy.body'));
    else if (result.code === 'MODEL_ITEM_MISSING') Alert.alert(t('localModel.alert.loadFailed.title'), t('localModel.error.itemMissing'));
    else if (result.code === 'MODEL_FILE_MISSING') Alert.alert(t('localModel.alert.loadFailed.title'), t('localModel.error.fileMissing'));
    else Alert.alert(t('localModel.alert.loadFailed.title'), (result && result.message) || t('localModel.alert.loadFailed.body'));
  };

  const onCleanupOrphans = async () => {
    const result = await models.handleCleanupOrphans();
    if (!result.ok) {
      Alert.alert(t('localModel.alert.cleanupFailed.title'), (result && result.message) || t('localModel.alert.cleanupFailed.body'));
      return;
    }
    if (result.removed === 0) Alert.alert(t('localModel.alert.cleanupDone.title'), t('localModel.alert.cleanupDone.empty'));
    else Alert.alert(t('localModel.alert.cleanupDone.title'), t('localModel.alert.cleanupDone.body', { count: result.removed, size: formatBytes(result.freedBytes) || '0B' }));
  };

  const onDownload = async () => {
    const result = await acquire.handleDownload();
    if (result.ok) Alert.alert(t('localModel.alert.downloadDone.title'), t('localModel.alert.downloadDone.body', { name: result.name }));
    else if (result.code === 'INCOMPLETE_INPUT') Alert.alert(t('localModel.alert.downloadInfoIncomplete.title'), t('localModel.alert.downloadInfoIncomplete.body'));
    else if (result.code === 'CANCELLED') {
      // 用户主动取消不是失败：半成品已由 modelManager 的失败清理路径删除，不弹错误。
    } else Alert.alert(t('localModel.alert.downloadFailed.title'), (result && result.message) || t('localModel.alert.downloadFailed.body'));
  };

  const onPick = pickResult => {
    if (!pickResult.ok && pickResult.code === 'PICK_FAILED') {
      Alert.alert(t('localModel.alert.pickFileFailed.title'), (pickResult && pickResult.message) || t('localModel.alert.pickFileFailed.body'));
    }
  };

  const onImport = async () => {
    const result = await acquire.handleImport();
    if (result.ok) Alert.alert(t('localModel.alert.importDone.title'), t('localModel.alert.importDone.body', { name: result.name }));
    else if (result.code === 'NO_FILE') Alert.alert(t('localModel.alert.noFileSelected.title'), t('localModel.alert.noFileSelected.body'));
    else Alert.alert(t('localModel.alert.importFailed.title'), (result && result.message) || t('localModel.alert.importFailed.body'));
  };

  // 选中文件后静默回填（U5）：只有「跑不了」档弹一条警示，其余信息由 summaryCard 常驻。
  const onSearchSelect = selection => {
    const summary = acquire.handleSearchSelect(selection);
    if (!summary || summary.compatibility.tier !== 'incompatible') return;
    const memText = summary.memory.totalBytes > 0
      ? t('localModel.alert.preDownload.memory', { size: formatBytes(summary.memory.totalBytes) })
      : t('localModel.alert.preDownload.memoryUnknown');
    Alert.alert(
      t('localModel.alert.preDownload.title'),
      `${t('localModel.alert.preDownload.tier', { tier: summary.compatibility.label })}${memText}`
    );
  };

  const onStartApi = async () => {
    const result = await api.startApi();
    if (result.ok) {
      if (result.generatedKey) {
        Alert.alert(t('localModel.alert.apiKeyGenerated.title'), t('localModel.alert.apiKeyGenerated.body', { key: result.generatedKey }));
      }
      return;
    }
    if (result.code === 'UNAVAILABLE') Alert.alert(t('localModel.alert.apiUnavailable.title'), t('localModel.alert.apiUnavailable.body'));
    else if (result.code === 'START_FAILED') Alert.alert(t('localModel.alert.apiStartFailed.title'), (result && result.message) || t('localModel.alert.apiStartFailed.body'));
  };

  const onStopApi = async () => {
    const result = await api.stopApi();
    if (!result.ok && result.code === 'STOP_FAILED') Alert.alert(t('localModel.alert.apiStopFailed.title'), (result && result.message) || t('localModel.alert.apiStopFailed.body'));
  };

  const onCopyAddress = async () => {
    const result = await api.copyApiAddress();
    if (result.ok) {
      Alert.alert(t('localModel.alert.addressCopied.title'), t('localModel.alert.addressCopied.body', { address: api.apiAddress }));
    } else {
      Alert.alert(t('localModel.alert.copyFailed.title'), t('localModel.alert.copyFailed.body', { address: api.apiAddress }));
    }
  };

  // ---- 跨域组合：删除链（C4：判加载→停服务→卸载→（失败中止）→删文件→删登记）----
  const { apiStatus, setApiStatus } = api;
  const confirmDelete = entry => {
    Alert.alert(t('localModel.alert.deleteModel.title'), t('localModel.alert.deleteModel.body', { name: entry.name || entry.id }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
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
              Alert.alert(t('localModel.alert.unloadFailed.title'), t('localModel.alert.unloadFailed.body'));
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
              Alert.alert(t('localModel.alert.saveFailed.title'), saveHint);
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
      { text: t('localModel.params'), onPress: () => openParams(entry) },
      { text: t('common.delete'), style: 'destructive', onPress: () => confirmDelete(entry) },
    ];
    if (Platform.OS === 'ios') buttons.push({ text: t('common.cancel'), style: 'cancel' });
    Alert.alert(entry.name || entry.id, entry.imported ? t('localModel.chip.imported') : t('localModel.download.section'), buttons);
  };

  // ---- 参数弹窗 ----
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
      Alert.alert(t('localModel.alert.paramsInvalid.title'), check.errors.map(item => `${t(PARAM_LABEL_KEYS[item.field] || '') || item.field}：${item.message}`).join('\n'));
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
      Alert.alert(t('localModel.alert.saveFailed.title'), error.message || t('localModel.alert.saveFailed.retry'));
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
              <Text style={styles.title}>{t('localModel.title')}</Text>
              <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('common.close')}>
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
                  t={t}
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
                  t={t}
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
