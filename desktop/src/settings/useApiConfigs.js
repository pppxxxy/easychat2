// 桌面 API 配置编排：多套配置的读/存/切换/增删 + 模型清单探测。
//
// 存储全部复用 src/storage/apiConfigs.js（saveApiConfigs 自带串行队列与归一化），
// 本文件只做界面状态：脏标记、切配置前的未保存确认、探测请求的竞态取消。
//
// 归一化口径（与 Android 设置页一致）：保存前校验地址协议、模型非空、http 明文提示。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createApiConfig,
  getApiConfigs,
  getActiveModel,
  saveApiConfigs,
} from '../../../src/storage/apiConfigs.js';
import { CHAT_API_VENDORS } from '../../../src/network/apiVendors.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import { detectModels } from './modelProbe.js';

const PROTOCOL_OPTIONS = [
  { id: 'openai', label: 'OpenAI', auth: { header: 'Authorization', prefix: 'Bearer ' } },
  { id: 'openai-responses', label: 'Responses', auth: { header: 'Authorization', prefix: 'Bearer ' } },
  { id: 'anthropic', label: 'Anthropic', auth: { header: 'x-api-key', prefix: '' } },
];

export { PROTOCOL_OPTIONS };
export { CHAT_API_VENDORS };

function snapshotActive(configs, activeId) {
  const active = configs.find(item => item.id === activeId);
  return active ? JSON.stringify(active) : '';
}

