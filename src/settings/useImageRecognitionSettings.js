// 图片识别（OCR）配置域：状态、加载、防抖落盘与字段更新。
//
// 从 src/SettingsScreen.js 抽出（该域与其它设置域零交叉）。对外暴露状态与操作，
// 设置页 JSX 只做装配。
//
// 密钥：本域**不存密钥**——只存一条既有 API 配置的 id（apiConfigId），真正的 key
// 仍在 @easychat2_api_configs 里由保险箱保护（见 storage/settings/imageRecognition.js）。
// 所以这里没有 SecretTextField，也不需要任何新的密钥字段。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import {
  getImageRecognitionSettings,
  saveImageRecognitionSettings,
} from '../storage/settings/imageRecognition.js';
import { getApiConfigs } from '../storage/apiConfigs.js';
import { useTranslation } from '../i18n/I18nContext.js';

export default function useImageRecognitionSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(null);
  const [apiConfigs, setApiConfigs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const settingsRef = useRef(null);
  const saveTimerRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve());
  const revisionRef = useRef(0);
  const lastSavedRef = useRef(null);
  const mountedRef = useRef(true);

  // 卸载时把内存里的最新配置补一次落盘，避免防抖窗口内退出丢改动。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const snapshot = settingsRef.current;
      if (snapshot) {
        const task = saveQueueRef.current.then(() => saveImageRecognitionSettings(snapshot));
        saveQueueRef.current = task.catch(() => {});
      }
    };
  }, []);

  const load = useCallback(() => Promise.all([
    getImageRecognitionSettings().catch(() => null),
    getApiConfigs().catch(() => ({ configs: [], activeId: '' })),
  ]).then(([stored, api]) => {
    if (!mountedRef.current) return;
    const next = stored || null;
    lastSavedRef.current = next;
    settingsRef.current = next;
    setSettings(next);
    setApiConfigs(Array.isArray(api && api.configs) ? api.configs : []);
    setLoaded(true);
  }), []);

  const flush = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const snapshot = settingsRef.current;
    if (!snapshot) return true;
    const revision = revisionRef.current;
    const task = saveQueueRef.current.then(() => saveImageRecognitionSettings(snapshot));
    saveQueueRef.current = task.catch(() => {});
    try {
      const saved = await task;
      lastSavedRef.current = saved;
      if (mountedRef.current && revision === revisionRef.current) {
        settingsRef.current = saved;
        setSettings(saved);
      }
      return true;
    } catch (error) {
      if (mountedRef.current && revision === revisionRef.current) {
        const previous = lastSavedRef.current;
        if (previous) {
          settingsRef.current = previous;
          setSettings(previous);
        }
        Alert.alert(
          t('settings.imageRecognition.alert.saveFailed.title'),
          t('settings.imageRecognition.alert.saveFailed.body')
        );
      }
      return false;
    }
  }, [t]);

  // 编辑即时改内存、500ms 防抖落盘（与 useVectorSettings 同款：设置页连续输入
  // 不该每敲一个字写一次盘）。
  const update = useCallback(patch => {
    const base = settingsRef.current;
    if (!base) return;
    const next = { ...base, ...patch };
    settingsRef.current = next;
    revisionRef.current += 1;
    setSettings(next);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { flush(); }, 500);
  }, [flush]);

  return {
    imageRecognition: settings,
    imageRecognitionApiConfigs: apiConfigs,
    imageRecognitionLoaded: loaded,
    loadImageRecognitionSettings: load,
    flushImageRecognitionSettings: flush,
    updateImageRecognition: update,
  };
}
