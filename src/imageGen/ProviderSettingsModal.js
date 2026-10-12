import React from 'react';
import { Modal, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel, TextField } from '../ui/index.js';
import { providerRequiresApiKey } from './providers.js';

// 生图服务商配置弹层：纯展示组件，状态与保存编排仍留在 ImageGenScreen。
// 依赖全部经 props 注入，渲染树与拆分前逐字一致。
export default function ProviderSettingsModal({
  visible,
  onClose,
  styles,
  theme,
  t,
  provider,
  draftBaseUrl,
  setDraftBaseUrl,
  draftApiKey,
  setDraftApiKey,
  draftModel,
  setDraftModel,
  draftExtra,
  setDraftExtra,
  detecting,
  detectProvider,
  openApiKeyUrl,
  confirmSettings,
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>{t('imageGen.providerSettings', { label: t(provider.labelKey) })}</Text>
          <FieldHint style={styles.hint}>{t('imageGen.keyLocalHint')}</FieldHint>
          {provider.keyHintKey ? (
            <FieldHint style={styles.hint}>{t('imageGen.keyHint', { hint: t(provider.keyHintKey) })}</FieldHint>
          ) : null}
          {provider.corsNoteKey ? (
            <FieldHint style={styles.hint}>
              {t('imageGen.corsNote', { note: t(provider.corsNoteKey) })}
            </FieldHint>
          ) : null}
          <FieldLabel style={styles.label}>{t('imageGen.apiAddressLabel')}</FieldLabel>
          <TextField
            value={draftBaseUrl}
            onChangeText={setDraftBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={provider.baseUrlPlaceholder || provider.baseUrl || 'https://example.com/v1/images'}
          />
          {providerRequiresApiKey(provider) ? (
            <>
              <FieldLabel style={styles.label}>API Key</FieldLabel>
              <TextField
                value={draftApiKey}
                onChangeText={setDraftApiKey}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                placeholder="sk-..."
              />
              <TouchableOpacity
                style={[styles.selectButton, styles.apiKeyButton]}
                onPress={openApiKeyUrl}
                activeOpacity={0.8}
              >
                <Ionicons name="open-outline" size={16} color={theme.colors.textMuted} />
                <Text style={styles.selectButtonText}>{t('imageGen.getApiKey')}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <FieldHint style={styles.hint}>{t('imageGen.localNoKeyHint')}</FieldHint>
          )}
          <FieldLabel style={styles.label}>{t('imageGen.modelNameLabel')}</FieldLabel>
          <TextField
            value={draftModel}
            onChangeText={setDraftModel}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={provider.defaultModel || t('imageGen.modelNamePlaceholder')}
          />
          <TouchableOpacity
            style={[styles.selectButton, styles.detectButton, detecting && styles.generateButtonDisabled]}
            onPress={detectProvider}
            disabled={detecting}
            activeOpacity={0.8}
          >
            <Ionicons name="pulse-outline" size={16} color={theme.colors.textMuted} />
            <Text style={styles.selectButtonText}>{detecting ? t('imageGen.detecting') : t('imageGen.detectConnectivity')}</Text>
          </TouchableOpacity>
          <FieldLabel style={styles.label}>{t('imageGen.extraLabel')}</FieldLabel>
          <TextField
            style={styles.extraInput}
            value={draftExtra}
            onChangeText={setDraftExtra}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            placeholder='{"quality":"hd"}'
          />
          <View style={styles.modalActions}>
            <TouchableOpacity
              style={[styles.selectButton, styles.selectButtonGhost]}
              onPress={onClose}
              activeOpacity={0.8}
            >
              <Text style={styles.selectButtonText}>{t('imageGen.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.selectButton} onPress={confirmSettings} activeOpacity={0.8}>
              <Text style={styles.selectButtonText}>{t('imageGen.save')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
