// 向量记忆配置域：状态、加载、防抖落盘与增删改。
//
// 从 src/SettingsScreen.js 抽出（该域与其它设置域零交叉，可独立搬运）。
// 对外暴露与原来同名的状态与操作，使设置页 JSX 无需改动。
// 含防抖保存队列：编辑即时改内存，500ms 防抖落盘；切换/删除等立即落盘。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { createVectorConfig, getVectorMemorySettings, saveVectorMemorySettings } from '../storage.js';
import { testVectorConnection } from '../vectorMemory/index.js';

export default function useVectorSettings() {
  const [vectorPayload, setVectorPayload] = useState({ enabled: false, configs: [], activeId: '' });
  const [vectorTesting, setVectorTesting] = useState(false);
  const [vectorTopKDraft, setVectorTopKDraft] = useState('5');
  const [vectorMaxCharsDraft, setVectorMaxCharsDraft] = useState('400');
  const vectorRef = useRef(null);
  const vectorSaveTimerRef = useRef(null);
  const vectorSaveQueueRef = useRef(Promise.resolve());
  const vectorRevisionRef = useRef(0);
  const lastSavedVectorRef = useRef(null);
  const vectorMountedRef = useRef(true);

  // 卸载时把内存里的最新配置补一次落盘，避免防抖窗口内退出丢改动。
  useEffect(() => {
    vectorMountedRef.current = true;
    return () => {
      vectorMountedRef.current = false;
      if (vectorSaveTimerRef.current) {
        clearTimeout(vectorSaveTimerRef.current);
        vectorSaveTimerRef.current = null;
      }
      const snapshot = vectorRef.current;
      if (snapshot) {
        const task = vectorSaveQueueRef.current.then(() => saveVectorMemorySettings(snapshot));
        vectorSaveQueueRef.current = task.catch(() => {});
      }
    };
  }, []);

  const flushVectorMemory = useCallback(async () => {
    if (vectorSaveTimerRef.current) {
      clearTimeout(vectorSaveTimerRef.current);
      vectorSaveTimerRef.current = null;
    }
    const snapshot = vectorRef.current;
    if (!snapshot) return true;
    const revision = vectorRevisionRef.current;
    const task = vectorSaveQueueRef.current.then(() => saveVectorMemorySettings(snapshot));
    vectorSaveQueueRef.current = task.catch(() => {});
    try {
      const saved = await task;
      lastSavedVectorRef.current = saved;
      if (vectorMountedRef.current && revision === vectorRevisionRef.current) {
        vectorRef.current = saved;
        setVectorPayload(saved);
      }
      return true;
    } catch (error) {
      if (vectorMountedRef.current && revision === vectorRevisionRef.current) {
        const previous = lastSavedVectorRef.current;
        if (previous) {
          vectorRef.current = previous;
          setVectorPayload(previous);
        }
        Alert.alert('保存失败', '配置未保存，已恢复到上次成功状态。');
      }
      return false;
    }
  }, []);

  // 加载：把已存配置灌入内存与草稿。挂载时调用一次。
  const loadVectorSettings = useCallback(() => {
    return getVectorMemorySettings()
      .then(payload => {
        lastSavedVectorRef.current = payload;
        const next = vectorRevisionRef.current > 0 && vectorRef.current
          ? vectorRef.current
          : payload;
        vectorRef.current = next;
        setVectorPayload(next);
        const active = next.configs.find(item => item.id === next.activeId) || next.configs[0];
        if (active) {
          setVectorTopKDraft(String(active.topK));
          setVectorMaxCharsDraft(String(active.maxChars));
        }
      })
      .catch(() => {});
  }, []);

  // 把补丁应用到「当前激活的向量配置」，其余配置保持不变。
  const updateVectorConfig = useCallback(patch => {
    const base = vectorRef.current || vectorPayload;
    const configs = base.configs.map(item => (
      item.id === base.activeId ? { ...item, ...patch } : item
    ));
    const next = { ...base, configs };
    vectorRef.current = next;
    vectorRevisionRef.current += 1;
    setVectorPayload(next);
    if (vectorSaveTimerRef.current) clearTimeout(vectorSaveTimerRef.current);
    vectorSaveTimerRef.current = setTimeout(() => {
      flushVectorMemory();
    }, 500);
  }, [flushVectorMemory, vectorPayload]);

  const currentVectorConfig = useMemo(() => {
    const list = vectorPayload.configs || [];
    return list.find(item => item.id === vectorPayload.activeId) || list[0] || null;
  }, [vectorPayload]);

  // 直接落盘一个完整的向量载荷（新增/删除/切换激活项时用，立即保存）。
  const persistVectorPayload = useCallback(async next => {
    vectorRef.current = next;
    vectorRevisionRef.current += 1;
    setVectorPayload(next);
    try {
      const saved = await saveVectorMemorySettings(next);
      lastSavedVectorRef.current = saved;
      vectorRef.current = saved;
      if (vectorMountedRef.current) setVectorPayload(saved);
      return true;
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
      return false;
    }
  }, []);

  const addVectorConfig = useCallback(() => {
    const base = vectorRef.current || vectorPayload;
    const created = createVectorConfig({ name: `向量配置 ${base.configs.length + 1}` });
    return persistVectorPayload({ ...base, configs: [...base.configs, created], activeId: created.id });
  }, [persistVectorPayload, vectorPayload]);

  const selectVectorConfig = useCallback(id => {
    const base = vectorRef.current || vectorPayload;
    if (!base.configs.some(item => item.id === id)) return;
    return persistVectorPayload({ ...base, activeId: id });
  }, [persistVectorPayload, vectorPayload]);

  const removeVectorConfig = useCallback(() => {
    const base = vectorRef.current || vectorPayload;
    if (base.configs.length <= 1) {
      Alert.alert('无法删除', '至少保留一个向量配置。');
      return;
    }
    Alert.alert('删除向量配置', '确定删除当前向量配置吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          const latest = vectorRef.current || vectorPayload;
          const configs = latest.configs.filter(item => item.id !== latest.activeId);
          return persistVectorPayload({ ...latest, configs, activeId: configs[0].id });
        },
      },
    ]);
  }, [persistVectorPayload, vectorPayload]);

  const testVector = useCallback(async () => {
    if (vectorTesting) return;
    setVectorTesting(true);
    try {
      await flushVectorMemory();
      const base = vectorRef.current || vectorPayload;
      const active = base.configs.find(item => item.id === base.activeId) || base.configs[0];
      const dims = await testVectorConnection(active);
      Alert.alert('连接成功', `向量维度：${dims}`);
    } catch (error) {
      Alert.alert('连接失败', error?.message || '请检查地址、密钥与模型。');
    } finally {
      setVectorTesting(false);
    }
  }, [flushVectorMemory, vectorPayload, vectorTesting]);

  const toggleVectorEnabled = useCallback(value => {
    return persistVectorPayload({ ...(vectorRef.current || vectorPayload), enabled: value });
  }, [persistVectorPayload, vectorPayload]);

  return {
    vectorPayload,
    vectorRef,
    vectorTesting,
    vectorTopKDraft,
    setVectorTopKDraft,
    vectorMaxCharsDraft,
    setVectorMaxCharsDraft,
    currentVectorConfig,
    loadVectorSettings,
    flushVectorMemory,
    updateVectorConfig,
    persistVectorPayload,
    toggleVectorEnabled,
    addVectorConfig,
    selectVectorConfig,
    removeVectorConfig,
    testVector,
  };
}
