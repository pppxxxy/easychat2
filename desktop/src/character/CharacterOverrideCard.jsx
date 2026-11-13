// 角色「专属配置」（桌面）：为本角色单独指定聊天 API 与模型，或「跟随全局」。
//
// 对应手机 character/CharacterOverridesSection 的**聊天**那一项。桌面没有 OCR / TTS /
// 语音转文字（那三项依赖原生能力），所以这里只呈现聊天 API——不摆出点了没用的选择器。
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
import { Alert } from '../platform/alert.js';
import { Button, Card, Field, Row, Select } from '../settings/ui.jsx';

export default function CharacterOverrideCard({ character, palette, fonts }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState('loading');
  const [overrides, setOverrides] = useState(null);
  const [configs, setConfigs] = useState([]);
  const [busy, setBusy] = useState(false);

  const characterId = String((character && character.id) || '');

  const load = useCallback(async () => {
    if (!characterId) return;
    setStatus('loading');
    try {
      const [result, api] = await Promise.all([
        getCharacterOverridesStatus(characterId),
        getApiConfigs().catch(() => ({ configs: [] })),
      ]);
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
  const configOptions = [
    { value: '', label: t('character.overrides.followGlobal') },
    ...configs.map(item => ({ value: item.id, label: item.name || t('settings.api.unnamed') })),
  ];
  const models = (configs.find(item => item.id === current) || {}).models || [];
  const modelOptions = [
    { value: '', label: t('character.overrides.followModel') },
    ...models.map(model => ({ value: model, label: model })),
  ];
  const count = countCharacterOverrides(resolved);

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
