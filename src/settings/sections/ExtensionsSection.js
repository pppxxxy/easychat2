import React, { useState } from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  CollapsibleSection,
  CollapsibleSelect,
  FieldHint,
  FieldLabel,
  TextField,
} from '../../ui/index.js';
import SecretTextField from '../SecretTextField.js';
import { IMAGE_PROVIDERS } from '../../imageGen/providers.js';
import ImageRecognitionCard from './ImageRecognitionCard.js';
import ToolVisibilityCard from './ToolVisibilityCard.js';

const INLINE_IMAGE_POSITION_OPTIONS = [
  { value: 'start', labelKey: 'settings.inlineImage.position.start', metaKey: 'settings.inlineImage.position.startMeta' },
  { value: 'middle', labelKey: 'settings.inlineImage.position.middle', metaKey: 'settings.inlineImage.position.middleMeta' },
  { value: 'end', labelKey: 'settings.inlineImage.position.end', metaKey: 'settings.inlineImage.position.endMeta' },
];

// 表情包概率档位（0~1）与相对文字的位置。
const STICKER_CHANCE_OPTIONS = [
  { value: '0', labelKey: 'settings.sticker.chance.never' },
  { value: '0.25', labelKey: 'settings.sticker.chance.low' },
  { value: '0.5', labelKey: 'settings.sticker.chance.half' },
  { value: '0.75', labelKey: 'settings.sticker.chance.high' },
  { value: '1', labelKey: 'settings.sticker.chance.always' },
];
const STICKER_POSITION_OPTIONS = [
  { value: 'below', labelKey: 'settings.sticker.position.below' },
  { value: 'above', labelKey: 'settings.sticker.position.above' },
];

