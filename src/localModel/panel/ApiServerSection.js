// 「服务」段：本地 API 服务（OpenAI 兼容）的端口/密钥/启停 Switch/地址复制 + 运行日志入口。
// 纯渲染：服务状态与处理器由壳经 useApiServer 装配。

import React from 'react';
import { Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

export default function ApiServerSection({
  styles,
  theme,
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
      <Text style={styles.hint}>固定监听 127.0.0.1，供同机客户端调用；推理复用当前加载的本地模型。请求强制携带 Bearer 密钥（留空会自动生成），同机其他应用无法匿名调用。</Text>
      <View style={styles.apiPortRow}>
        <Text style={styles.labelInline}>端口</Text>
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
        placeholder="API Key（留空将自动生成随机密钥）"
        placeholderTextColor={theme.colors.textFaint}
        autoCapitalize="none"
      />
      <View style={styles.apiSwitchRow}>
        <Text style={styles.mediaTitle}>
          {apiStatus.running ? `运行中（端口 ${apiStatus.port}）` : '启用本地 API 服务'}
        </Text>
        <Switch
          value={Boolean(apiStatus.running)}
          onValueChange={value => (value ? onStart() : onStop())}
          disabled={apiBusy}
          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
          thumbColor={theme.colors.primaryContrast}
          accessibilityLabel="启用本地 API 服务"
        />
      </View>
      <TouchableOpacity
        style={styles.apiAddressRow}
        onPress={onCopyAddress}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`复制本地 API 地址 ${apiAddress}`}
      >
        <Text style={styles.apiAddress} numberOfLines={1}>{apiAddress}</Text>
        <View style={styles.apiCopyChip}>
          <Ionicons name="copy-outline" size={14} color={theme.colors.primarySoft} />
          <Text style={styles.apiCopyText}>复制</Text>
        </View>
      </TouchableOpacity>
      <Text style={styles.apiAddressHint}>在「模型」页选择模型并加载后开启服务，把此地址填入同机客户端的 base_url。</Text>
      <TouchableOpacity style={styles.logsButton} onPress={onOpenLogs} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="查看运行日志">
        <Ionicons name="document-text-outline" size={14} color={theme.colors.primarySoft} />
        <Text style={styles.logsButtonText}>查看运行日志</Text>
      </TouchableOpacity>
    </>
  );
}
