import React from 'react';
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
    setPluginEntryOpen,
    setTtsEntryOpen,
    setTranscriptionEntryOpen,
    imageRecognition,
    imageRecognitionApiConfigs,
    updateImageRecognition,
  } = props;
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
                <Ionicons name="pulse-outline" size={15} color={theme.colors.primarySoft} />
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
