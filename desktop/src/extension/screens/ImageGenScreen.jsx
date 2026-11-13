// 图像生成（桌面）：配置生图服务商 → 写提示词 → 生成图片 → 存到 documents/images 或另存。
//
// 复用共享层：
//   · imageGen/index.js 的 generateImage —— 全部端点/载荷/解析/错误映射都在这里；
//   · storage/settings/imageGen.js —— 设置读写（含「读坏拒绝写」守卫）；
//   · imageGen/providers.js —— 服务商清单与各自的 baseUrl/model 约束。
//
// 与手机的平台差异：
//   · 手机把结果写进相册；桌面写到 documents/chat-images/（媒体协议可读）并提供「另存为」；
//   · 参考图（i2i）在手机上来自相册，桌面走 media.pick。
import { useEffect, useMemo, useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import { generateImage } from '../../../../src/imageGen/index.js';
import { IMAGE_PROVIDERS, getImageProvider } from '../../../../src/imageGen/providers.js';
import {
  getImageGenSettings,
  saveImageGenSettings,
} from '../../../../src/storage/settings/imageGen.js';
import { markMediaWrite } from '../../../../src/storage/mediaProtection.js';
import { Alert } from '../../platform/alert.js';
import { getBridge } from '../../platform/bridge.js';
import { documentDirectory } from '../../platform/fileSystem.js';
import { mediaUrl } from '../../platform/mediaUrl.js';
import { Button, Card, Field, Row, Select, TextInput } from '../../settings/ui.jsx';

export default function ImageGenScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getImageGenSettings()
      .then(value => { if (!cancelled) setSettings(value); })
      .catch(() => { if (!cancelled) setSettings({ activeProvider: '', providers: {} }); })
      .then(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const providerId = settings ? settings.activeProvider : '';
  const provider = useMemo(
    () => (providerId ? getImageProvider(providerId) : null),
    [providerId]
  );
  const config = (settings && settings.providers && settings.providers[providerId]) || {};

  const patchProvider = patch => {
    setSettings(current => {
      if (!current) return current;
      const providerConfig = current.providers[providerId] || {};
      return {
        ...current,
        providers: {
          ...current.providers,
          [providerId]: { ...providerConfig, ...patch },
        },
      };
    });
  };

  const persist = async () => {
    if (!settings) return;
    try {
      const saved = await saveImageGenSettings(settings);
      setSettings(saved);
      Alert.alert(t('settings.api.saved.title'), t('settings.api.saved.body'));
    } catch (error2) {
      // 读坏时守卫会抛错：必须如实告知，不能假装保存成功。
      Alert.alert(t('settings.api.saved.title'), t('error.storage.imageGenSettingsReadFailed') || String(error2 && error2.message));
    }
  };

  const pickReference = async () => {
    const picked = await getBridge().media.pick('image');
    const item = picked && !picked.canceled && Array.isArray(picked.items) ? picked.items[0] : null;
    if (!item) return;
    const ext = (String(item.uri || '').split('.').pop() || 'png').slice(0, 5);
    const destination = `${documentDirectory}chat-images/ref-${Date.now()}.${ext}`;
    try {
      await getBridge().fs.copy(item.uri, destination);
      markMediaWrite(destination);
      setReference(destination);
    } catch (error) {
      Alert.alert(t('character.edit.alert.readImageFailed.title'), t('character.edit.alert.readImageFailed.body'));
    } finally {
      getBridge().fs.delete(item.uri, true).catch(() => {});
    }
  };

  const [reference, setReference] = useState('');

  const run = async () => {
    if (busy) return;
    if (!provider) {
      Alert.alert(t('imageGen.title'), t('imageGen.pickService'));
      return;
    }
    if (!String(prompt || '').trim() && !reference) {
      Alert.alert(t('imageGen.title'), t('error.imageGen.promptRequired') || t('imageGen.promptLabel'));
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const generated = await generateImage({
        provider,
        config,
        prompt: String(prompt || '').trim(),
        imageUri: reference || undefined,
        model: config.model || undefined,
        size: size || undefined,
      });
      // generateImage 返回 { images: [{ base64 | url }], ... } 形状由共享层决定；
      // 这里只取第一张，落盘后统一走 mediaUrl 渲染。
      const first = Array.isArray(generated && generated.images) ? generated.images[0] : null;
      const raw = first && (first.base64 || first.data || first.url);
      if (!raw) throw new Error(t('common.error.retryLater'));
      const destination = `${documentDirectory}chat-images/gen-${Date.now()}.png`;
      if (/^https?:/i.test(String(raw))) {
        await getBridge().fs.download(String(raw), destination);
      } else {
        const base64 = String(raw).replace(/^data:[^;]+;base64,/, '');
        await getBridge().fs.write(destination, base64, 'base64');
      }
      markMediaWrite(destination);
      setResult(destination);
    } catch (error3) {
      setError(String((error3 && error3.message) || error3));
    } finally {
      setBusy(false);
    }
  };

  const saveAs = async () => {
    if (!result) return;
    try {
      await getBridge().backup.saveAs(
        result,
        `image-${Date.now()}.png`,
        [{ name: 'PNG', extensions: ['png'] }]
      );
    } catch (error) {
      Alert.alert(t('chat.send.fail.title'), t('common.error.retryLater'));
    }
  };

  const providerOptions = IMAGE_PROVIDERS.map(item => ({ value: item.id, label: item.label || item.id }));

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card title={t('imageGen.title')} hint={t('imageGen.pickService')} palette={palette} fonts={fonts}>
        {loading ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>{t('backup.progress.ratio')}</div>
        ) : (
          <>
            <Field label={t('imageGen.pickService')} palette={palette} fonts={fonts}>
              <Select
                value={providerId}
                options={providerOptions}
                onChange={value => setSettings(current => ({ ...current, activeProvider: value }))}
                palette={palette}
                fonts={fonts}
              />
            </Field>
            {provider ? (
              <>
                {provider.baseUrlPlaceholder ? (
                  <Field label={t('settings.api.baseUrl')} hint={provider.baseUrlPlaceholder} palette={palette} fonts={fonts}>
                    <TextInput
                      value={config.baseUrl || ''}
                      onChange={value => patchProvider({ baseUrl: value })}
                      placeholder={provider.baseUrlPlaceholder}
                      palette={palette}
                      fonts={fonts}
                    />
                  </Field>
                ) : null}
                <Field label={t('settings.vector.apiKey')} palette={palette} fonts={fonts}>
                  <TextInput
                    value={config.apiKey || ''}
                    onChange={value => patchProvider({ apiKey: value })}
                    type="password"
                    palette={palette}
                    fonts={fonts}
                  />
                </Field>
                <Field label={t('imageGen.modelLabel')} palette={palette} fonts={fonts}>
                  <TextInput
                    value={config.model || ''}
                    onChange={value => patchProvider({ model: value })}
                    placeholder={provider.defaultModel || ''}
                    palette={palette}
                    fonts={fonts}
                  />
                </Field>
                <Row>
                  <Button
                    label={t('common.save')}
                    onClick={persist}
                    palette={palette}
                    fonts={fonts}
                    primary
                  />
                </Row>
              </>
            ) : null}
          </>
        )}
      </Card>

      <Card title={t('imageGen.promptLabel')} palette={palette} fonts={fonts}>
        <TextInput
          value={prompt}
          onChange={setPrompt}
          placeholder={t('imageGen.promptPlaceholder')}
          palette={palette}
          fonts={fonts}
        />
        <Row>
          <div style={{ width: 120 }}>
            <TextInput
              value={size}
              onChange={setSize}
              placeholder={t('imageGen.sizeLabel')}
              palette={palette}
              fonts={fonts}
            />
          </div>
          <Button label={t('imageGen.pickImage')} onClick={pickReference} palette={palette} fonts={fonts} />
          {reference ? (
            <Button label={t('character.fields.image.clear')} onClick={() => setReference('')} palette={palette} fonts={fonts} />
          ) : null}
        </Row>
        {reference ? (
          <img
            src={mediaUrl(reference) || ''}
            alt=""
            style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 8, border: `1px solid ${palette.divider}` }}
          />
        ) : null}
        <Row>
          <Button
            label={busy ? t('backup.progress.ratio') : t('imageGen.generate')}
            onClick={run}
            palette={palette}
            fonts={fonts}
            primary
            disabled={busy}
          />
        </Row>
        {error ? (
          <div style={{ fontSize: fonts.scaled(11), color: palette.danger || '#ff5a5f', lineHeight: 1.6, wordBreak: 'break-word' }}>
            {error}
          </div>
        ) : null}
      </Card>

      {result ? (
        <Card title={t('imageGen.title')} palette={palette} fonts={fonts}>
          <img
            src={mediaUrl(result) || ''}
            alt=""
            style={{ maxWidth: '100%', borderRadius: 10, border: `1px solid ${palette.divider}` }}
          />
          <Row>
            <Button label={t('chat.bubble.saveImage')} onClick={saveAs} palette={palette} fonts={fonts} primary />
          </Row>
        </Card>
      ) : null}
    </div>
  );
}