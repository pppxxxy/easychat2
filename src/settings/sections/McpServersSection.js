// 设置页「MCP 服务器」卡（spec: agent-extensibility T1-d）：管理第三方 MCP 服务器。
// 内置 GitHub 仍有专用卡（GithubSection）——本卡只列第三方服务器。
// 状态与保存逻辑在 settings/useMcpServers.js，本卡只做展示与回调转发。
//
// 卡内还挂了「内置 MCP Server」子卡（McpServerCard，反方向：让外部 agent 连进来）。
// 放同一张卡的理由：两个方向本来就是一件事（外连/被连），且 SettingsScreen 的
// 区块渲染顺序契约（SECTION_RENDER_ORDER 注释说要同步五处）不必为它改动。

import React from 'react';
import { Switch, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { CollapsibleSection, FieldHint, FieldLabel, GhostButton, SecondaryButton, TextField } from '../../ui/index.js';
import McpServerCard from '../McpServerCard.js';
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
      {/* 内置 MCP Server 自己带折叠头（McpServerCard 内），默认收起——见那边的说明。 */}
      <McpServerCard styles={styles} theme={theme} t={t} />
      {/* 第三方服务器：本卡的主角，**默认展开**（用户来这张卡多半是要加服务器），
          但仍可单独收起——两块各自折叠，谁也不用划着越过谁。 */}
      <CollapsibleSection
        title={t('settings.mcp.thirdParty.title')}
        icon="link-outline"
        defaultOpen
        right={list.length > 0 ? (
          <Text style={styles.collapseSummary} numberOfLines={1}>
            {t('settings.mcp.count', { count: list.length })}
          </Text>
        ) : null}
      >
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
      </CollapsibleSection>
    </>
  );
}
