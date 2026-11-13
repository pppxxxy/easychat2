// 模型与思考的就地切换（桌面）：聊天页「更多 → 模型 / 思考」。
//
// 只移植**在线**部分：本地模型要 llama.cpp 原生绑定，桌面没有（见扩展页说明）。
// 逻辑逐条对照手机 chat/useChatModelThinking.js：
//   · applyModelSelection —— 写回 apiConfigs 的 activeModel（saveApiConfigs 串行队列）；
//   · openThinkingPanel —— 按「当前模型」解析 supportsThinking（同一配置下每模型一套能力）；
//   · applyThinking —— 读-合并-写思考设置（enabled / level / display）。
// 界面只做选择与展示。
import { useCallback, useRef, useState } from 'react';

import {
  capabilitiesForModel,
  getActiveModel,
  getApiConfigs,
  saveApiConfigs,
} from '../../../src/storage/apiConfigs.js';
import { getThinkingSettings, saveThinkingSettings } from '../../../src/storage/settings.js';
import { THINKING_DISPLAYS, THINKING_LEVELS } from '../../../src/storage/settings.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';

export default function useDesktopModelThinking({ isSending, sendLockRef }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [apiConfigs, setApiConfigs] = useState([]);
  const [modelSourceId, setModelSourceId] = useState('');
  const [thinking, setThinking] = useState({ enabled: false, level: 'medium', display: 'fold' });
  const [thinkingSupported, setThinkingSupported] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const guardBusy = () => isSending || (sendLockRef && sendLockRef.current) || busyRef.current;

  const openModelPanel = useCallback(async () => {
    try {
      const { configs, activeId } = await getApiConfigs();
      setApiConfigs(configs);
      setModelSourceId(activeId || (configs[0] && configs[0].id) || '');
      setModelOpen(true);
    } catch (error) {
      Alert.alert(tRef.current('chat.model.readConfigFailed.title'), tRef.current('chat.model.readConfigFailed.body'));
    }
  }, []);

  const applyModelSelection = useCallback(async (sourceId, model) => {
    if (guardBusy()) return;
    const list = apiConfigs.map(item => (
      item.id === sourceId ? { ...item, activeModel: model } : item
    ));
    busyRef.current = true;
    setBusy(true);
    try {
      const saved = await saveApiConfigs(list, sourceId);
      setApiConfigs(saved.configs);
      setModelSourceId(sourceId);
      setModelOpen(false);
    } catch (error) {
      Alert.alert(tRef.current('chat.model.switchFailed.title'), tRef.current('chat.model.switchFailed.body'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [apiConfigs, isSending, sendLockRef]);

  const openThinkingPanel = useCallback(async () => {
    try {
      const [settings, { configs, activeId }] = await Promise.all([
        getThinkingSettings(),
        getApiConfigs(),
      ]);
      const current = configs.find(item => item.id === activeId) || configs[0];
      // 思考能力按**当前模型**解析（同一配置下每个模型一套能力）。
      setThinkingSupported(
        capabilitiesForModel(current, current ? getActiveModel(current) : '').supportsThinking === true
      );
      setThinking(settings);
      setThinkingOpen(true);
    } catch (error) {
      Alert.alert(tRef.current('chat.thinking.readFailed.title'), tRef.current('chat.thinking.readFailed.body'));
    }
  }, []);

  const applyThinking = useCallback(async patch => {
    try {
      const current = await getThinkingSettings();
      const saved = await saveThinkingSettings({ ...current, ...patch });
      setThinking(saved);
    } catch (error) {
      Alert.alert(tRef.current('chat.thinking.saveFailed.title'), tRef.current('chat.thinking.saveFailed.body'));
    }
  }, []);

  return {
    apiConfigs,
    modelSourceId,
    setModelSourceId,
    modelOpen,
    setModelOpen,
    openModelPanel,
    applyModelSelection,
    thinking,
    thinkingOpen,
    setThinkingOpen,
    thinkingSupported,
    openThinkingPanel,
    applyThinking,
    thinkingLevels: THINKING_LEVELS,
    thinkingDisplays: THINKING_DISPLAYS,
    busy,
  };
}