export default function ExtensionsSection(props) {
  const {
    styles,
    theme,
    t,
    configs,
    inlineImage,
    updateInlineImage,
    inlineImageProviders,
    imageGenProviders,
    activeImageProvider,
    updateImageGenProvider,
    imageGenTesting,
    testImageGenProvider,
    openApiKeyUrl,
    chatOptions,
    updateChatOption,
    // 图片下载来源（2026-10-21）：父级持有名单与持久化，本组件只管表单与列表。
    imageDownloadSources = [],
    addImageDownloadSource,
    removeImageDownloadSource,
    setPluginEntryOpen,
    setTtsEntryOpen,
    setTranscriptionEntryOpen,
    imageRecognition,
    imageRecognitionApiConfigs,
    updateImageRecognition,
  } = props;

  // 图片来源表单（本地草稿；提交成功才清空）。错误文案按原因区分：
  // invalid=规格不对（含纯 IP/通配符）、limit=超出上限、storage=读写失败。
  const [sourceHost, setSourceHost] = useState('');
  const [sourceReferer, setSourceReferer] = useState('');
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceError, setSourceError] = useState('');

  const submitImageSource = async () => {
    if (sourceBusy) return;
    const host = String(sourceHost || '').trim();
    if (!host) {
      setSourceError(t('settings.downloadImage.sources.invalid'));
      return;
    }
    setSourceBusy(true);
    setSourceError('');
    let result = null;
    try {
      result = await addImageDownloadSource({ host, referer: sourceReferer });
    } catch (error) {
      result = { ok: false, reason: 'storage' };
    }
    setSourceBusy(false);
    if (result && result.ok) {
      setSourceHost('');
      setSourceReferer('');
      return;
    }
    const reason = result && result.reason;
    setSourceError(
      reason === 'limit'
        ? t('settings.downloadImage.sources.limit')
        : (reason === 'invalid'
          ? t('settings.downloadImage.sources.invalid')
          : t('settings.downloadImage.sources.failed'))
    );
  };

  const removeImageSource = async host => {
    if (sourceBusy) return;
    setSourceBusy(true);
    try {
      await removeImageDownloadSource(host);
    } catch (error) {
      // 失败静默：列表会保持原样（父级读回真实名单）。
    }
    setSourceBusy(false);
  };

  return (
    <>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="sparkles-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.inlineImage.auto')}</Text>
            </View>
            <Switch
              value={inlineImage.enabled}
              onValueChange={value => updateInlineImage({ enabled: value })}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          {/* 配图参数收进折叠区（2026-10-11）：这 8 项常驻展开时会把下面的「联网搜索 /
              语音播报 / 语音转文字」推到一屏之外，用户找它们得先翻完整个配图设置。
              开关留在行上（状态一眼可见、常用），参数默认收起。
              （内层沿用原缩进，避免 100+ 行纯缩进噪声淹没真正的改动。） */}
          <CollapsibleSection
            title={t('settings.inlineImage.settings')}
            icon="options-outline"
            defaultOpen={false}
          >
          <FieldLabel style={styles.label}>{t('settings.inlineImage.provider')}</FieldLabel>
          <CollapsibleSelect
            label={t('settings.inlineImage.currentProvider')}
            value={inlineImage.providerId}
            options={IMAGE_PROVIDERS.map(provider => ({
              value: provider.id,
              label: t(provider.labelKey),
              meta: inlineImageProviders.includes(provider.id)
                ? t('settings.inlineImage.metaConfigured', { model: String((imageGenProviders[provider.id] || {}).model || provider.defaultModel || '').split(/[\n,]/)[0] || t('settings.inlineImage.defaultModel') })
                : t('settings.inlineImage.metaNotConfigured'),
            }))}
            onSelect={id => updateInlineImage({ providerId: id })}
            placeholder={t('settings.inlineImage.noneSelected')}
          />
          {activeImageProvider ? (
            <View style={styles.providerEditor}>
              <Text style={styles.providerEditorTitle}>{t('settings.inlineImage.providerConfig', { name: t(activeImageProvider.labelKey) })}</Text>
              {activeImageProvider.keyHintKey ? (
                <FieldHint style={styles.hint}>{t('settings.inlineImage.keyHint', { hint: t(activeImageProvider.keyHintKey) })}</FieldHint>
              ) : null}
              <FieldLabel style={styles.label}>{t('settings.api.baseUrl')}</FieldLabel>
              <TextField
                value={String((imageGenProviders[activeImageProvider.id] || {}).baseUrl || '')}
                onChangeText={text => updateImageGenProvider(activeImageProvider.id, { baseUrl: text })}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={activeImageProvider.baseUrlPlaceholder || activeImageProvider.baseUrl || 'https://example.com/v1/images/generations'}
              />
              <FieldLabel style={styles.label}>API Key</FieldLabel>
              <SecretTextField
                value={String((imageGenProviders[activeImageProvider.id] || {}).apiKey || '')}
                onChangeText={text => updateImageGenProvider(activeImageProvider.id, { apiKey: text })}
                placeholder="sk-..."
                theme={theme}
                styles={styles}
              />
              {activeImageProvider.apiKeyUrl ? (
                <TouchableOpacity
                  style={styles.apiKeyLinkRow}
                  onPress={() => openApiKeyUrl(activeImageProvider.apiKeyUrl)}
                  activeOpacity={0.7}
                  accessibilityRole="link"
                >
                  <Text style={styles.apiKeyLink}>{t('settings.api.getKey')}</Text>
                </TouchableOpacity>
              ) : null}
              <FieldLabel style={styles.label}>{t('settings.inlineImage.modelLabel')}</FieldLabel>
              <TextField
                value={String((imageGenProviders[activeImageProvider.id] || {}).model || '')}
                onChangeText={text => updateImageGenProvider(activeImageProvider.id, { model: text })}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={activeImageProvider.defaultModel || t('settings.inlineImage.modelPlaceholder')}
              />
              <TouchableOpacity
                style={[styles.detectButton, imageGenTesting === activeImageProvider.id && styles.buttonDisabled]}
                onPress={() => testImageGenProvider(activeImageProvider)}
                disabled={imageGenTesting === activeImageProvider.id}
                activeOpacity={0.8}
              >
                <Ionicons name="pulse-outline" size={15} color={theme.colors.accentText} />
                <Text style={styles.detectButtonText}>
                  {imageGenTesting === activeImageProvider.id ? t('common.detecting') : t('settings.inlineImage.test')}
                </Text>
              </TouchableOpacity>
              {activeImageProvider.networkNoteKey ? (
                <FieldHint style={styles.hint}>{t(activeImageProvider.networkNoteKey)}</FieldHint>
              ) : null}
            </View>
          ) : null}
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="sparkles" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.inlineImage.enhance')}</Text>
            </View>
            <Switch
              value={inlineImage.enhance === true}
              onValueChange={value => updateInlineImage({ enhance: value })}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <FieldHint style={styles.hint}>{t('settings.inlineImage.enhanceHint')}</FieldHint>
          {inlineImage.enhance === true ? (
            <>
              <FieldLabel style={styles.label}>{t('settings.inlineImage.enhanceApi')}</FieldLabel>
              <CollapsibleSelect
                label={t('settings.inlineImage.enhanceApiLabel')}
                value={String(inlineImage.enhanceConfigId || '')}
                options={configs.map(item => ({
                  value: item.id,
                  label: item.name || t('settings.api.unnamed'),
                  meta: `${item.baseUrl || ''} · ${item.activeModel || ''}`,
                }))}
                onSelect={value => updateInlineImage({ enhanceConfigId: value })}
                placeholder={t('settings.inlineImage.enhanceApiDefault')}
                emptyHint={t('settings.api.emptyHint')}
              />
            </>
          ) : null}
          <FieldLabel style={styles.label}>{t('settings.inlineImage.position')}</FieldLabel>
          <CollapsibleSelect
            label={t('settings.inlineImage.positionLabel')}
            value={inlineImage.imagePosition}
            options={INLINE_IMAGE_POSITION_OPTIONS.map(option => ({
              ...option,
              label: t(option.labelKey),
              meta: t(option.metaKey),
            }))}
            onSelect={value => updateInlineImage({ imagePosition: value })}
            placeholder={t('settings.inlineImage.position.endShort')}
          />
          <FieldHint style={styles.hint}>
            {t('settings.inlineImage.hint')}
          </FieldHint>
          <FieldLabel style={styles.label}>{t('settings.inlineImage.stylePrefix')}</FieldLabel>
          <TextField
            value={inlineImage.stylePrefix}
            onChangeText={text => updateInlineImage({ stylePrefix: text })}
            placeholder={t('settings.inlineImage.stylePrefixPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <FieldLabel style={styles.label}>{t('settings.inlineImage.size')}</FieldLabel>
          <TextField
            value={inlineImage.size}
            onChangeText={text => updateInlineImage({ size: text })}
            placeholder="832*1216"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <FieldLabel style={styles.label}>{t('settings.inlineImage.maxPromptChars')}</FieldLabel>
          <TextField
            value={String(inlineImage.maxPromptChars)}
            onChangeText={text => updateInlineImage({ maxPromptChars: text.replace(/[^0-9]/g, '') })}
            keyboardType="number-pad"
            placeholder="400"
          />
          <Text style={styles.fieldHint}>{t('settings.inlineImage.keyNote')}</Text>
          </CollapsibleSection>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="download-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.downloadImage.enable')}</Text>
            </View>
            <Switch
              value={!!(chatOptions && chatOptions.downloadImage === true)}
              onValueChange={value => updateChatOption('downloadImage', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <FieldHint style={styles.hint}>{t('settings.downloadImage.hint')}</FieldHint>
          {/* 图片来源名单：空 = 不限制（旧行为）；非空 = 只允许名单内站点。
              引用页用于防盗链站点（pixiv 等必须带 Referer 才下载得下来）。 */}
          <CollapsibleSection
            title={t('settings.downloadImage.sources.title')}
            icon="link-outline"
            count={Array.isArray(imageDownloadSources) ? imageDownloadSources.length : 0}
            defaultOpen={false}
          >
            <FieldHint style={styles.hint}>{t('settings.downloadImage.sources.hint')}</FieldHint>
            {Array.isArray(imageDownloadSources) && imageDownloadSources.length > 0 ? (
              imageDownloadSources.map(source => (
                <View key={source.host} style={styles.capabilityRow}>
                  <View style={styles.linkLeft}>
                    <Ionicons name="globe-outline" size={16} color={theme.colors.primaryMuted} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.linkText}>{source.host}</Text>
                      {source.referer ? (
                        <Text style={styles.hint} numberOfLines={1}>
                          {t('settings.downloadImage.sources.refererMeta', { referer: source.referer })}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                  <TouchableOpacity
                    onPress={() => removeImageSource(source.host)}
                    disabled={sourceBusy}
                    accessibilityLabel={t('settings.downloadImage.sources.remove', { host: source.host })}
                    style={{ paddingHorizontal: 6, paddingVertical: 4 }}
                  >
                    <Ionicons name="trash-outline" size={16} color={theme.colors.danger || theme.colors.textFaint} />
                  </TouchableOpacity>
                </View>
              ))
            ) : (
              <FieldHint style={styles.hint}>{t('settings.downloadImage.sources.empty')}</FieldHint>
            )}
            <FieldLabel style={styles.label}>{t('settings.downloadImage.sources.hostLabel')}</FieldLabel>
            <TextField
              value={sourceHost}
              onChangeText={setSourceHost}
              placeholder={t('settings.downloadImage.sources.hostPlaceholder')}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <FieldLabel style={styles.label}>{t('settings.downloadImage.sources.refererLabel')}</FieldLabel>
            <TextField
              value={sourceReferer}
              onChangeText={setSourceReferer}
              placeholder={t('settings.downloadImage.sources.refererPlaceholder')}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <FieldHint style={styles.hint}>{t('settings.downloadImage.sources.refererHint')}</FieldHint>
            {sourceError ? (
              <Text style={[styles.hint, { color: theme.colors.danger }]}>{sourceError}</Text>
            ) : null}
            <TouchableOpacity
              style={[styles.detectButton, sourceBusy && styles.buttonDisabled]}
              onPress={submitImageSource}
              disabled={sourceBusy}
              activeOpacity={0.8}
            >
              <Ionicons name="add-circle-outline" size={15} color={theme.colors.accentText} />
              <Text style={styles.detectButtonText}>
                {sourceBusy ? t('common.saving') : t('settings.downloadImage.sources.add')}
              </Text>
            </TouchableOpacity>
          </CollapsibleSection>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons name="happy-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.sticker.enable')}</Text>
            </View>
            <Switch
              value={!!(chatOptions && chatOptions.stickerEnabled === true)}
              onValueChange={value => updateChatOption('stickerEnabled', value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <FieldHint style={styles.hint}>{t('settings.sticker.hint')}</FieldHint>
          {chatOptions && chatOptions.stickerEnabled === true ? (
            <>
              <FieldLabel style={styles.label}>{t('settings.sticker.chance')}</FieldLabel>
              <CollapsibleSelect
                label={t('settings.sticker.chanceLabel')}
                value={String(chatOptions.stickerChance)}
                options={STICKER_CHANCE_OPTIONS.map(option => ({ ...option, label: t(option.labelKey) }))}
                onSelect={value => updateChatOption('stickerChance', Number(value))}
                placeholder={t('settings.sticker.chance.half')}
              />
              <FieldLabel style={styles.label}>{t('settings.sticker.position')}</FieldLabel>
              <CollapsibleSelect
                label={t('settings.sticker.positionLabel')}
                value={chatOptions.stickerPosition}
                options={STICKER_POSITION_OPTIONS.map(option => ({ ...option, label: t(option.labelKey) }))}
                onSelect={value => updateChatOption('stickerPosition', value)}
                placeholder={t('settings.sticker.position.below')}
              />
            </>
          ) : null}
          <FieldLabel style={styles.label}>{t('settings.imageRecognition.sectionTitle')}</FieldLabel>
          <ImageRecognitionCard
            styles={styles}
            theme={theme}
            t={t}
            imageRecognition={imageRecognition}
            imageRecognitionApiConfigs={imageRecognitionApiConfigs}
            updateImageRecognition={updateImageRecognition}
          />
          <FieldLabel style={styles.label}>{t('settings.toolNotice.sectionTitle')}</FieldLabel>
          <ToolVisibilityCard
            styles={styles}
            theme={theme}
            t={t}
            chatOptions={chatOptions}
            updateChatOption={updateChatOption}
          />
          <FieldLabel style={styles.label}>{t('settings.inlineImage.otherFeatures')}</FieldLabel>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setPluginEntryOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="extension-puzzle-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.global.webSearch')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setTtsEntryOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="volume-high-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.global.tts')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setTranscriptionEntryOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="mic-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.global.transcription')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
    </>
  );
}
