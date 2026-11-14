// 自动配图与表情包设置（桌面）：对应手机 settings/sections/ExtensionsSection 里
// 「内联图片」+「表情包」两块。此前桌面把它们整块漏掉了（注释把 extensions 节误当成
// 顶栏的「扩展」tab），导致自动配图开关恒为 false、配图永远不生成。
//
// 数据与判定全部复用共享层：
//   · storage/settings/chatOptions —— getInlineImageSettings / saveInlineImageSettings
//     （normalize 会把越界值夹回合法区间）、stickerChance / stickerPosition 的 normalize；
//   · imageGen/providers —— 供应商清单与默认模型；
//   · imageGen/inlineImagePrompt —— 位置选项与「取哪一段」的语义。
// 本卡片只做表单与写回，不重写任何判定。
import { useEffect, useState } from 'react';

import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { IMAGE_PROVIDERS, getImageProvider } from '../../../src/imageGen/providers.js';
import { INLINE_IMAGE_POSITIONS } from '../../../src/imageGen/inlineImagePrompt.js';
import { getImageGenSettings } from '../../../src/storage/settings/imageGen.js';
import {
  getChatOptions,
  getInlineImageSettings,
  saveChatOptions,
  saveInlineImageSettings,
} from '../../../src/storage/settings/chatOptions.js';
import { normalizeStickerChance, normalizeStickerPosition } from '../../../src/chat/stickerPolicy.js';
import { Alert } from '../platform/alert.js';
import { Card, Field, Row, Select, TextInput, Toggle } from './ui.jsx';

// 与手机 STICKER_CHANCE_OPTIONS 同档位。
const STICKER_CHANCES = ['0', '0.25', '0.5', '0.75', '1'];
const STICKER_POSITIONS = ['below', 'above'];

