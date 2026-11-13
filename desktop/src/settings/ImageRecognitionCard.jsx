// 图片识别（OCR）模型（桌面）：给主模型配一个「先看图、再说话」的辅助模型。
//
// 这条链路在共享层是通的：useChatSend 发送前调 resolveImageRecognitionPlan +
// applyImageRecognitionToMessages，把图片先转成文字描述再交给主模型——所以主模型
// 不识图也能「看懂」图片。桌面缺的只是这张设置卡。
//
// 密钥纪律（照抄手机）：这里**没有** API Key 输入框，只选既有配置；密钥仍由该配置
// 自己的保险箱保管，避免出现第二套密钥存储。
// 提示词默认模板是发给模型的话（不进语言包），由共享层 DEFAULT_DESCRIPTION_PROMPT 提供。
import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  getImageRecognitionSettings,
  saveImageRecognitionSettings,
} from '../../../src/storage/settings/imageRecognition.js';
import { getApiConfigs } from '../../../src/storage/apiConfigs.js';
import { Alert } from '../platform/alert.js';
import { Card, Field, Select, TextInput, Toggle } from './ui.jsx';

export default function ImageRecognitionCard({ palette, fonts }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(null);
  const [configs, setConfigs] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [stored, api] = await Promise.all([
        getImageRecognitionSettings(),
        getApiConfigs().catch(() => ({ configs: [] })),
      ]);
      setSettings(stored);
      setConfigs(Array.isArray(api.configs) ? api.configs : []);
    } catch (error) {
      Alert.alert(t('settings.imageRecognition.sectionTitle'), t('common.error.retryLater'));
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const persist = async patch => {
    if (!settings || busy) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setBusy(true);
    try {
      await saveImageRecognitionSettings(next);
    } catch (error) {
      // 写失败（含读坏守卫）：回滚到落盘值，不显示「已保存」。
      await load();
      Alert.alert(t('settings.imageRecognition.sectionTitle'), t('common.error.storageOrPermission'));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) {
    return (
      <Card title={t('settings.imageRecognition.sectionTitle')} palette={palette} fonts={fonts}>
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
      </Card>
    );
  }

  const configOptions = [
    { value: '', label: t('settings.imageRecognition.apiConfigPlaceholder') },
    ...configs.map(item => ({ value: item.id, label: item.name || t('settings.api.unnamed') })),
  ];
  const selected = configs.find(item => item.id === settings.apiConfigId) || null;

  return (
    <Card
      title={t('settings.imageRecognition.sectionTitle')}
      hint={t('settings.imageRecognition.intro')}
      palette={palette}
      fonts={fonts}
    >
      <Toggle
        checked={settings.enabled === true}
        onChange={value => persist({ enabled: value })}
        label={t('settings.imageRecognition.enable')}
        palette={palette}
        fonts={fonts}
        disabled={busy}
      />
      <Field
        label={t('settings.imageRecognition.apiConfigLabel')}
        hint={settings.apiConfigId
          ? t('settings.imageRecognition.apiConfigSelected', { name: (selected && selected.name) || settings.apiConfigId })
          : t('settings.imageRecognition.apiConfigHint')}
        palette={palette}
        fonts={fonts}
      >
        <Select
          value={String(settings.apiConfigId || '')}
          options={configOptions}
          onChange={value => persist({ apiConfigId: value })}
          palette={palette}
          fonts={fonts}
          disabled={busy}
        />
      </Field>
      <Field label={t('settings.imageRecognition.model')} hint={t('settings.imageRecognition.modelHint')} palette={palette} fonts={fonts}>
        <TextInput
          value={String(settings.model || '')}
          onChange={value => persist({ model: value })}
          placeholder={t('settings.imageRecognition.modelPlaceholder')}
          palette={palette}
          fonts={fonts}
          disabled={busy}
        />
      </Field>
      <Field label={t('settings.imageRecognition.prompt')} hint={t('settings.imageRecognition.promptHint')} palette={palette} fonts={fonts}>
        <textarea
          value={String(settings.prompt || '')}
          onChange={event => persist({ prompt: event.target.value })}
          placeholder={t('settings.imageRecognition.promptPlaceholder')}
          rows={4}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            background: palette.surfaceAlt,
            color: palette.text,
            border: `1px solid ${palette.divider}`,
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: fonts.scaled(12),
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
      </Field>
    </Card>
  );
}
