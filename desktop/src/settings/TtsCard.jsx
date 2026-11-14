// 语音播报（TTS）设置（桌面）：对应手机 TtsPanel.js。
//
// 与手机的差别只有一处，而且是**平台事实**，不是取舍：
//   手机把「系统引擎」与各云端引擎放在同一个列表里选；桌面两者也都可用，但
//   **云端引擎的音频播放**依赖 expo-audio 的 createAudioPlayer——桌面已用
//   HTMLAudioElement 补齐（platform/audio.js），data URI 原生可播，所以同样可用。
//   因此这里不隐藏云端 provider，只把「字段」按共享 TTS_PROVIDERS 的声明渲染出来。
//
// 判定与文案全部来自共享层：
//   · TTS_PROVIDERS / getTtsProvider         provider 与字段声明；
//   · ttsProviderLabel / ttsFieldLabel / ttsFieldPlaceholder / ttsUnsupportedNote
//                                           显示名与字段文案（key 优先，常量兜底）；
//   · getTtsSettings / saveTtsSettings      读写（读坏时抛错，面板据此拒绝写）。
// 音色候选（provider.voices）是共享声明里的数组，桌面同样渲染成下拉 + 自定义输入。
import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  getTtsSettings,
  saveTtsSettings,
} from '../../../src/storage/settings.js';
import {
  TTS_PROVIDERS,
  getTtsProvider,
  ttsFieldLabel,
  ttsFieldPlaceholder,
  ttsProviderLabel,
  ttsUnsupportedNote,
} from '../../../src/tts/providers.js';
import { Alert } from '../platform/alert.js';
import { Button, Card, Field, Row, Select } from './ui.jsx';

export default function TtsCard({ palette, fonts }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    getTtsSettings()
      .then(value => {
        if (!alive) return;
        setSettings(value);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!alive) return;
        // 读坏就拒绝编辑：拿默认值保存会把用户配好的 provider 与密钥静默清空。
        setLoadFailed(true);
      });
    return () => { alive = false; };
  }, []);

  const provider = settings ? getTtsProvider(settings.activeProvider) : null;
  const config = settings && provider
    ? (settings.providers[provider.id] || {})
    : {};

  const setConfigField = useCallback((field, value) => {
    setSettings(current => {
      if (!current || !provider) return current;
      return {
        ...current,
        providers: {
          ...current.providers,
          [provider.id]: { ...(current.providers[provider.id] || {}), [field]: value },
        },
      };
    });
  }, [provider]);

  const save = useCallback(async () => {
    if (!settings || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await saveTtsSettings(settings);
      setSettings(saved);
      Alert.alert(t('settings.api.saved.title'), t('settings.api.saved.body'));
    } catch (error) {
      Alert.alert(t('tts.alert.saveFailed.title'), t('tts.alert.saveFailed.body'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [settings, t]);

  return (
    <Card
      title={t('tts.title')}
      hint={t('tts.hint.sendToProvider')}
      palette={palette}
      fonts={fonts}
    >
      {loadFailed ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.danger }}>
          {t('error.storage.ttsSettingsReadFailed')}
        </div>
      ) : !settings ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>
          {t('common.loading')}
        </div>
      ) : (
        <>
          <Field label={t('tts.autoBroadcast.title')} hint={t('tts.autoBroadcast.hint')} palette={palette} fonts={fonts}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: fonts.scaled(12), color: palette.text }}>
              <input
                type="checkbox"
                checked={settings.autoBroadcast === true}
                onChange={event => {
                  const checked = event.target.checked;
                  setSettings(current => (current ? { ...current, autoBroadcast: checked } : current));
                }}
              />
              {t('tts.autoBroadcast.title')}
            </label>
          </Field>

          <Field label={t('tts.providerLabel')} palette={palette} fonts={fonts}>
            <Select
              value={settings.activeProvider}
              options={TTS_PROVIDERS.map(item => ({
                value: item.id,
                label: ttsProviderLabel(t, item),
              }))}
              onChange={value => {
                setSettings(current => (current ? { ...current, activeProvider: value } : current));
              }}
              palette={palette}
              fonts={fonts}
            />
          </Field>

          {provider ? (
            <>
              {ttsUnsupportedNote(t, provider) ? (
                <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, marginBottom: 8 }}>
                  {ttsUnsupportedNote(t, provider)}
                </div>
              ) : null}
              {provider.apiKeyUrl ? (
                <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, marginBottom: 8 }}>
                  {t('tts.getApiKey')}
                  {' '}
                  <a
                    href={provider.apiKeyUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: palette.primary }}
                  >
                    {provider.apiKeyUrl}
                  </a>
                </div>
              ) : null}
              {provider.fields.map(field => {
                // 音色字段且 provider 声明了候选：下拉 + 「自定义」输入两段。
                const isVoice = field.key === 'voice' && Array.isArray(provider.voices) && provider.voices.length > 0;
                const value = String(config[field.key] == null ? '' : config[field.key]);
                return (
                  <Field
                    key={field.key}
                    label={ttsFieldLabel(t, field)}
                    palette={palette}
                    fonts={fonts}
                  >
                    {isVoice ? (
                      <Row>
                        <Select
                          value={provider.voices.includes(value) ? value : ''}
                          options={[
                            { value: '', label: t('tts.voices.default') },
                            ...provider.voices.map(voice => ({ value: voice, label: voice })),
                          ]}
                          onChange={next => setConfigField(field.key, next)}
                          palette={palette}
                          fonts={fonts}
                        />
                        <input
                          type={field.secret ? 'password' : 'text'}
                          value={value}
                          placeholder={ttsFieldPlaceholder(t, field)}
                          onChange={event => setConfigField(field.key, event.target.value)}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            background: palette.surface,
                            color: palette.text,
                            border: `1px solid ${palette.divider}`,
                            borderRadius: 8,
                            padding: '5px 8px',
                            fontSize: fonts.scaled(11),
                          }}
                        />
                      </Row>
                    ) : (
                      <input
                        type={field.secret ? 'password' : 'text'}
                        value={value}
                        placeholder={ttsFieldPlaceholder(t, field)}
                        onChange={event => setConfigField(field.key, event.target.value)}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          background: palette.surface,
                          color: palette.text,
                          border: `1px solid ${palette.divider}`,
                          borderRadius: 8,
                          padding: '5px 8px',
                          fontSize: fonts.scaled(11),
                        }}
                      />
                    )}
                  </Field>
                );
              })}
            </>
          ) : null}

          <div style={{ marginTop: 8 }}>
            <Button
              label={t('common.save')}
              onClick={save}
              palette={palette}
              fonts={fonts}
              disabled={saving}
            />
          </div>
        </>
      )}
    </Card>
  );
}
