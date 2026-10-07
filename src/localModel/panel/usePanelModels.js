// 面板数据域：已装条目 / 设置 / 设备内存 + 设置更新收口（C3）与显式加载。
// 反馈约定：本 hook 不弹 Alert——结果以 { ok, code, message } 返回，由壳
// （豁免文件 LocalModelPanel.js）统一映射成用户可见文案。这样新文件不背
// no-hardcoded-chinese 的新债，文案继续由《中英文切换修复任务书》A4 组统一迁移。

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  getLocalModelIndex,
  getLocalModelItem,
  getLocalModelSettings,
  saveLocalModelSettings,
} from '../../storage/localModels.js';
import { cleanupOrphanLocalModelFiles, getLocalModelFileInfo } from '../modelManager.js';
import { loadLocalModel, unloadLocalModel } from '../adapter.js';
import { getRuntimeState, subscribeRuntime } from '../runtime.js';
import { stopLocalApiServer } from '../localApiServer.js';
import { tryAcquireResource } from '../../resourceMutex.js';
import { applyActiveLocalModel } from '../modelState.js';
import { getDeviceMemoryInfo } from '../deviceMemory.js';
import { selectFeaturedModels } from '../featured.js';

export function usePanelModels({ visible }) {
  const [entries, setEntries] = useState([]);
  const [settings, setSettings] = useState(null);
  const [deviceMemoryBytes, setDeviceMemoryBytes] = useState(0);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  // 显式加载：面板里的加载按钮状态（加载中的条目 id、进度百分比、已加载条目 id）。
  const [loadBusyId, setLoadBusyId] = useState('');
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadedModelId, setLoadedModelId] = useState('');
  // 运行态（v5 Stage C）：模型中心运行状态卡直接读 runtime 单例，与聊天层同源。
  const [runtime, setRuntime] = useState(() => getRuntimeState());

  useEffect(() => subscribeRuntime(setRuntime), []);

  const refresh = useCallback(async () => {
    const [list, current] = await Promise.all([
      getLocalModelIndex().catch(() => []),
      getLocalModelSettings().catch(() => null),
    ]);
    setEntries(list);
    setSettings(current);
    return current;
  }, []);

  useEffect(() => {
    setDeviceMemoryBytes(getDeviceMemoryInfo().totalMemoryBytes);
  }, []);

  // apiServer/apiStatus 的水合属于服务域（useApiServer.hydrate），由壳在
  // visible 打开时一并触发——这里绝不能回填服务域的编辑态（C7 的教训）。
  useEffect(() => {
    if (!visible) return;
    refresh();
  }, [visible, refresh]);

  // 设置更新唯一入口（C3）：重读最新值再合并落盘，消除四处 {...settings, xxx}
  // 手动合并的闭包过期风险（代码注释曾自证痛点「避免与旧闭包状态合并后丢失开关」）。
  // patch 传对象或 (latest) => partial 函数。
  const updateSettings = useCallback(async patch => {
    const latest = await getLocalModelSettings().catch(() => null);
    const base = latest || {};
    const next = await saveLocalModelSettings({
      ...base,
      ...(typeof patch === 'function' ? patch(base) : patch),
    });
    setSettings(next);
    return next;
  }, []);

  const selectActive = useCallback(async entry => {
    const item = await getLocalModelItem(entry.id).catch(() => null);
    if (!item) return { ok: false, code: 'MODEL_ITEM_MISSING' };
    const info = await getLocalModelFileInfo(item).catch(() => ({ exists: false }));
    if (!info || info.exists === false) return { ok: false, code: 'MODEL_FILE_MISSING' };
    try {
      await updateSettings(base => applyActiveLocalModel(base, item));
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'SAVE_FAILED' };
    }
  }, [updateSettings]);

  const toggleEnabled = useCallback(async () => {
    if (!settings) return { ok: false, code: 'NO_SETTINGS' };
    if (!settings.activeModelId) return { ok: false, code: 'NO_MODEL_SELECTED' };
    if (!settings.enabled) {
      const item = await getLocalModelItem(settings.activeModelId).catch(() => null);
      const info = item ? await getLocalModelFileInfo(item).catch(() => ({ exists: false })) : { exists: false };
      if (!info.exists) return { ok: false, code: 'MODEL_FILE_MISSING' };
    }
    try {
      // 以存储最新值为基准翻转（updateSettings 重读），内存旧快照不再参与合并。
      await updateSettings(base => ({ ...base, enabled: !base.enabled }));
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'SAVE_FAILED' };
    }
  }, [settings, updateSettings]);

  const toggleMediaInput = useCallback(async () => {
    if (!settings) return { ok: false, code: 'NO_SETTINGS' };
    try {
      await updateSettings(base => ({ ...base, enableMediaInput: !base.enableMediaInput }));
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'SAVE_FAILED' };
    }
  }, [settings, updateSettings]);

  // 面板内的显式加载：与聊天页加载共用 local-model 互斥锁；进度 0-100，
  // 完成后标记「已加载」。加载前先确认文件存在，缺失给明确指引。
  const handleLoadModel = useCallback(async entry => {
    if (!entry || loadBusyId) return { ok: false, code: 'BUSY' };
    const release = tryAcquireResource('local-model');
    if (!release) return { ok: false, code: 'RESOURCE_BUSY' };
    setLoadBusyId(entry.id);
    setLoadProgress(0);
    try {
      const item = await getLocalModelItem(entry.id).catch(() => null);
      if (!item) {
        const error = new Error('model item missing');
        error.code = 'MODEL_ITEM_MISSING';
        throw error;
      }
      const info = await getLocalModelFileInfo(item).catch(() => ({ exists: false }));
      if (!info || info.exists === false) {
        const error = new Error('model file missing');
        error.code = 'MODEL_FILE_MISSING';
        throw error;
      }
      await loadLocalModel(item, {
        onProgress: p => setLoadProgress(Math.max(0, Math.min(100, Math.round(Number(p) || 0)))),
      });
      setLoadedModelId(entry.id);
      setLoadProgress(100);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error && error.code ? error.code : 'LOAD_FAILED', message: error && error.message };
    } finally {
      release();
      setLoadBusyId('');
    }
  }, [loadBusyId]);

  // 卸载当前常驻上下文：停本地 API 服务 → 释放模型 → 关闭本地模式。
  // 与聊天侧卸载同链（C4），模型中心成为唯一卸载入口（v5 Stage C）。
  const handleUnloadModel = useCallback(async () => {
    const release = tryAcquireResource('local-model');
    if (!release) return { ok: false, code: 'RESOURCE_BUSY' };
    try {
      await stopLocalApiServer().catch(() => {});
      const released = await unloadLocalModel();
      if (released === false) return { ok: false, code: 'UNLOAD_INCOMPLETE' };
      await updateSettings(base => ({ ...base, enabled: false }));
      setLoadedModelId('');
      setLoadProgress(0);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'UNLOAD_FAILED', message: error && error.message };
    } finally {
      release();
    }
  }, [updateSettings]);

  // 扫描并清理下载/导入被杀留下的 .download/.old/.import 残留（数 GB 隐形占用）。
  const handleCleanupOrphans = useCallback(async () => {
    if (cleanupBusy) return { ok: false, code: 'BUSY' };
    setCleanupBusy(true);
    try {
      const { removed, freedBytes } = await cleanupOrphanLocalModelFiles();
      return { ok: true, removed, freedBytes };
    } catch (error) {
      return { ok: false, code: 'CLEANUP_FAILED', message: error && error.message };
    } finally {
      setCleanupBusy(false);
    }
  }, [cleanupBusy]);

  // 未安装精选卡（v5 Stage C/E）：目录里尚未安装的仓库坐标，灰态展示。
  const featuredEntries = useMemo(() => {
    const installedRepos = new Set(entries.map(item => String(item.repoPath || '')).filter(Boolean));
    return selectFeaturedModels({ totalMemoryBytes: deviceMemoryBytes })
      .filter(item => !installedRepos.has(item.repoId))
      .map(item => ({
        id: item.repoId,
        name: item.name,
        paramSize: item.paramSize,
        hasVision: false,
        hasAudio: false,
        modelBytes: 0,
        imported: false,
        sourceId: item.sourceId || '',
        repoPath: item.repoId,
      }));
  }, [entries, deviceMemoryBytes]);

  return {
    entries,
    settings,
    deviceMemoryBytes,
    cleanupBusy,
    loadBusyId,
    loadProgress,
    loadedModelId,
    runtime,
    featuredEntries,
    setLoadedModelId,
    refresh,
    updateSettings,
    selectActive,
    toggleEnabled,
    toggleMediaInput,
    handleLoadModel,
    handleUnloadModel,
    handleCleanupOrphans,
  };
}