export default function InlineImageCard({ palette, fonts }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState({});
  const [options, setOptions] = useState(null);
  // 自己读设置：设置页与聊天页是两个独立组件，共享的是**存储**而不是 state。
  // 聊天页的 hook 在切回聊天时会重新读（useDesktopInlineImage 的 reload），
  // 所以这里写完不需要通知它。
  const [settings, setSettings] = useState(null);

  // 已配置的供应商（决定能否开启：没配的生图服务开了也只会失败）。
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getImageGenSettings().catch(() => ({ providers: {} })),
      getChatOptions().catch(() => null),
      getInlineImageSettings().catch(() => null),
    ]).then(([gen, chat, inline]) => {
      if (cancelled) return;
      setConfigured((gen && gen.providers) || {});
      setOptions(chat || null);
      setSettings(inline || null);
    });
    return () => { cancelled = true; };
  }, []);

  const persist = async patch => {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await saveInlineImageSettings({ ...(settings || {}), ...patch });
      setSettings(saved || { ...(settings || {}), ...patch });
    } catch (error) {
      Alert.alert(t('app.save.failed.title'), t('app.save.failed.body'));
    } finally {
      setBusy(false);
    }
  };

  const persistOption = async patch => {
    if (busy || !options) return;
    setBusy(true);
    try {
      const next = { ...options, ...patch };
      const saved = await saveChatOptions(next);
      setOptions({ ...next, ...(saved || {}) });
    } catch (error) {
      Alert.alert(t('app.save.failed.title'), t('app.save.failed.body'));
    } finally {
      setBusy(false);
    }
  };

  const providerOptions = [
    { value: '', label: t('settings.inlineImage.noneSelected') },
    ...IMAGE_PROVIDERS.map(item => ({ value: item.id, label: t(item.labelKey) })),
  ];
  const positionOptions = INLINE_IMAGE_POSITIONS.map(value => ({
    value,
    label: t(`settings.inlineImage.position.${value}`),
  }));
  const activeProvider = settings && settings.providerId ? getImageProvider(settings.providerId) : null;
  const activeConfigured = Boolean(
    activeProvider && configured[activeProvider.id]
    && String((configured[activeProvider.id] || {}).baseUrl || activeProvider.baseUrl || '').trim()
  );

  return (
    <Card
      title={t('settings.inlineImage.title')}
      hint={t('settings.inlineImage.hint')}
      palette={palette}
      fonts={fonts}
    >
      <Row>
        <Toggle
          checked={settings ? settings.enabled === true : false}
          onChange={value => {
            // 开启前要求已选且已配好供应商：否则每条回复都会静默失败一次。
            if (value && (!settings || !settings.providerId || !activeConfigured)) {
              Alert.alert(t('chat.inlineImage.noProvider.title'), t('chat.inlineImage.noProvider.pick'));
              return;
            }
            persist({ enabled: value });
          }}
          label={t('settings.inlineImage.settings')}
          palette={palette}
          fonts={fonts}
          disabled={busy || !settings}
        />
      </Row>

      <Field
        label={t('settings.inlineImage.provider')}
        hint={activeProvider
          ? t('settings.inlineImage.currentProvider')
          : t('settings.inlineImage.noneSelected')}
        palette={palette}
        fonts={fonts}
      >
        <Select
          value={settings ? String(settings.providerId || '') : ''}
          options={providerOptions}
          onChange={value => persist({ providerId: value })}
          palette={palette}
          fonts={fonts}
          disabled={busy || !settings}
        />
      </Field>

      {activeProvider ? (
        <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
          {activeConfigured
            ? t('settings.inlineImage.metaConfigured', {
              model: String((configured[activeProvider.id] || {}).model || activeProvider.defaultModel || '')
                .split(/[\n,]/)[0] || t('settings.inlineImage.defaultModel'),
            })
            : t('settings.inlineImage.metaNotConfigured')}
        </div>
      ) : null}

      <Field label={t('settings.inlineImage.positionLabel')} palette={palette} fonts={fonts}>
        <Select
          value={settings ? String(settings.imagePosition || 'end') : 'end'}
          options={positionOptions}
          onChange={value => persist({ imagePosition: value })}
          palette={palette}
          fonts={fonts}
          disabled={busy || !settings}
        />
      </Field>

      <Field label={t('settings.inlineImage.stylePrefix')} palette={palette} fonts={fonts}>
        <TextInput
          value={settings ? String(settings.stylePrefix || '') : ''}
          onChange={value => persist({ stylePrefix: value })}
          placeholder={t('settings.inlineImage.stylePrefixPlaceholder')}
          palette={palette}
          fonts={fonts}
          disabled={busy}
        />
      </Field>

      <Field label={t('settings.inlineImage.size')} palette={palette} fonts={fonts}>
        <TextInput
          value={settings ? String(settings.size || '') : ''}
          onChange={value => persist({ size: value })}
          palette={palette}
          fonts={fonts}
          disabled={busy}
        />
      </Field>

      <Field label={t('settings.inlineImage.maxPromptChars')} palette={palette} fonts={fonts}>
        <TextInput
          value={settings ? String(settings.maxPromptChars || '') : ''}
          onChange={value => persist({ maxPromptChars: value })}
          palette={palette}
          fonts={fonts}
          disabled={busy}
        />
      </Field>

      <Row>
        <Toggle
          checked={settings ? settings.enhance === true : false}
          onChange={value => persist({ enhance: value })}
          label={t('settings.inlineImage.enhance')}
          palette={palette}
          fonts={fonts}
          disabled={busy || !settings}
        />
      </Row>
      <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
        {t('settings.inlineImage.enhanceHint')}
      </div>

      {/* ---- 表情包：概率与相对文字的位置（与手机同档位） ---- */}
      <div style={{ borderTop: `1px solid ${palette.divider}`, paddingTop: 10, marginTop: 4 }}>
        <div style={{ fontSize: fonts.scaled(12), fontWeight: 700 }}>{t('chat.sticker.title')}</div>
        <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
          {t('settings.sticker.hint')}
        </div>
        <Row>
          <Toggle
            checked={options ? options.stickerEnabled === true : false}
            onChange={value => persistOption({ stickerEnabled: value })}
            label={t('settings.sticker.enable')}
            palette={palette}
            fonts={fonts}
            disabled={busy || !options}
          />
        </Row>

        <Field label={t('settings.sticker.chanceLabel')} palette={palette} fonts={fonts}>
          <Select
            value={String(options ? normalizeStickerChance(options.stickerChance) : '0')}
            // 值与 STICKER_CHANCE_OPTIONS 一致：'0' 就是「从不」。
            options={STICKER_CHANCES.map(value => ({
              value,
              label: t(value === '0' ? 'settings.sticker.chance.never'
                : value === '0.25' ? 'settings.sticker.chance.low'
                  : value === '0.5' ? 'settings.sticker.chance.half'
                    : value === '0.75' ? 'settings.sticker.chance.high'
                      : 'settings.sticker.chance.always'),
            }))}
            onChange={value => persistOption({ stickerChance: value })}
            palette={palette}
            fonts={fonts}
            disabled={busy || !options}
          />
        </Field>

        <Field label={t('settings.sticker.positionLabel')} palette={palette} fonts={fonts}>
          <Select
            value={String(options ? normalizeStickerPosition(options.stickerPosition) : 'below')}
            options={STICKER_POSITIONS.map(value => ({
              value,
              label: t(`settings.sticker.position.${value}`),
            }))}
            onChange={value => persistOption({ stickerPosition: value })}
            palette={palette}
            fonts={fonts}
            disabled={busy || !options}
          />
        </Field>
      </div>
    </Card>
  );
}