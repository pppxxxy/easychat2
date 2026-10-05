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
  { value: 'start', label: '开头', meta: '取回复首段' },
  { value: 'middle', label: '高潮（正中）', meta: '取回复中段' },
  { value: 'end', label: '结尾（默认）', meta: '取回复末段' },
];

export default function ExtensionsSection(props) {
  const {
    styles,
    theme,
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
              <Text style={styles.linkText}>自动配图</Text>
            </View>
            <Switch
              value={inlineImage.enabled}
              onValueChange={value => updateInlineImage({ enabled: value })}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <FieldLabel style={styles.label}>生图服务</FieldLabel>
          <CollapsibleSelect
            label="当前服务"
            value={inlineImage.providerId}
            options={IMAGE_PROVIDERS.map(provider => ({
              value: provider.id,
              label: provider.label,
              meta: inlineImageProviders.includes(provider.id)
                ? `已配置 · ${String((imageGenProviders[provider.id] || {}).model || provider.defaultModel || '').split(/[\n,]/)[0] || '默认模型'}`
                : '未配置密钥',
            }))}
            onSelect={id => updateInlineImage({ providerId: id })}
            placeholder="未选择服务"
          />
          {activeImageProvider ? (
            <View style={styles.providerEditor}>
              <Text style={styles.providerEditorTitle}>{activeImageProvider.label} 配置</Text>
              {activeImageProvider.keyHint ? (
                <FieldHint style={styles.hint}>密钥：{activeImageProvider.keyHint}</FieldHint>
              ) : null}
              <FieldLabel style={styles.label}>API 地址</FieldLabel>
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
                  <Text style={styles.apiKeyLink}>点击获取密钥 →</Text>
                </TouchableOpacity>
              ) : null}
              <FieldLabel style={styles.label}>模型名（可用逗号或换行分隔多个）</FieldLabel>
              <TextField
                value={String((imageGenProviders[activeImageProvider.id] || {}).model || '')}
                onChangeText={text => updateImageGenProvider(activeImageProvider.id, { model: text })}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={activeImageProvider.defaultModel || '模型名'}
              />
              <TouchableOpacity
                style={[styles.detectButton, imageGenTesting === activeImageProvider.id && styles.buttonDisabled]}
                onPress={() => testImageGenProvider(activeImageProvider)}
                disabled={imageGenTesting === activeImageProvider.id}
                activeOpacity={0.8}
              >
                <Ionicons name="pulse-outline" size={15} color={theme.colors.primarySoft} />
                <Text style={styles.detectButtonText}>
                  {imageGenTesting === activeImageProvider.id ? '检测中...' : '检测连通性'}
                </Text>
              </TouchableOpacity>
              {activeImageProvider.networkNote ? (
                <FieldHint style={styles.hint}>{activeImageProvider.networkNote}</FieldHint>
              ) : null}
            </View>
          ) : null}
          <FieldLabel style={styles.label}>配图位置</FieldLabel>
          <CollapsibleSelect
            label="取回复的哪一段"
            value={inlineImage.imagePosition}
            options={INLINE_IMAGE_POSITION_OPTIONS}
            onSelect={value => updateInlineImage({ imagePosition: value })}
            placeholder="结尾"
          />
          <FieldHint style={styles.hint}>
            自动配图会先请模型把该段对话转写成「角色说完这段话后所处的画面」再出图；开头 / 高潮（正中）/ 结尾指从本轮回复里取哪一段。
          </FieldHint>
          <FieldLabel style={styles.label}>风格前缀（可选）</FieldLabel>
          <TextField
            value={inlineImage.stylePrefix}
            onChangeText={text => updateInlineImage({ stylePrefix: text })}
            placeholder="例如：anime style, detailed"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <FieldLabel style={styles.label}>尺寸（宽*高）</FieldLabel>
          <TextField
            value={inlineImage.size}
            onChangeText={text => updateInlineImage({ size: text })}
            placeholder="832*1216"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <FieldLabel style={styles.label}>提示词长度上限（字符）</FieldLabel>
          <TextField
            value={String(inlineImage.maxPromptChars)}
            onChangeText={text => updateInlineImage({ maxPromptChars: text.replace(/[^0-9]/g, '') })}
            keyboardType="number-pad"
            placeholder="400"
          />
          <Text style={styles.fieldHint}>密钥仅保存在本机，与「扩展 → 生图」共用同一份配置。</Text>
          <FieldLabel style={styles.label}>其它功能</FieldLabel>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => setPluginEntryOpen(true)}
            activeOpacity={0.7}
          >
            <View style={styles.linkLeft}>
              <Ionicons name="extension-puzzle-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>联网搜索</Text>
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
              <Text style={styles.linkText}>语音播报</Text>
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
              <Text style={styles.linkText}>语音转文字</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.primary} />
          </TouchableOpacity>
    </>
  );
}
