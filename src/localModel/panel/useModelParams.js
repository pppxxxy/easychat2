// 参数弹窗的状态与接线（从壳抽出）：打开时读条目回填表单，保存走注入的 saver。
// 校验/落盘/反馈都在 panelFeedback.createParamsSaver 里，这里只管状态与生命周期。

import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import { getLocalModelItem } from '../../storage.js';
import { LOCAL_MODEL_PARAM_FIELDS } from '../modelParams.js';

export function useModelParams({ t, saveParams }) {
  const [target, setTarget] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);

  const openParams = useCallback(async entry => {
    const item = await getLocalModelItem(entry.id).catch(() => null);
    if (!item) {
      Alert.alert(t('localModel.alert.paramsUnavailable.title'), t('localModel.alert.paramsUnavailable.body'));
      return;
    }
    setTarget(item);
    const next = {};
    Object.keys(LOCAL_MODEL_PARAM_FIELDS).forEach(field => { next[field] = String(item.params[field]); });
    setForm(next);
  }, [t]);

  const save = useCallback(async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      const result = await saveParams(target, form);
      if (result && result.ok) setTarget(null);
    } finally {
      setBusy(false);
    }
  }, [busy, form, saveParams, target]);

  const close = useCallback(() => setTarget(null), []);

  const setField = useCallback((field, text) => {
    setForm(current => ({ ...current, [field]: text }));
  }, []);

  return {
    target,
    form,
    busy,
    openParams,
    save,
    close,
    setField,
  };
}
