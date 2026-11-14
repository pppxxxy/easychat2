// 聊天体验卡：流式、全宽、富 HTML、草稿、时间感知、自动压缩、思考展示、气泡风格、
// 图片下载、表情包开关。字段与共享层 normalizeChatOptions 一一对应。
//
// 思考展示（thinkingDisplay）不在 chatOptions 里，它是 thinking 设置的一个字段
// （getThinkingSettings/saveThinkingSettings），这里单独读写，避免把两个键混在一起。
import { useEffect, useRef, useState } from 'react';

import {
  getChatOptions,
  getThinkingSettings,
  saveChatOptions,
  saveThinkingSettings,
} from '../../../src/storage/settings.js';
import { THINKING_DISPLAYS } from '../../../src/storage/settings/thinking.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import { Button, Card, Field, Row, Select, Toggle } from './ui.jsx';

const BUBBLE_STYLES = ['rounded', 'card', 'plain'];
const THINKING_LABELS = {
  open: 'settings.global.thinkingDisplay.open',
  fold: 'settings.global.thinkingDisplay.fold',
  off: 'settings.global.thinkingDisplay.closed',
};
const BUBBLE_LABELS = {
  rounded: 'settings.global.bubble.rounded',
  card: 'settings.global.bubble.card',
  plain: 'settings.global.bubble.plain',
};

export default function ChatOptionsCard({ palette, fonts }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [options, setOptions] = useState(null);
  const [thinkingDisplay, setThinkingDisplay] = useState('fold');
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    getChatOptions()
      .then(value => { if (mountedRef.current) setOptions(value); })
      .catch(() => {});
    getThinkingSettings()
      .then(value => { if (mountedRef.current) setThinkingDisplay(value.display); })
      .catch(() => {});
    return () => { mountedRef.current = false; };
  }, []);

  const patch = next => setOptions(current => (current ? { ...current, ...next } : current));

  const save = async () => {
    if (!options || saving) return;
    setSaving(true);
    try {
      const saved = await saveChatOptions(options);
      // 思考展示单独落盘（同一个「保存」按钮，但走 thinking 键）。
      const currentThinking = await getThinkingSettings();
      await saveThinkingSettings({ ...currentThinking, display: thinkingDisplay });
      if (mountedRef.current) {
        setOptions(saved);
        Alert.alert(tRef.current('settings.api.saved.title'), tRef.current('settings.api.saved.body'));
      }
    } catch (error) {
      if (mountedRef.current) {
        Alert.alert(tRef.current('common.error.saveFailed'), tRef.current('common.error.storageOrPermission'));
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <Card title={t('settings.global.title')} palette={palette} fonts={fonts}>
      {!options ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
      ) : (
        <>
          <Toggle
            checked={options.streaming}
            onChange={value => patch({ streaming: value })}
            label={t('settings.global.streaming')}
            palette={palette}
            fonts={fonts}
          />
          <Toggle
            checked={options.fullWidth}
            onChange={value => patch({ fullWidth: value })}
            label={t('settings.global.fullWidth')}
            palette={palette}
            fonts={fonts}
          />
          <Toggle
            checked={options.richHtml}
            onChange={value => patch({ richHtml: value })}
            label={t('settings.global.richHtml')}
            palette={palette}
            fonts={fonts}
          />
          <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint }}>{t('settings.global.richHtmlHint')}</div>
          <Toggle
            checked={options.keepDraft}
            onChange={value => patch({ keepDraft: value })}
            label={t('settings.global.keepDraft')}
            palette={palette}
            fonts={fonts}
          />
          <Toggle
            checked={options.timeAware}
            onChange={value => patch({ timeAware: value })}
            label={t('settings.global.timeAware')}
            palette={palette}
            fonts={fonts}
          />
          <Toggle
            checked={options.autoCompact}
            onChange={value => patch({ autoCompact: value })}
            label={t('settings.global.autoCompact')}
            palette={palette}
            fonts={fonts}
          />
          <Toggle
            checked={options.downloadImage}
            onChange={value => patch({ downloadImage: value })}
            label={t('settings.downloadImage.enable')}
            palette={palette}
            fonts={fonts}
          />
          <Toggle
            checked={options.stickerEnabled}
            onChange={value => patch({ stickerEnabled: value })}
            label={t('chat.sticker.title')}
            palette={palette}
            fonts={fonts}
          />
          {/* 聊天内工具（联网搜索/抓取）：模型自主决定是否联网。
              与扩展页的「联网搜索」插件是两件事——那个是关键词命中就自动搜。
              hint 里必须保留「数据外发」说明（与手机同一份文案）。 */}
          <Toggle
            checked={options.chatTools === true}
            onChange={value => patch({ chatTools: value })}
            label={t('settings.global.chatTools')}
            palette={palette}
            fonts={fonts}
          />
          <div style={{ fontSize: fonts.scaled(10), color: palette.textFaint, lineHeight: 1.6 }}>
            {t('settings.global.chatToolsHint')}
          </div>
          <Row>
            <Field label={t('settings.global.thinkingDisplay')} palette={palette} fonts={fonts}>
              <Select
                value={thinkingDisplay}
                options={THINKING_DISPLAYS.map(value => ({ value, label: t(THINKING_LABELS[value]) }))}
                onChange={value => setThinkingDisplay(value)}
                palette={palette}
                fonts={fonts}
              />
            </Field>
            <Field label={t('settings.global.bubbleStyle')} hint={t('settings.global.bubbleHint')} palette={palette} fonts={fonts}>
              <Select
                value={options.bubbleStyle || 'rounded'}
                options={BUBBLE_STYLES.map(value => ({ value, label: t(BUBBLE_LABELS[value]) }))}
                onChange={value => patch({ bubbleStyle: value })}
                palette={palette}
                fonts={fonts}
              />
            </Field>
          </Row>
          <div>
            <Button
              label={saving ? t('backup.progress.ratio') : t('common.save')}
              onClick={save}
              palette={palette}
              fonts={fonts}
              primary
              disabled={saving}
            />
          </div>
        </>
      )}
    </Card>
  );
}