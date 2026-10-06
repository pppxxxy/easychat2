import React from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  CollapsibleSelect,
  FieldHint,
  FieldLabel,
  TextField,
} from '../../ui/index.js';
import SecretTextField from '../SecretTextField.js';
import { IMAGE_PROVIDERS } from '../../imageGen/providers.js';

const INLINE_IMAGE_POSITION_OPTIONS = [
  { value: 'start', labelKey: 'settings.inlineImage.position.start', metaKey: 'settings.inlineImage.position.startMeta' },
  { value: 'middle', labelKey: 'settings.inlineImage.position.middle', metaKey: 'settings.inlineImage.position.middleMeta' },
  { value: 'end', labelKey: 'settings.inlineImage.position.end', metaKey: 'settings.inlineImage.position.endMeta' },
];

export default function ExtensionsSection(props) {
  const {
    styles,
    theme,
    t,
    inlineImage,
    updateInlineImage,
    inlineImageProviders,
    imageGenProviders,
    activeImageProvider,
    updateImageGenProvider,
    imageGenTesting,
    testImageGenProvider,
    openApiKeyUrl,
    setPluginEntryOpen,
    setTtsEntryOpen,
    setTranscriptionEntryOpen,
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
          <FieldLabel style={styles.label}>{t('settings.inlineImage.provider')}</FieldLabel>
          <CollapsibleSelect
            label={t('settings.inlineImage.currentProvider')}
            value={inlineImage.providerId}
            options={IMAGE_PROVIDERS.map(provider => ({
              value: provider.id,
              label: provider.label,
              meta: inlineImageProviders.includes(provider.id)
                ? t('settings.inlineImage.metaConfigured', { model: String((imageGenProviders[provider.id] || {}).model || provider.defaultModel || '').split(/[\n,]/)[0] || t('settings.inlineImage.defaultModel') })
                : t('settings.inlineImage.metaNotConfigured'),
            }))}
            onSelect={id => updateInlineImage({ providerId: id })}
            placeholder={t('settings.inlineImage.noneSelected')}
          />
          {activeImageProvider ? (
            <View style={styles.providerEditor}>
              <Text style={styles.providerEditorTitle}>{t('settings.inlineImage.providerConfig', { name: activeImageProvider.label })}</Text>
              {activeImageProvider.keyHint ? (
                <FieldHint style={styles.hint}>{t('settings.inlineImage.keyHint', { hint: activeImageProvider.keyHint })}</FieldHint>
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
              {activeImageProvider.networkNote ? (
                <FieldHint style={styles.hint}>{activeImageProvider.networkNote}</FieldHint>
              ) : null}
            </View>
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
