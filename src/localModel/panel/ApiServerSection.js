// 「服务」段：本地 API 服务（OpenAI 兼容）的端口/密钥/启停 Switch/地址复制 + 运行日志入口。
// 纯渲染：服务状态与处理器由壳经 useApiServer 装配。

import React from 'react';
import { Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

export default function ApiServerSection({
  styles,
  theme,
  t,
  apiServer,
  onApiServerChange,
  apiStatus,
  apiBusy,
  apiAddress,
  onStart,
  onStop,
  onCopyAddress,
  onOpenLogs,
}) {
  return (
    <>
      <Text style={styles.hint}>{t('localModel.api.hint')}</Text>
      <View style={styles.apiPortRow}>
        <Text style={styles.labelInline}>{t('localModel.api.port')}</Text>
        <TextInput
          style={[styles.input, styles.apiPortInput]}
          value={String(apiServer.port)}
          onChangeText={text => onApiServerChange(current => ({ ...current, port: text }))}
          keyboardType="numeric"
          placeholderTextColor={theme.colors.textFaint}
        />
      </View>
      <TextInput
        style={styles.input}
        value={apiServer.apiKey}
        onChangeText={text => onApiServerChange(current => ({ ...current, apiKey: text }))}
        placeholder={t('localModel.api.keyPlaceholder')}
        placeholderTextColor={theme.colors.textFaint}
        autoCapitalize="none"
      />
      <View style={styles.apiSwitchRow}>
        <Text style={styles.mediaTitle}>
          {apiStatus.running ? t('localModel.api.runningPort', { port: apiStatus.port }) : t('localModel.api.enable')}
        </Text>
        <Switch
          value={Boolean(apiStatus.running)}
          onValueChange={value => (value ? onStart() : onStop())}
          disabled={apiBusy}
          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
          thumbColor={theme.colors.primaryContrast}
          accessibilityLabel={t('localModel.api.enable')}
        />
      </View>
      <TouchableOpacity
        style={styles.apiAddressRow}
        onPress={onCopyAddress}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={t('localModel.a11y.copyApiAddress', { address: apiAddress })}
      >
        <Text style={styles.apiAddress} numberOfLines={1}>{apiAddress}</Text>
        <View style={styles.apiCopyChip}>
          <Ionicons name="copy-outline" size={14} color={theme.colors.primarySoft} />
          <Text style={styles.apiCopyText}>{t('common.copy')}</Text>
        </View>
      </TouchableOpacity>
      <Text style={styles.apiAddressHint}>{t('localModel.api.addressHint')}</Text>
      <TouchableOpacity style={styles.logsButton} onPress={onOpenLogs} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={t('localModel.a11y.viewLogs')}>
        <Ionicons name="document-text-outline" size={14} color={theme.colors.primarySoft} />
        <Text style={styles.logsButtonText}>{t('localModel.viewLogs')}</Text>
      </TouchableOpacity>
    </>
  );
}
