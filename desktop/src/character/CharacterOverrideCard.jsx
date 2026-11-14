// 角色「专属配置」（桌面）：为本角色单独指定聊天 API 与模型，或「跟随全局」。
//
// 对应手机 character/CharacterOverridesSection 的四项：聊天 / OCR / TTS / 转写。
// 此前这里只做了前两项，注释还写着「TTS 与转写平台不可行」——那句话早已不成立：
// 播报走 Web Speech 或 HTMLAudioElement（platform/audio.js），转写是纯 HTTP
// （transcription.js + 主进程 multipart）。缺的只是 UI，S37 补齐。
//
// 数据全部复用共享层 storage/characterOverrides：
//   · getCharacterOverridesStatus —— 三态读（corrupt 时**拒绝编辑**，绝不把其余专属配置清空）；
//   · saveCharacterOverrides —— 写之前同样有读守卫；
//   · isEmptyCharacterOverrides / countCharacterOverrides —— 「配没配过」的一眼判据。
// 真正生效的路径在 character/runtimeConfig.resolveCharacterRuntimeConfig（聊天/总结/制卡共用）。
import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import {
  countCharacterOverrides,
  deleteCharacterOverrides,
  getCharacterOverridesStatus,
  saveCharacterOverrides,
} from '../../../src/storage/characterOverrides.js';
import { getApiConfigs } from '../../../src/storage/apiConfigs.js';
import { getTtsSettings, getTranscriptionSettings } from '../../../src/storage/settings.js';
import { TTS_PROVIDERS, getTtsProvider, ttsProviderLabel } from '../../../src/tts/providers.js';
import { Alert } from '../platform/alert.js';
import { Button, Card, Field, Row, Select } from '../settings/ui.jsx';

