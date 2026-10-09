// 设置页「MCP 服务器」卡（spec: agent-extensibility T1-d）：管理第三方 MCP 服务器。
// 内置 GitHub 仍有专用卡（GithubSection）——本卡只列第三方服务器。
// 状态与保存逻辑在 settings/useMcpServers.js，本卡只做展示与回调转发。

import React from 'react';
import { Switch, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel, GhostButton, SecondaryButton, TextField } from '../../ui/index.js';
import SecretTextField from '../SecretTextField.js';

export default function McpServersSection(props) {
  const {
    styles,
    theme,
    t,
    mcpServers,
    mcpName,
    setMcpName,
    mcpEndpoint,
    setMcpEndpoint,
    mcpToken,
    setMcpToken,
    mcpHeaders,
    setMcpHeaders,
    mcpBusy,
    mcpTestingId,
    onAddMcpServer,
    onTestMcpServer,
    onToggleMcpServer,
    onRemoveMcpServer,
  } = props;

  const list = Array.isArray(mcpServers) ? mcpServers : [];

  return (
    <>
      <FieldHint style={styles.hint}>{t('settings.mcp.subtitle')}</FieldHint>
      {list.length === 0 ? (
        <FieldHint style={styles.hint}>{t('settings.mcp.empty')}</FieldHint>
      ) : list.map(server => (
        <View key={server.id}>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons
                name={server.enabled ? 'link-outline' : 'unlink-outline'}
                size={17}
                color={server.enabled ? theme.colors.primary : theme.colors.primaryMuted}
              />
              <Text style={styles.linkText} numberOfLines={1}>{server.name}</Text>
            </View>
            <Switch
              value={server.enabled === true}
              onValueChange={value => onToggleMcpServer(server, value)}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
              accessibilityLabel={t('settings.mcp.toggle.a11y', { name: server.name })}
            />
          </View>
          <FieldHint style={styles.hint}>
            {server.connectedAt > 0
              ? t('settings.mcp.summary', { count: server.toolCatalog.length, denied: server.deniedNames.length })
              : t('settings.mcp.neverConnected')}
          </FieldHint>
          <View style={styles.formActions}>
            <GhostButton
              title={mcpTestingId === server.id ? t('settings.mcp.testing') : t('settings.mcp.test')}
              small
              onPress={() => onTestMcpServer(server)}
            />
            <SecondaryButton
              title={t('settings.mcp.remove.ok')}
              small
              onPress={() => onRemoveMcpServer(server)}
            />
          </View>
        </View>
      ))}

      <FieldLabel style={styles.label}>{t('settings.mcp.add.label')}</FieldLabel>
      <TextField
        value={mcpName}
        onChangeText={setMcpName}
        placeholder={t('settings.mcp.add.namePlaceholder')}
      />
      <TextField
        value={mcpEndpoint}
        onChangeText={setMcpEndpoint}
        placeholder={t('settings.mcp.add.endpointPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <SecretTextField
        value={mcpToken}
        onChangeText={setMcpToken}
        placeholder={t('settings.mcp.add.tokenPlaceholder')}
        theme={theme}
        styles={styles}
      />
      <TextField
        value={mcpHeaders}
        onChangeText={setMcpHeaders}
        placeholder={t('settings.mcp.add.headersPlaceholder')}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
      />
      <FieldHint style={styles.hint}>{t('settings.mcp.add.headersHint')}</FieldHint>
      <FieldHint style={styles.hint}>{t('settings.mcp.riskHint')}</FieldHint>
      <View style={styles.formActions}>
        <GhostButton
          title={mcpBusy ? t('settings.mcp.busy') : t('settings.mcp.add.action')}
          small
          onPress={onAddMcpServer}
        />
      </View>
    </>
  );
}