export default function useApiConfigs() {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [configs, setConfigs] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [modelError, setModelError] = useState('');
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const requestRef = useRef({ cancel: null });
  const baselineRef = useRef('');

  useEffect(() => {
    mountedRef.current = true;
    getApiConfigs()
      .then(({ configs: list, activeId: id }) => {
        if (!mountedRef.current) return;
        setConfigs(list);
        setActiveId(id);
        baselineRef.current = snapshotActive(list, id);
        setLoaded(true);
      })
      .catch(() => {
        if (mountedRef.current) {
          Alert.alert(tRef.current('settings.api.loadFailed.title'), tRef.current('settings.api.loadFailed.body'));
        }
      });
    return () => {
      mountedRef.current = false;
      requestRef.current.cancel?.();
    };
  }, []);

  const active = useMemo(
    () => configs.find(item => item.id === activeId) || configs[0] || null,
    [configs, activeId]
  );
  const dirty = useMemo(
    () => loaded && snapshotActive(configs, activeId) !== baselineRef.current,
    [configs, activeId, loaded]
  );

  const persist = useCallback(async (list, id) => {
    const saved = await saveApiConfigs(list, id);
    if (!mountedRef.current) return saved;
    setConfigs(saved.configs);
    setActiveId(saved.activeId);
    baselineRef.current = snapshotActive(saved.configs, saved.activeId);
    return saved;
  }, []);

  const runPersist = useCallback(async (list, id) => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    try {
      return await persist(list, id);
    } catch (error) {
      if (mountedRef.current) {
        Alert.alert(tRef.current('common.error.saveFailed'), tRef.current('common.error.storageOrPermission'));
      }
      return null;
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [persist]);

  const updateField = useCallback(patch => {
    setConfigs(current => current.map(item => (
      item.id === activeId ? { ...item, ...patch } : item
    )));
  }, [activeId]);

  const changeProtocol = useCallback(protocol => {
    const option = PROTOCOL_OPTIONS.find(item => item.id === protocol);
    if (!option) return;
    setModelError('');
    updateField({ protocol, authHeader: option.auth.header, authScheme: option.auth.prefix });
  }, [updateField]);

  // 切配置前确认未保存的修改（与 Android 同一交互：继续编辑 / 放弃并切换）。
  const confirmDiscard = useCallback(() => new Promise(resolve => {
    if (!dirty) {
      resolve(true);
      return;
    }
    Alert.alert(
      tRef.current('settings.api.dirty.title'),
      tRef.current('settings.api.dirty.body'),
      [
        { text: tRef.current('settings.api.dirty.keep'), style: 'cancel', onPress: () => resolve(false) },
        {
          text: tRef.current('settings.api.dirty.discard'),
          style: 'destructive',
          onPress: () => {
            const baseline = baselineRef.current ? JSON.parse(baselineRef.current) : null;
            setConfigs(current => (
              baseline
                ? current.map(item => (item.id === activeId ? { ...baseline } : item))
                : current
            ));
            resolve(true);
          },
        },
      ]
    );
  }), [activeId, dirty]);

  const selectConfig = useCallback(async id => {
    if (busyRef.current || id === activeId) return;
    if (!(await confirmDiscard())) return;
    await runPersist(configs, id);
  }, [activeId, configs, confirmDiscard, runPersist]);

  const addConfig = useCallback(async preset => {
    if (busyRef.current) return;
    if (!(await confirmDiscard())) return;
    const auth = (preset && preset.auth) || {};
    const created = createApiConfig({
      name: preset ? tRef.current(preset.nameKey) : tRef.current('apiPreset.numberedName', { index: configs.length + 1 }),
      baseUrl: (preset && preset.baseUrl) || '',
      vendorId: (preset && preset.id) || '',
      protocol: (preset && preset.protocol) || 'openai',
      authHeader: auth.header || 'Authorization',
      authScheme: auth.prefix === undefined ? 'Bearer ' : auth.prefix,
      apiKeyUrl: (preset && preset.apiKeyUrl) || '',
      models: [],
      activeModel: '',
    });
    await runPersist([...configs, created], created.id);
  }, [configs, confirmDiscard, runPersist]);

  const deleteConfig = useCallback(() => {
    if (busyRef.current || configs.length <= 1 || !active) {
      Alert.alert(tRef.current('settings.api.deleteBlocked.title'), tRef.current('settings.api.deleteBlocked.body'));
      return;
    }
    Alert.alert(tRef.current('settings.api.delete.title'), tRef.current('settings.api.delete.body', { name: active.name }), [
      { text: tRef.current('common.cancel'), style: 'cancel' },
      {
        text: tRef.current('common.delete'),
        style: 'destructive',
        onPress: () => {
          const next = configs.filter(item => item.id !== active.id);
          const nextActive = activeId === active.id ? next[0].id : activeId;
          runPersist(next, nextActive);
        },
      },
    ]);
  }, [active, activeId, configs, runPersist]);

  // 保存：校验（地址必填/协议/模型非空）→ 明文 http 二次确认 → 落盘。
  const save = useCallback(async () => {
    if (!active || busyRef.current) return null;
    const baseUrl = String(active.baseUrl || '').trim();
    if (!baseUrl) {
      Alert.alert(tRef.current('settings.api.noAddress.title'), tRef.current('settings.api.noAddress.body'));
      return null;
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      Alert.alert(tRef.current('settings.api.badAddress.title'), tRef.current('settings.api.badAddress.body'));
      return null;
    }
    if (!Array.isArray(active.models) || active.models.length === 0) {
      Alert.alert(tRef.current('settings.api.noModels.title'), tRef.current('settings.api.noModels.body'));
      return null;
    }
    if (/^http:\/\//i.test(baseUrl)) {
      const proceed = await new Promise(resolve => {
        Alert.alert(tRef.current('settings.api.http.title'), tRef.current('settings.api.http.body'), [
          { text: tRef.current('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
          { text: tRef.current('settings.api.http.saveAnyway'), onPress: () => resolve(true) },
        ]);
      });
      if (!proceed) return null;
    }
    const saved = await runPersist(configs, activeId);
    if (saved) {
      Alert.alert(tRef.current('settings.api.saved.title'), tRef.current('settings.api.saved.body'));
    }
    return saved;
  }, [active, activeId, configs, runPersist]);

  // 模型清单：添加 / 移除 / 设为当前。
  const addModel = useCallback(name => {
    const value = String(name || '').trim();
    if (!value) return;
    setConfigs(current => current.map(item => {
      if (item.id !== activeId) return item;
      if (item.models.includes(value)) return item;
      const models = [...item.models, value];
      return { ...item, models, activeModel: item.activeModel || value };
    }));
  }, [activeId]);

  const removeModel = useCallback(name => {
    setConfigs(current => current.map(item => {
      if (item.id !== activeId) return item;
      const models = item.models.filter(model => model !== name);
      if (models.length === 0) {
        Alert.alert(tRef.current('settings.api.keepOne.title'), tRef.current('settings.api.keepOne.body'));
        return item;
      }
      const activeModel = models.includes(item.activeModel) ? item.activeModel : models[0];
      return { ...item, models, activeModel };
    }));
  }, [activeId]);

  const setActiveModel = useCallback(name => {
    setConfigs(current => current.map(item => (
      item.id === activeId ? { ...item, activeModel: name } : item
    )));
  }, [activeId]);

  // 能力位（按模型一份，与共享层 capabilitiesForModel 同结构）。
  const patchCapability = useCallback((model, patch) => {
    if (!model) return;
    setConfigs(current => current.map(item => {
      if (item.id !== activeId) return item;
      const table = item.modelCapabilities || {};
      const existing = table[model] || {};
      return {
        ...item,
        modelCapabilities: { ...table, [model]: { ...existing, ...patch } },
      };
    }));
  }, [activeId]);

  const detect = useCallback(async () => {
    if (!active || detecting) return;
    const baseUrl = String(active.baseUrl || '').trim();
    const apiKey = String(active.apiKey || '').trim();
    if (!baseUrl || !apiKey) {
      Alert.alert(tRef.current('settings.api.fillRequired'));
      return;
    }
    const sourceId = activeId;
    requestRef.current.cancel?.();
    setDetecting(true);
    setModelError('');
    try {
      const models = await detectModels(active, {
        t: tRef.current,
        isCurrent: () => mountedRef.current && sourceId === activeId,
        cancelHandle: requestRef.current,
      });
      if (!mountedRef.current || sourceId !== activeId) return;
      if (models.length === 0) {
        setModelError(tRef.current('settings.api.noModelsDetected.body'));
        return;
      }
      setConfigs(current => current.map(item => {
        if (item.id !== sourceId) return item;
        const merged = [...item.models];
        models.forEach(model => { if (!merged.includes(model)) merged.push(model); });
        return { ...item, models: merged, activeModel: item.activeModel || merged[0] };
      }));
    } catch (error) {
      if (!mountedRef.current || sourceId !== activeId) return;
      setModelError(String((error && error.message) || tRef.current('settings.api.err.request')));
    } finally {
      if (mountedRef.current) setDetecting(false);
    }
  }, [active, activeId, detecting]);

  return {
    configs,
    active,
    activeId,
    loaded,
    busy,
    dirty,
    detecting,
    modelError,
    activeModel: active ? getActiveModel(active) : '',
    protocolOptions: PROTOCOL_OPTIONS,
    vendors: CHAT_API_VENDORS,
    selectConfig,
    addConfig,
    deleteConfig,
    updateField,
    changeProtocol,
    save,
    addModel,
    removeModel,
    setActiveModel,
    patchCapability,
    detect,
  };
}