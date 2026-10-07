// 聊天层本地引擎状态 hook（v5 Stage C，D5）：把「设置里的启用状态 + 活动模型名」
// 与 runtime.js 的运行态合成聊天状态条所需的输入。设置侧在挂载时读一次，并在
// runtime 每次迁移时重读（加载完成后模型名/启用态可能变化）。
//
// 纯派生在 engineStatus.js（可 Node 直测）；这里只做读取与状态桥接。

import { useEffect, useState } from 'react';

import { getActiveLocalModel, getLocalModelSettings } from '../storage/localModels.js';
import { getRuntimeState, subscribeRuntime } from './runtime.js';

export function useLocalEngineStatus() {
  const [settings, setSettings] = useState({ enabled: false, activeModelId: '' });
  const [activeName, setActiveName] = useState('');
  const [runtime, setRuntime] = useState(() => getRuntimeState());

  const reload = () => {
    getLocalModelSettings()
      .then(current => {
        const enabled = Boolean(current && current.enabled);
        const activeModelId = String((current && current.activeModelId) || '');
        setSettings({ enabled, activeModelId });
        if (!enabled || !activeModelId) {
          setActiveName('');
          return null;
        }
        return getActiveLocalModel()
          .then(item => setActiveName(String((item && item.name) || activeModelId)))
          .catch(() => setActiveName(activeModelId));
      })
      .catch(() => {});
  };

  useEffect(() => {
    reload();
    const unsubscribe = subscribeRuntime(state => {
      setRuntime(state);
      // 运行态迁移往往伴随启用/活动模型变化（加载、卸载、回退），重读设置。
      reload();
    });
    return unsubscribe;
  }, []);

  return {
    enabled: settings.enabled,
    activeModelId: settings.activeModelId,
    activeModelName: activeName,
    runtime,
    fallbackAt: Number(runtime && runtime.fallbackAt) || 0,
  };
}
