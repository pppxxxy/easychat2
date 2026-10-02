// 模型来源与思考（reasoning）设置面板。2026-09-27 从 ChatScreen 抽出（无行为变化）。
// 2026-10-01 追加本地模型分组：切换模型弹窗内可直接加载/卸载本地模型，并打开发运行日志。
//
// 依赖注入两个发送守卫锚点（isSending / sendLockRef），用于「发送中禁止切换模型」，
// 这是唯一的跨功能耦合；不触碰会话竞态守卫。

import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import {
  getApiConfigs,
  getLocalModelIndex,
  getLocalModelItem,
  getLocalModelSettings,
  getThinkingSettings,
  saveApiConfigs,
  saveLocalModelSettings,
  saveThinkingSettings,
} from '../storage.js';
import { loadLocalModel, unloadLocalModel } from '../localModel/adapter.js';
import { stopLocalApiServer } from '../localModel/localApiServer.js';
import { recordModelLog } from '../localModel/modelLogs.js';
import { applyActiveLocalModel } from '../localModel/modelState.js';
import { getLocalModelFileInfo } from '../localModel/modelManager.js';
import { tryAcquireResource } from '../resourceMutex.js';

export default function useChatModelThinking({ isSending, sendLockRef }) {
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [apiConfigs, setApiConfigs] = useState([]);
  const [modelSourceId, setModelSourceId] = useState('');
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState('medium');
  const [thinkingSupported, setThinkingSupported] = useState(false);
  const [thinkingDisplay, setThinkingDisplay] = useState('fold');
  const [localModels, setLocalModels] = useState([]);
  const [activeLocalModelId, setActiveLocalModelId] = useState('');
  const [loadingLocalModelId, setLoadingLocalModelId] = useState('');
  const [localLogsOpen, setLocalLogsOpen] = useState(false);

  const openModelPanel = useCallback(async () => {
    if (isSending || sendLockRef.current) return;
    try {
      const [{ configs: list, activeId: id }, localIndex, localSettings] = await Promise.all([
        getApiConfigs(),
        getLocalModelIndex().catch(() => []),
        getLocalModelSettings().catch(() => null),
      ]);
      setApiConfigs(list);
      setModelSourceId(id);
      setLocalModels(Array.isArray(localIndex) ? localIndex : []);
      setActiveLocalModelId(
        localSettings && localSettings.enabled ? (localSettings.activeModelId || '') : ''
      );
      setModelPanelOpen(true);
    } catch (error) {
      Alert.alert('读取失败', '无法读取 API 配置。');
    }
  }, [isSending]);

  const applyModelSelection = useCallback(async (sourceId, model) => {
    if (isSending || sendLockRef.current) return;
    const list = apiConfigs.map(item => (
      item.id === sourceId ? { ...item, activeModel: model } : item
    ));
    try {
      const saved = await saveApiConfigs(list, sourceId);
      setApiConfigs(saved.configs);
      setModelSourceId(sourceId);
      setModelPanelOpen(false);
    } catch (error) {
      Alert.alert('切换失败', '请检查存储空间或权限。');
    }
  }, [apiConfigs, isSending]);

  // 加载本地模型：先确保文件存在，再加载常驻上下文并把该条设为活动模型。
  // 与聊天推理共用 local-model 互斥锁：换上下文不能与正在进行的推理并发。
  const activateLocalModel = useCallback(async entry => {
    if (!entry || isSending || sendLockRef.current) return;
    const release = tryAcquireResource('local-model');
    if (!release) {
      Alert.alert('资源忙', '录音、语音合成或本地推理正在进行，请稍后再切换。');
      return;
    }
    setLoadingLocalModelId(entry.id);
    try {
      const item = await getLocalModelItem(entry.id).catch(() => null);
      if (!item) throw new Error('模型条目不存在');
      const info = await getLocalModelFileInfo(item).catch(() => ({ exists: false }));
      if (!info || info.exists === false) throw new Error('模型文件缺失，请重新下载或导入');
      await loadLocalModel(item);
      const current = await getLocalModelSettings().catch(() => null);
      await saveLocalModelSettings(applyActiveLocalModel(current, item));
      setActiveLocalModelId(item.id);
      setModelPanelOpen(false);
    } catch (error) {
      recordModelLog('load', `加载失败：${error.message || error}`, { level: 'error' });
      Alert.alert('加载失败', error.message || '请检查模型文件后重试。');
    } finally {
      release();
      setLoadingLocalModelId('');
    }
  }, [isSending]);

  // 卸载当前本地模型：释放常驻上下文并关闭本地模式，回到在线 API。
  const deactivateLocalModel = useCallback(async () => {
    const release = tryAcquireResource('local-model');
    if (!release) {
      Alert.alert('资源忙', '录音、语音合成或本地推理正在进行，请稍后再卸载。');
      return;
    }
    try {
      await stopLocalApiServer().catch(() => {});
      await unloadLocalModel();
      const current = await getLocalModelSettings().catch(() => null);
      await saveLocalModelSettings({ ...current, enabled: false });
      setActiveLocalModelId('');
      setModelPanelOpen(false);
    } catch (error) {
      Alert.alert('卸载失败', error.message || '请重试。');
    } finally {
      release();
    }
  }, []);

  const openThinkingPanel = useCallback(async () => {
    try {
      const [settings, { configs, activeId }] = await Promise.all([
        getThinkingSettings(),
        getApiConfigs(),
      ]);
      const current = configs.find(item => item.id === activeId) || configs[0];
      setThinkingSupported(!!(current && current.supportsThinking));
      setThinkingEnabled(settings.enabled);
      setThinkingLevel(settings.level);
      setThinkingDisplay(settings.display);
      setThinkingOpen(true);
    } catch (error) {
      Alert.alert('读取失败', '无法读取思考设置。');
    }
  }, []);

  const applyThinking = useCallback(async patch => {
    try {
      const current = await getThinkingSettings();
      const saved = await saveThinkingSettings({ ...current, ...patch });
      setThinkingEnabled(saved.enabled);
      setThinkingLevel(saved.level);
      setThinkingDisplay(saved.display);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  }, []);

  return {
    modelPanelOpen,
    setModelPanelOpen,
    apiConfigs,
    modelSourceId,
    setModelSourceId,
    openModelPanel,
    applyModelSelection,
    thinkingOpen,
    setThinkingOpen,
    thinkingEnabled,
    thinkingLevel,
    thinkingSupported,
    thinkingDisplay,
    setThinkingDisplay,
    openThinkingPanel,
    applyThinking,
    localModels,
    activeLocalModelId,
    loadingLocalModelId,
    activateLocalModel,
    deactivateLocalModel,
    localLogsOpen,
    setLocalLogsOpen,
  };
}
