// 模型来源与思考（reasoning）设置面板。2026-09-27 从 ChatScreen 抽出（无行为变化）。
//
// 依赖注入两个发送守卫锚点（isSending / sendLockRef），用于「发送中禁止切换模型」，
// 这是唯一的跨功能耦合；不触碰会话竞态守卫。

import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import {
  getApiConfigs,
  getThinkingSettings,
  saveApiConfigs,
  saveThinkingSettings,
} from '../storage';

export default function useChatModelThinking({ isSending, sendLockRef }) {
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [apiConfigs, setApiConfigs] = useState([]);
  const [modelSourceId, setModelSourceId] = useState('');
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState('medium');
  const [thinkingSupported, setThinkingSupported] = useState(false);
  const [thinkingDisplay, setThinkingDisplay] = useState('fold');

  const openModelPanel = useCallback(async () => {
    if (isSending || sendLockRef.current) return;
    try {
      const { configs: list, activeId: id } = await getApiConfigs();
      setApiConfigs(list);
      setModelSourceId(id);
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
  };
}
