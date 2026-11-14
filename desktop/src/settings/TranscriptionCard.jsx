// 语音转写（STT）设置（桌面）：对应手机 TranscriptionPanel.js。
//
// 这一项在桌面**真的可用**，不是设置摆设：共享层 src/transcription.js 是纯 HTTP
// （POST multipart 到 /v1/audio/transcriptions），桌面侧的障碍只是「渲染进程的 fetch
// 装不下 RN 形态的文件项」——已由 platform/fetch.js + 主进程 multipart 通道解决。
// 所以这里给的是完整的多配置编辑器，而不是一句「不支持」。
//
// 数据与判定全部来自共享层：
//   · TRANSCRIPTION_API_VENDORS         厂商预设（baseUrl / model / 取 key 链接）；
//   · normalizeTranscriptionSettings    形状（activeId='' 表示复用聊天来源）；
//   · getTranscriptionSettings / saveTranscriptionSettings
//                                       读写（读坏时抛错，写路径也自带守卫）。
// 默认 activeId 为 '' 的语义照抄手机：不单独配也能用——转写会复用当前聊天来源。
import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { TRANSCRIPTION_API_VENDORS } from '../../../src/network/apiVendors.js';
import {
  getTranscriptionSettings,
  saveTranscriptionSettings,
} from '../../../src/storage/settings.js';
import { Alert } from '../platform/alert.js';
import { Button, Card, Field, Row, Select } from './ui.jsx';

function newConfigId() {
  return `stt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export default function TranscriptionCard({ palette, fonts }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    getTranscriptionSettings()
      .then(value => {
        if (!alive) return;
        setSettings(value);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!alive) return;
        setLoadFailed(true);
      });
    return () => { alive = false; };
  }, []);

  const active = settings && settings.activeId
    ? settings.configs.find(item => item.id === settings.activeId) || null
    : null;

  const patchConfig = useCallback((id, patch) => {
    setSettings(current => {
      if (!current) return current;
      return {
        ...current,
        configs: current.configs.map(item => (item.id === id ? { ...item, ...patch } : item)),
      };
    });
  }, []);

  const addConfig = useCallback(vendorId => {
    const vendor = TRANSCRIPTION_API_VENDORS.find(item => item.id === vendorId) || null;
    const id = newConfigId();
    setSettings(current => {
      if (!current) return current;
      return {
        ...current,
        activeId: id,
        configs: [
          ...current.configs,
          {
            id,
            name: vendor ? t(vendor.nameKey) : t('transcription.config.newName'),
            baseUrl: vendor ? vendor.baseUrl : '',
            apiKey: '',
            model: vendor ? vendor.model : 'whisper-1',
            vendorId: vendor ? vendor.id : '',
          },
        ],
      };
    });
  }, [t]);

  const removeConfig = useCallback(id => {
    setSettings(current => {
      if (!current) return current;
      const configs = current.configs.filter(item => item.id !== id);
      return {
        ...current,
        configs,
        activeId: current.activeId === id ? '' : current.activeId,
      };
    });
  }, []);

  const save = useCallback(async () => {
    if (!settings || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await saveTranscriptionSettings(settings);
      setSettings(saved);
      Alert.alert(t('settings.api.saved.title'), t('settings.api.saved.body'));
    } catch (error) {
      Alert.alert(t('transcription.alert.saveFailed.title'), t('transcription.alert.saveFailed.body'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [settings, t]);

  const vendor = active && active.vendorId
    ? TRANSCRIPTION_API_VENDORS.find(item => item.id === active.vendorId) || null
    : null;

  return (
    <Card
      title={t('transcription.title')}
      hint={t('transcription.intro')}
      palette={palette}
      fonts={fonts}
    >
      {loadFailed ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.danger }}>
          {t('transcription.alert.loadFailed.body')}
        </div>
      ) : !settings ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>
          {t('common.loading')}
        </div>
      ) : (
        <>
          <Field
            label={t('transcription.addLabel')}
            hint={t('transcription.addHint')}
            palette={palette}
            fonts={fonts}
          >
            <Row>
              <Select
                value=""
                options={[
                  { value: '', label: t('transcription.addLabel') },
                  ...TRANSCRIPTION_API_VENDORS.map(item => ({
                    value: item.id,
                    label: t(item.nameKey),
                  })),
                  { value: '__custom__', label: t('transcription.custom') },
                ]}
                onChange={value => {
                  if (!value) return;
                  addConfig(value === '__custom__' ? '' : value);
                }}
                palette={palette}
                fonts={fonts}
              />
            </Row>
          </Field>

          {/* 已有配置：选一条作为当前生效（'' = 复用聊天来源，与手机同语义）。 */}
          <Field label={t('transcription.sourceLabel')} palette={palette} fonts={fonts}>
            <Select
              value={settings.activeId}
              options={[
                { value: '', label: t('transcription.reuse.title') },
                ...settings.configs.map(item => ({
                  value: item.id,
                  label: item.name || t('transcription.config.unnamed'),
                })),
              ]}
              onChange={value => {
                setSettings(current => (current ? { ...current, activeId: value } : current));
              }}
              palette={palette}
              fonts={fonts}
            />
          </Field>

          {active ? (
            <div style={{
              border: `1px solid ${palette.divider}`,
              borderRadius: 10,
              padding: 10,
              marginBottom: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
            >
              <Field label={t('transcription.field.name')} palette={palette} fonts={fonts}>
                <input
                  type="text"
                  value={active.name}
                  placeholder={t('transcription.field.namePlaceholder')}
                  onChange={event => patchConfig(active.id, { name: event.target.value })}
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
              </Field>
              <Field label={t('transcription.field.baseUrl')} palette={palette} fonts={fonts}>
                <input
                  type="text"
                  value={active.baseUrl}
                  onChange={event => patchConfig(active.id, { baseUrl: event.target.value })}
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
              </Field>
              <Field label="API Key" palette={palette} fonts={fonts}>
                <input
                  type="password"
                  value={active.apiKey}
                  placeholder={t('transcription.field.apiKeyPlaceholder')}
                  onChange={event => patchConfig(active.id, { apiKey: event.target.value })}
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
              </Field>
              <Field label={t('transcription.field.model')} palette={palette} fonts={fonts}>
                <input
                  type="text"
                  value={active.model}
                  onChange={event => patchConfig(active.id, { model: event.target.value })}
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
              </Field>
              {vendor ? (
                <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>
                  {t(vendor.noteKey)}
                  {' '}
                  <a href={vendor.apiKeyUrl} target="_blank" rel="noreferrer" style={{ color: palette.primary }}>
                    {t('transcription.getKey')}
                  </a>
                </div>
              ) : null}
              <div>
                <Button
                  label={t('common.delete')}
                  onClick={() => removeConfig(active.id)}
                  palette={palette}
                  fonts={fonts}
                />
              </div>
            </div>
          ) : null}

          <Button
            label={t('common.save')}
            onClick={save}
            palette={palette}
            fonts={fonts}
            disabled={saving}
          />
        </>
      )}
    </Card>
  );
}