export default function CharacterOverrideCard({ character, palette, fonts }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState('loading');
  const [overrides, setOverrides] = useState(null);
  const [configs, setConfigs] = useState([]);
  // TTS / 转写：与聊天、OCR 同样「跟随全局或按角色指定」。
  const [ttsSettings, setTtsSettings] = useState(null);
  const [transcription, setTranscription] = useState(null);
  const [busy, setBusy] = useState(false);

  const characterId = String((character && character.id) || '');

  const load = useCallback(async () => {
    if (!characterId) return;
    setStatus('loading');
    try {
      const [result, api, tts, stt] = await Promise.all([
        getCharacterOverridesStatus(characterId),
        getApiConfigs().catch(() => ({ configs: [] })),
        // 这两个读失败不阻断整卡：读不到就只显示「跟随全局」，不允许选具体值。
        getTtsSettings().catch(() => null),
        getTranscriptionSettings().catch(() => null),
      ]);
      setTtsSettings(tts);
      setTranscription(stt);
      // 三态：corrupt 不能渲染成「没有专属配置」——那会让用户以为配置丢了，
      // 而且一旦编辑就会把其余专属配置整表覆盖。
      setStatus(result.status === 'corrupt' ? 'corrupt' : 'ok');
      setOverrides(result.overrides || null);
      setConfigs(Array.isArray(api.configs) ? api.configs : []);
    } catch (error) {
      setStatus('corrupt');
    }
  }, [characterId]);

  useEffect(() => { load(); }, [load]);

  const persist = async next => {
    if (!characterId || busy) return;
    setBusy(true);
    try {
      await saveCharacterOverrides(characterId, next);
      setOverrides(next);
    } catch (error) {
      // 读守卫会抛错：此时什么都不写，界面保持原值（绝不显示「已保存」）。
      Alert.alert(t('character.overrides.readFailed'), t('character.overrides.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const resolved = overrides || {};
  const current = String(resolved.chatApiConfigId || '');
  const ocrCurrent = String(resolved.ocrApiConfigId || '');
  const configOptions = [
    { value: '', label: t('character.overrides.followGlobal') },
    ...configs.map(item => ({ value: item.id, label: item.name || t('settings.api.unnamed') })),
  ];
  const models = (configs.find(item => item.id === current) || {}).models || [];
  const ocrModels = (configs.find(item => item.id === ocrCurrent) || {}).models || [];
  const modelOptions = [
    { value: '', label: t('character.overrides.followModel') },
    ...models.map(model => ({ value: model, label: model })),
  ];
  const ocrModelOptions = [
    { value: '', label: t('character.overrides.followModel') },
    ...ocrModels.map(model => ({ value: model, label: model })),
  ];
  const count = countCharacterOverrides(resolved);

  // ---- TTS：provider 与音色（音色候选来自共享 TTS_PROVIDERS 声明）----
  const ttsGlobalId = String((ttsSettings && ttsSettings.activeProvider) || 'system');
  const ttsEffectiveId = String(resolved.ttsProviderId || '') || ttsGlobalId;
  const ttsProvider = getTtsProvider(ttsEffectiveId);
  const ttsProviderConfig = (ttsSettings && ttsSettings.providers && ttsSettings.providers[ttsEffectiveId]) || {};
  const ttsGlobalVoice = String(ttsProviderConfig.voice || '');
  const ttsProviderOptions = [
    { value: '', label: t('character.overrides.followGlobal') },
    ...TTS_PROVIDERS.map(item => ({ value: item.id, label: ttsProviderLabel(t, item) })),
  ];
  const ttsVoiceOptions = [
    { value: '', label: ttsGlobalVoice ? `${t('character.overrides.followVoice')}（${ttsGlobalVoice}）` : t('character.overrides.voiceDefault') },
    ...((Array.isArray(ttsProvider.voices) ? ttsProvider.voices : []).map(voice => ({ value: voice, label: voice }))),
  ];

  // ---- 转写：配置列表 ----
  const sttConfigs = Array.isArray(transcription && transcription.configs) ? transcription.configs : [];
  const sttOptions = [
    { value: '', label: t('character.overrides.followGlobal') },
    ...sttConfigs.map(item => ({ value: item.id, label: item.name || t('transcription.config.unnamed') })),
  ];

  return (
    <Card
      title={`${t('character.overrides.title')}${count > 0 ? ` · ${count}` : ''}`}
      hint={t('character.overrides.hint')}
      palette={palette}
      fonts={fonts}
    >
      {status === 'loading' ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
      ) : null}

      {/* 读失败：明确说「不显示也不允许改」，而不是给一个空表单让人覆盖。 */}
      {status === 'corrupt' ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f', lineHeight: 1.7 }}>
          {t('character.overrides.loadFailed')}
        </div>
      ) : null}

      {status === 'ok' ? (
        <>
          <Field label={t('character.overrides.chat')} palette={palette} fonts={fonts}>
            <Row>
              <Select
                value={current}
                options={configOptions}
                onChange={value => persist({ ...resolved, chatApiConfigId: value })}
                palette={palette}
                fonts={fonts}
                disabled={busy}
              />
              {current ? (
                <span style={{
                  fontSize: fonts.scaled(10),
                  color: palette.primaryMuted || palette.primary,
                  border: `1px solid ${palette.primaryMuted || palette.primary}`,
                  borderRadius: 999,
                  padding: '1px 8px',
                }}
                >
                  {t('character.overrides.badge')}
                </span>
              ) : null}
            </Row>
          </Field>
          {current ? (
            <Field label={t('character.overrides.model')} palette={palette} fonts={fonts}>
              <Select
                value={String(resolved.chatModel || '')}
                options={modelOptions}
                onChange={value => persist({ ...resolved, chatModel: value })}
                palette={palette}
                fonts={fonts}
                disabled={busy}
              />
            </Field>
          ) : null}
          <Field
            label={t('character.overrides.ocr')}
            hint={t('character.overrides.ocrHint')}
            palette={palette}
            fonts={fonts}
          >
            <Row>
              <Select
                value={ocrCurrent}
                options={configOptions}
                onChange={value => persist({ ...resolved, ocrApiConfigId: value })}
                palette={palette}
                fonts={fonts}
                disabled={busy}
              />
              {ocrCurrent ? (
                <span style={{
                  fontSize: fonts.scaled(10),
                  color: palette.primaryMuted || palette.primary,
                  border: `1px solid ${palette.primaryMuted || palette.primary}`,
                  borderRadius: 999,
                  padding: '1px 8px',
                }}
                >
                  {t('character.overrides.badge')}
                </span>
              ) : null}
            </Row>
          </Field>
          {ocrCurrent ? (
            <Field label={t('character.overrides.model')} palette={palette} fonts={fonts}>
              <Select
                value={String(resolved.ocrModel || '')}
                options={ocrModelOptions}
                onChange={value => persist({ ...resolved, ocrModel: value })}
                palette={palette}
                fonts={fonts}
                disabled={busy}
              />
            </Field>
          ) : null}
          {/* 专属 TTS：换 provider 与音色；音色候选随 provider 变（共享声明）。 */}
          <Field
            label={t('character.overrides.tts')}
            palette={palette}
            fonts={fonts}
          >
            <Row>
              <Select
                value={String(resolved.ttsProviderId || '')}
                options={ttsProviderOptions}
                onChange={value => persist({ ...resolved, ttsProviderId: value })}
                palette={palette}
                fonts={fonts}
                disabled={busy}
              />
            </Row>
          </Field>
          <Field label={t('character.overrides.voice')} palette={palette} fonts={fonts}>
            <Select
              value={String(resolved.ttsVoice || '')}
              options={ttsVoiceOptions}
              onChange={value => persist({ ...resolved, ttsVoice: value })}
              palette={palette}
              fonts={fonts}
              disabled={busy}
            />
          </Field>

          {/* 专属转写：只换「用哪条配置」，与手机同一判据（转写总开关不在这里）。 */}
          <Field
            label={t('character.overrides.transcription')}
            hint={t('transcription.reuse.meta')}
            palette={palette}
            fonts={fonts}
          >
            <Row>
              <Select
                value={String(resolved.transcriptionConfigId || '')}
                options={sttOptions}
                onChange={value => persist({ ...resolved, transcriptionConfigId: value })}
                palette={palette}
                fonts={fonts}
                disabled={busy || sttConfigs.length === 0}
              />
            </Row>
          </Field>

          <Row>
            <Button
              label={t('character.overrides.followGlobal')}
              onClick={() => {
                if (!overrides) return;
                // 「改回跟随全局」= 删掉该角色的专属项（共享层负责清理空壳条目）。
                deleteCharacterOverrides(characterId)
                  .then(() => setOverrides(null))
                  .catch(() => Alert.alert(t('character.overrides.saveFailed'), t('character.overrides.saveFailed')));
              }}
              palette={palette}
              fonts={fonts}
              disabled={busy || !overrides}
            />
          </Row>
          <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
            {t('character.overrides.followChatSource')}
          </div>
        </>
      ) : null}
    </Card>
  );
}
