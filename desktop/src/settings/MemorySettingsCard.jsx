// 设置页「向量记忆」分区（桌面）：记忆总结 + 向量记忆配置。
//
// 位置对齐手机版：Android 的这两个设置都在「设置 → 向量记忆」（settings/sectionOrder.js
// 的 'vector' 分区），不在「记忆」标签里——记忆标签是会话列表管理（见 memory/MemoryListScreen.jsx）。
// 桌面此前把它们放进了记忆标签，导致顶栏还要额外塞一个「会话」入口；本次归位。
//
// 两者都复用共享层存储：
//   · 记忆总结：patchMemorySummarySettings（读-合并-写，不会把「记忆长度」重置）
//   · 向量记忆：getVectorMemorySettings / saveVectorMemorySettings + testVectorConnection
// 与 Android 的区别只在布局：这里用单列卡片，且不提供「清空向量记忆」以外的管理动作。
import { useEffect, useRef, useState } from 'react';

import {
  getMemorySummarySettings,
  patchMemorySummarySettings,
} from '../../../src/storage/settings.js';
import {
  clearVectorIndex,
  createVectorConfig,
  getVectorMemorySettings,
  saveVectorMemorySettings,
} from '../../../src/storage/vector.js';
import { testVectorConnection } from '../../../src/vectorMemory/index.js';
import { VECTOR_TOP_K_MAX } from '../../../src/vectorMemory/limits.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import { Button, Card, Divider, Field, Row, Select, TextInput, Toggle } from './ui.jsx';

function SummaryCard({ palette, fonts }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [settings, setSettings] = useState(null);
  const [thresholdDraft, setThresholdDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    getMemorySummarySettings()
      .then(value => {
        if (!mountedRef.current) return;
        setSettings(value);
        setThresholdDraft(String(value.threshold));
      })
      .catch(() => {});
    return () => { mountedRef.current = false; };
  }, []);

  const save = async patch => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await patchMemorySummarySettings(patch);
      if (mountedRef.current) {
        setSettings(saved);
        setThresholdDraft(String(saved.threshold));
      }
    } catch (error) {
      if (mountedRef.current) {
        Alert.alert(tRef.current('settings.sampling.alert.saveFailed.title'), tRef.current('settings.sampling.alert.saveFailed.body'));
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <Card title={t('preset.memory.title')} hint={t('preset.memory.desc')} palette={palette} fonts={fonts}>
      {!settings ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
      ) : (
        <>
          <Toggle
            checked={settings.enabled}
            onChange={value => save({ enabled: value })}
            label={t('preset.memory.title')}
            palette={palette}
            fonts={fonts}
            disabled={saving}
          />
          <Field label={t('preset.memory.thresholdLabel')} palette={palette} fonts={fonts}>
            <Row>
              <div style={{ width: 140 }}>
                <TextInput
                  value={thresholdDraft}
                  onChange={setThresholdDraft}
                  type="number"
                  palette={palette}
                  fonts={fonts}
                />
              </div>
              <Button
                label={saving ? t('backup.progress.ratio') : t('common.save')}
                onClick={() => {
                  const value = Math.trunc(Number(thresholdDraft));
                  if (!Number.isFinite(value) || value <= 0) {
                    Alert.alert(t('preset.alert.thresholdInvalid.title'), t('preset.alert.thresholdInvalid.body', { value: settings.threshold }));
                    setThresholdDraft(String(settings.threshold));
                    return;
                  }
                  save({ threshold: value });
                }}
                palette={palette}
                fonts={fonts}
                disabled={saving}
              />
            </Row>
          </Field>
          <Field label={t('preset.memory.maxEntriesLabel')} palette={palette} fonts={fonts}>
            <div style={{ width: 140 }}>
              <TextInput
                value={String(settings.maxEntries)}
                onChange={value => {
                  const parsed = Math.trunc(Number(value));
                  if (Number.isFinite(parsed) && parsed > 0) save({ maxEntries: parsed });
                }}
                type="number"
                palette={palette}
                fonts={fonts}
                disabled={saving}
              />
            </div>
          </Field>
        </>
      )}
    </Card>
  );
}

