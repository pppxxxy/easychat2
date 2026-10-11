// 「图片识别（OCR）模型」设置卡片（拓展页内联）。
//
// 用途：给主模型配一个「先看图、再说话」的辅助模型。消息带图片且这里开启时，会先调
// 这个模型把图片转成文字描述，再把描述作为文本注入该消息，最后按配置决定是否同时
// 附原图。看屏幕也可以选择走它（见 ScreenWatchScreen 的来源选择）。
//
// 密钥纪律：这里**没有** API Key 输入框。接口配置直接选既有 getApiConfigs() 的一条，
// 密钥仍由保险箱保护——避免出现第二套密钥存储（上一批刚修过两条明文落盘泄漏）。
//
// 提示词纪律：描述提示词的默认模板是**发给模型的提示词**，按仓库铁律不进 i18n；
// 界面上「说明它」的文案才进 i18n（见 settings.imageRecognition.* 词条）。

import React from 'react';
import { Switch, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { CollapsibleSelect, FieldHint, FieldLabel, TextField } from '../../ui/index.js';

const SCREEN_WATCH_SOURCE_KEYS = {
  main: {
    labelKey: 'settings.imageRecognition.screenWatch.main',
    metaKey: 'settings.imageRecognition.screenWatch.mainMeta',
  },
  ocr: {
    labelKey: 'settings.imageRecognition.screenWatch.ocr',
    metaKey: 'settings.imageRecognition.screenWatch.ocrMeta',
  },
};

export default function ImageRecognitionCard({
  styles,
  theme,
  t,
  imageRecognition,
  imageRecognitionApiConfigs,
  updateImageRecognition,
}) {
  if (!imageRecognition) return null;
  const configs = Array.isArray(imageRecognitionApiConfigs) ? imageRecognitionApiConfigs : [];
  const digitsOnly = value => String(value || '').replace(/[^0-9]/g, '');
  const configOptions = configs.map(config => ({
    value: String(config.id || ''),
    label: String(config.name || '').trim() || String(config.id || ''),
    meta: String(config.baseUrl || ''),
  }));
  const selectedConfig = configs.find(config => String(config.id) === String(imageRecognition.apiConfigId)) || null;

  return (
    <>
      <View style={styles.capabilityRow}>
        <View style={styles.linkLeft}>
          <Ionicons name="scan-outline" size={17} color={theme.colors.primaryMuted} />
          <Text style={styles.linkText}>{t('settings.imageRecognition.enable')}</Text>
        </View>
        <Switch
          value={imageRecognition.enabled === true}
          onValueChange={value => updateImageRecognition({ enabled: value })}
          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
          thumbColor={theme.colors.primaryContrast}
        />
      </View>
      <FieldHint style={styles.hint}>{t('settings.imageRecognition.intro')}</FieldHint>

      <FieldLabel style={styles.label}>{t('settings.imageRecognition.apiConfig')}</FieldLabel>
      <CollapsibleSelect
        label={t('settings.imageRecognition.apiConfigLabel')}
        value={String(imageRecognition.apiConfigId || '')}
        options={configOptions}
        onSelect={id => updateImageRecognition({ apiConfigId: id })}
        placeholder={t('settings.imageRecognition.apiConfigPlaceholder')}
      />
      <FieldHint style={styles.hint}>
        {selectedConfig
          ? t('settings.imageRecognition.apiConfigSelected', { name: String(selectedConfig.name || selectedConfig.id || '') })
          : t('settings.imageRecognition.apiConfigHint')}
      </FieldHint>

      <FieldLabel style={styles.label}>{t('settings.imageRecognition.model')}</FieldLabel>
      <TextField
        value={String(imageRecognition.model || '')}
        onChangeText={text => updateImageRecognition({ model: text })}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={t('settings.imageRecognition.modelPlaceholder')}
      />
      <FieldHint style={styles.hint}>{t('settings.imageRecognition.modelHint')}</FieldHint>

      <FieldLabel style={styles.label}>{t('settings.imageRecognition.prompt')}</FieldLabel>
      <TextField
        value={String(imageRecognition.descriptionPrompt || '')}
        onChangeText={text => updateImageRecognition({ descriptionPrompt: text })}
        multiline
        numberOfLines={5}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={t('settings.imageRecognition.promptPlaceholder')}
      />
      <FieldHint style={styles.hint}>{t('settings.imageRecognition.promptHint')}</FieldHint>

      <FieldLabel style={styles.label}>{t('settings.imageRecognition.maxOutputTokens')}</FieldLabel>
      <TextField
        value={String(imageRecognition.maxOutputTokens)}
        onChangeText={text => updateImageRecognition({ maxOutputTokens: digitsOnly(text) })}
        keyboardType="number-pad"
        placeholder="512"
      />
      <FieldHint style={styles.hint}>{t('settings.imageRecognition.maxOutputTokensHint')}</FieldHint>

      <FieldLabel style={styles.label}>{t('settings.imageRecognition.timeout')}</FieldLabel>
      <TextField
        value={String(imageRecognition.timeoutSeconds)}
        onChangeText={text => updateImageRecognition({ timeoutSeconds: digitsOnly(text) })}
        keyboardType="number-pad"
        placeholder="30"
      />
      <FieldHint style={styles.hint}>{t('settings.imageRecognition.timeoutHint')}</FieldHint>

      <FieldLabel style={styles.label}>{t('settings.imageRecognition.concurrency')}</FieldLabel>
      <TextField
        value={String(imageRecognition.concurrency)}
        onChangeText={text => updateImageRecognition({ concurrency: digitsOnly(text) })}
        keyboardType="number-pad"
        placeholder="2"
      />
      <FieldHint style={styles.hint}>{t('settings.imageRecognition.concurrencyHint')}</FieldHint>

      <View style={styles.capabilityRow}>
        <View style={styles.linkLeft}>
          <Ionicons name="images-outline" size={17} color={theme.colors.primaryMuted} />
          <Text style={styles.linkText}>{t('settings.imageRecognition.attachOriginal')}</Text>
        </View>
        <Switch
          value={imageRecognition.attachOriginal === true}
          onValueChange={value => updateImageRecognition({ attachOriginal: value })}
          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
          thumbColor={theme.colors.primaryContrast}
        />
      </View>
      <FieldHint style={styles.hint}>{t('settings.imageRecognition.attachOriginalHint')}</FieldHint>

      <FieldLabel style={styles.label}>{t('settings.imageRecognition.screenWatch.label')}</FieldLabel>
      <CollapsibleSelect
        label={t('settings.imageRecognition.screenWatch.labelShort')}
        value={String(imageRecognition.screenWatchSource || 'main')}
        options={Object.entries(SCREEN_WATCH_SOURCE_KEYS).map(([value, keys]) => ({
          value,
          label: t(keys.labelKey),
          meta: t(keys.metaKey),
        }))}
        onSelect={value => updateImageRecognition({ screenWatchSource: value })}
        placeholder={t('settings.imageRecognition.screenWatch.main')}
      />
      <FieldHint style={styles.hint}>{t('settings.imageRecognition.screenWatch.hint')}</FieldHint>

      <Text style={styles.fieldHint}>{t('settings.imageRecognition.keyNote')}</Text>
    </>
  );
}
