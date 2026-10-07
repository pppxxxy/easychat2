// 本地模型面板 · 壳（拆分后只做三件事）：
//   1) 组合三个数据域 hook（usePanelModels / useAcquireModel / useApiServer）；
//   2) 三段式分区渲染（模型/获取/服务，渲染细节在各 Section 组件）；
//   3) 把反馈映射与参数弹窗接上。
// 反馈映射（40+ 条 Alert 分发）与参数弹窗状态分别抽到
// panel/panelFeedback.js 与 panel/useModelParams.js——壳此前在 no-hardcoded-chinese
// 豁免清单里，i18n 全量清理后已无硬编码文案，抽出后本文件从豁免清单移除。

import React, { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTranslation } from './i18n/I18nContext.js';
import { useTheme } from './theme/ThemeContext.js';
import { TopicButton } from './ui/index.js';
import ChapterModal from './books/ChapterModal.js';
import { isLocalModelModuleAvailable } from './localModel/adapter.js';
import { usePanelModels } from './localModel/panel/usePanelModels.js';
import { useAcquireModel } from './localModel/panel/useAcquireModel.js';
import { useApiServer } from './localModel/panel/useApiServer.js';
import { createPanelFeedback, createParamsSaver } from './localModel/panel/panelFeedback.js';
import { useModelParams } from './localModel/panel/useModelParams.js';
import { createPanelStyles } from './localModel/panel/panelStyles.js';
import ModelsSection from './localModel/panel/ModelsSection.js';
import AcquireSection from './localModel/panel/AcquireSection.js';
import ApiServerSection from './localModel/panel/ApiServerSection.js';
import ModelParamsModal from './localModel/panel/ModelParamsModal.js';
import ModelSearchModal from './localModel/ModelSearchModal.js';
import ModelLogsModal from './localModel/ModelLogsModal.js';

export default function LocalModelPanel({ visible, onClose }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createPanelStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [section, setSection] = useState('models');
  const [searchVisible, setSearchVisible] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  // 面板长说明的落点是「教学」的 local-model 章（含下载/导入/加载/API 服务全流程）。
  const [topicOpen, setTopicOpen] = useState(false);

  const models = usePanelModels({ visible });
  const { settings, refresh, updateSettings } = models;
  const acquire = useAcquireModel({ deviceMemoryBytes: models.deviceMemoryBytes, onChanged: refresh });
  const api = useApiServer({ updateSettings });

  const saveParams = useMemo(() => createParamsSaver({ t, refresh }),
    [t, refresh]);
  const params = useModelParams({ t, saveParams });
  const feedback = useMemo(() => createPanelFeedback({
    t,
    models,
    acquire,
    api,
    updateSettings,
    refresh,
    onEditParams: params.openParams,
  }), [t, models, acquire, api, updateSettings, refresh, params.openParams]);

  useEffect(() => {
    if (!visible) return;
    refresh();
    api.hydrate();
    // api.hydrate 由 useApiServer 以 useCallback 稳定提供，只在打开面板时全量水合。
  }, [visible, refresh]);

  return (
    <>
      <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
        <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.sheet}>
            <View style={styles.header}>
              <Text style={styles.title}>{t('localModel.title')}</Text>
              <View style={styles.headerActions}>
                <TopicButton
                  onPress={() => setTopicOpen(true)}
                  accessibilityLabel={t('localModel.tutorial.a11y')}
                />
                <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={t('common.close')}>
                  <Ionicons name="close" size={22} color={theme.colors.textMuted} />
                </TouchableOpacity>
              </View>
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
                  onCleanupOrphans={feedback.onCleanupOrphans}
                  onToggleEnabled={feedback.onToggleEnabled}
                  onToggleMediaInput={feedback.onToggleMediaInput}
                  onSelectActive={feedback.onSelectActive}
                  onLoadModel={feedback.onLoadModel}
                  onEntryActions={feedback.onEntryActions}
                  onDeleteEntry={feedback.confirmDelete}
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
                  onDownload={feedback.onDownload}
                  onCancelDownload={acquire.handleCancelDownload}
                  onPickGguf={() => feedback.onPick(acquire.pickGguf())}
                  onPickMmproj={() => feedback.onPick(acquire.pickMmproj())}
                  onImport={feedback.onImport}
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
                  onStart={feedback.onStartApi}
                  onStop={feedback.onStopApi}
                  onCopyAddress={feedback.onCopyAddress}
                  onOpenLogs={() => setLogsOpen(true)}
                />
              ) : null}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ModelParamsModal
        visible={Boolean(params.target)}
        target={params.target}
        form={params.form}
        busy={params.busy}
        styles={styles}
        theme={theme}
        t={t}
        onFieldChange={params.setField}
        onClose={params.close}
        onSave={params.save}
      />

      <ModelSearchModal
        visible={searchVisible}
        onClose={() => setSearchVisible(false)}
        initialSourceId={acquire.downloadDraft.sourceId || 'huggingface'}
        onSelect={feedback.onSearchSelect}
        totalMemoryBytes={models.deviceMemoryBytes}
      />

      <ModelLogsModal visible={logsOpen} onClose={() => setLogsOpen(false)} />

      <ChapterModal visible={topicOpen} onClose={() => setTopicOpen(false)}
        chapterIds={['local-model']} title={t('localModel.tutorial.title')} />
    </>
  );
}