function VectorCard({ palette, fonts, character }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [payload, setPayload] = useState(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);
  const payloadRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    getVectorMemorySettings()
      .then(value => {
        if (!mountedRef.current) return;
        setPayload(value);
        payloadRef.current = value;
      })
      .catch(() => {});
    return () => { mountedRef.current = false; };
  }, []);

  const active = payload
    ? (payload.configs.find(item => item.id === payload.activeId) || payload.configs[0] || null)
    : null;

  // 局部改动：立即改内存，落盘串行（不与测试请求抢占）。
  const patch = next => {
    if (!payload) return;
    const updated = {
      ...payload,
      configs: payload.configs.map(item => (
        item.id === payload.activeId ? { ...item, ...next } : item
      )),
    };
    setPayload(updated);
    payloadRef.current = updated;
  };

  const persist = async nextPayload => {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await saveVectorMemorySettings(nextPayload || payloadRef.current);
      if (mountedRef.current) {
        setPayload(saved);
        payloadRef.current = saved;
      }
    } catch (error) {
      if (mountedRef.current) {
        Alert.alert(tRef.current('settings.vector.alert.persistFailed.title'), tRef.current('settings.vector.alert.persistFailed.body'));
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const test = async () => {
    if (!active || testing) return;
    setTesting(true);
    try {
      const result = await testVectorConnection(active);
      Alert.alert(
        tRef.current('settings.vector.alert.testOk.title'),
        tRef.current('settings.vector.alert.testOk.body', { dims: (result && result.dims) || 0 })
      );
    } catch (error) {
      Alert.alert(tRef.current('settings.vector.alert.testFailed.title'), tRef.current('settings.vector.alert.testFailed.body'));
    } finally {
      if (mountedRef.current) setTesting(false);
    }
  };

  const addConfig = async () => {
    if (!payload || saving) return;
    const created = createVectorConfig({
      name: tRef.current('settings.vector.defaultName', { n: payload.configs.length + 1 }),
    });
    const next = { ...payload, configs: [...payload.configs, created], activeId: created.id };
    setPayload(next);
    payloadRef.current = next;
    await persist(next);
  };

  const removeConfig = async () => {
    if (!payload || !active || payload.configs.length <= 1) {
      Alert.alert(t('settings.vector.alert.cannotDelete.title'), t('settings.vector.alert.cannotDelete.body'));
      return;
    }
    Alert.alert(t('settings.vector.alert.delete.title'), t('settings.vector.alert.delete.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          const configs = payload.configs.filter(item => item.id !== active.id);
          const next = { ...payload, configs, activeId: configs[0].id };
          setPayload(next);
          payloadRef.current = next;
          await persist(next);
        },
      },
    ]);
  };

  return (
    <Card title={t('settings.vector.title')} hint={t('settings.vector.enableHint')} palette={palette} fonts={fonts}>
      {!payload ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
      ) : (
        <>
          <Toggle
            checked={payload.enabled}
            onChange={value => {
              const next = { ...payload, enabled: value };
              setPayload(next);
              payloadRef.current = next;
              persist(next);
            }}
            label={t('settings.vector.enable')}
            palette={palette}
            fonts={fonts}
            disabled={saving}
          />
          <Field label={t('settings.vector.config')} palette={palette} fonts={fonts}>
            <Row>
              <Select
                value={payload.activeId}
                options={payload.configs.map(item => ({
                  value: item.id,
                  label: item.name || t('settings.api.unnamed'),
                }))}
                onChange={id => {
                  const next = { ...payload, activeId: id };
                  setPayload(next);
                  payloadRef.current = next;
                  persist(next);
                }}
                palette={palette}
                fonts={fonts}
                disabled={saving}
              />
              <Button label={t('settings.vector.add')} onClick={addConfig} palette={palette} fonts={fonts} disabled={saving} />
              <Button label={t('settings.vector.deleteCurrent')} onClick={removeConfig} palette={palette} fonts={fonts} disabled={saving || payload.configs.length <= 1} />
            </Row>
          </Field>
          {active ? (
            <>
              <Field label={t('settings.api.name')} palette={palette} fonts={fonts}>
                <TextInput value={active.name} onChange={value => patch({ name: value })} placeholder={t('settings.vector.namePlaceholder')} palette={palette} fonts={fonts} />
              </Field>
              <Field label={t('settings.vector.baseUrl')} palette={palette} fonts={fonts}>
                <TextInput value={active.baseUrl} onChange={value => patch({ baseUrl: value })} placeholder="https://api.openai.com/v1/embeddings" palette={palette} fonts={fonts} />
              </Field>
              <Field label={t('settings.vector.apiKey')} palette={palette} fonts={fonts}>
                <TextInput value={active.apiKey} onChange={value => patch({ apiKey: value })} type="password" palette={palette} fonts={fonts} />
              </Field>
              <Row>
                <Field label={t('settings.vector.model')} palette={palette} fonts={fonts}>
                  <TextInput value={active.model} onChange={value => patch({ model: value })} placeholder="text-embedding-3-small" palette={palette} fonts={fonts} />
                </Field>
                <Field label={t('settings.vector.topK')} palette={palette} fonts={fonts}>
                  <Select
                    value={String(active.topK)}
                    options={Array.from({ length: VECTOR_TOP_K_MAX }, (_, index) => String(index + 1)).map(value => ({ value, label: value }))}
                    onChange={value => patch({ topK: Number(value) })}
                    palette={palette}
                    fonts={fonts}
                  />
                </Field>
              </Row>
              <Field label={t('settings.vector.chunkSize')} palette={palette} fonts={fonts}>
                <div style={{ width: 160 }}>
                  <TextInput
                    value={String(active.maxChars)}
                    onChange={value => {
                      const parsed = Math.trunc(Number(value));
                      if (Number.isFinite(parsed) && parsed > 0) patch({ maxChars: parsed });
                    }}
                    type="number"
                    palette={palette}
                    fonts={fonts}
                  />
                </div>
              </Field>
              <Row>
                <Button
                  label={testing ? t('settings.vector.testing') : t('settings.vector.test')}
                  onClick={test}
                  palette={palette}
                  fonts={fonts}
                  disabled={testing}
                />
                <Button
                  label={saving ? t('backup.progress.ratio') : t('common.save')}
                  onClick={() => persist()}
                  palette={palette}
                  fonts={fonts}
                  primary
                  disabled={saving}
                />
              </Row>
              <div style={{ fontSize: fonts.scaled(11), color: palette.textFaint }}>{t('settings.vector.hint')}</div>
              {character ? (
                <>
                  <Divider palette={palette} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
                      {t('settings.vector.clear.currentRole')}: {character.name}
                    </span>
                    <Button
                      label={t('settings.vector.clear.entry', { name: character.name })}
                      onClick={() => {
                        // 清空向量记忆：复用共享层按角色清理（先删分片再删元数据）。
                        clearVectorIndex(character.id)
                          .then(() => Alert.alert(t('settings.vector.clear.done.title'), t('settings.vector.clear.done.body')))
                          .catch(() => Alert.alert(t('settings.vector.clear.fail.title'), t('settings.vector.clear.fail.body')));
                      }}
                      palette={palette}
                      fonts={fonts}
                    />
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </Card>
  );
}

export default function MemorySettingsCard({ palette, fonts, character }) {
  const { t } = useTranslation();
  return (
    <>
      <SummaryCard palette={palette} fonts={fonts} />
      <VectorCard palette={palette} fonts={fonts} character={character} />
      <Card title={t('settings.vector.clear.title')} palette={palette} fonts={fonts}>
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('settings.vector.hint')}</div>
      </Card>
    </>
  );
}