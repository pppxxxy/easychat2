// 设置页「内置 MCP Server」卡片：让 Codex / Claude Code 等外部 agent 连进 App。
//
// 状态与写入都在 useMcpServer（本组件只做展示与回调转发，与 ApiServerSection 同一分工）。
// 卡片的三个档位就是**授权界面**：打开「允许写入」等于告诉 agent「你可以改我的工作区」，
// 所以每档都配一句后果说明，执行档另标风险（见 src/mcp/serverPolicy.js 的分档理由）。
//
// 挂在「MCP 服务器」卡内部（McpServersSection 渲染）而不是新开一张设置卡：两个方向
// 本来就是一回事（外连/被连），共用一张卡也让 SettingsScreen 的区块渲染顺序契约不用动。
//
// 2026-10-13（用户反馈）：**整块默认收起**。它是「被连」的方向，字段最多（开关/范围/
// 端口/token/三档/连接配置），常驻展开会把同卡下面的「第三方服务器 + 添加入口」推到
// 一屏之外——用户想加个第三方服务器得先划过整个内置块。折叠头右侧如实显示运行状态
//（运行中/已关闭），沿用 ExtensionsSection 那条「开关状态一眼可见、参数默认收起」的先例。

import React, { useCallback, useState } from 'react';
import { Switch, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Chip, CollapsibleSection, FieldHint, FieldLabel, GhostButton, TextField } from '../ui/index.js';
import SecretTextField from './SecretTextField.js';
import useMcpServer from './useMcpServer.js';
import { MCP_SERVER_PORT_DEFAULT } from '../storage/settings.js';

// 档位行：顺序即「从安全到危险」，与 serverPolicy 的 MCP_ACCESS_TIERS 同序。
// 这里只放 key（不放中文文案）——文案一律走 i18n。
const TIER_ROWS = [
  { tier: 'read', icon: 'eye-outline', labelKey: 'settings.mcp.server.tier.read', hintKey: 'settings.mcp.server.tier.readHint' },
  { tier: 'write', icon: 'create-outline', labelKey: 'settings.mcp.server.tier.write', hintKey: 'settings.mcp.server.tier.writeHint' },
  { tier: 'exec', icon: 'terminal-outline', labelKey: 'settings.mcp.server.tier.exec', hintKey: 'settings.mcp.server.tier.execHint' },
];

export default function McpServerCard({ styles, theme, t }) {
  const server = useMcpServer();
  const [copied, setCopied] = useState(false);
  const settings = server.settings;
  const tiers = settings && settings.tiers ? settings.tiers : { read: true, write: false, exec: false };
  const disabled = !server.loaded || server.busy || !server.status.available;

  const onCopy = useCallback(async () => {
    const result = await server.copyConnection();
    if (result && result.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [server]);

  // 折叠头右侧的一行状态：不展开也知道内置服务器现在开没开（沿用设置页其它折叠块的
  // collapseSummary 位）。可用性优先于开关状态——本构建没有原生模块时先说这个。
  const summary = !server.status.available
    ? t('settings.mcp.server.unavailableShort')
    : (server.status.running
      ? t('settings.mcp.server.running', { port: server.status.port })
      : t('settings.mcp.server.off'));

  return (
    <CollapsibleSection
      title={t('settings.mcp.server.title')}
      icon="radio-outline"
      defaultOpen={false}
      right={<Text style={styles.collapseSummary} numberOfLines={1}>{summary}</Text>}
    >
      <FieldHint style={styles.hint}>{t('settings.mcp.server.subtitle')}</FieldHint>

      {server.status.available ? null : (
        <FieldHint style={styles.hint}>{t('settings.mcp.server.unavailable')}</FieldHint>
      )}
      {server.error ? (
        <FieldHint style={styles.hint}>{`${t('settings.mcp.server.startFailed')}${server.error}`}</FieldHint>
      ) : null}

      <View style={styles.capabilityRow}>
        <View style={styles.linkLeft}>
          <Ionicons
            name={server.status.running ? 'radio-outline' : 'radio-button-off-outline'}
            size={17}
            color={server.status.running ? theme.colors.primary : theme.colors.primaryMuted}
          />
          <Text style={styles.linkText} numberOfLines={1}>
            {server.status.running
              ? t('settings.mcp.server.running', { port: server.status.port })
              : t('settings.mcp.server.enable')}
          </Text>
        </View>
        <Switch
          value={Boolean(settings && settings.enabled)}
          onValueChange={server.setEnabled}
          disabled={disabled}
          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
          thumbColor={theme.colors.primaryContrast}
          accessibilityLabel={t('settings.mcp.server.enable')}
        />
      </View>

      <FieldLabel style={styles.label}>{t('settings.mcp.server.scope')}</FieldLabel>
      <View style={styles.modelChips}>
        <Chip
          label={t('settings.mcp.server.scope.loopback')}
          active={settings ? settings.scope === 'loopback' : true}
          onPress={() => server.setScope('loopback')}
          disabled={disabled}
        />
        <Chip
          label={t('settings.mcp.server.scope.lan')}
          active={Boolean(settings && settings.scope === 'lan')}
          onPress={() => server.setScope('lan')}
          disabled={disabled}
        />
      </View>
      <FieldHint style={styles.hint}>
        {settings && settings.scope === 'lan'
          ? t('settings.mcp.server.scope.lanHint')
          : t('settings.mcp.server.scope.loopbackHint')}
      </FieldHint>

      <FieldLabel style={styles.label}>{t('settings.mcp.server.port')}</FieldLabel>
      <TextField
        value={server.portDraft}
        onChangeText={server.setPortDraft}
        onEndEditing={server.commitPort}
        keyboardType="number-pad"
        editable={!disabled}
        placeholder={String(MCP_SERVER_PORT_DEFAULT)}
      />
      <FieldHint style={styles.hint}>{t('settings.mcp.server.portHint')}</FieldHint>

      <FieldLabel style={styles.label}>{t('settings.mcp.server.token')}</FieldLabel>
      <SecretTextField
        value={settings ? settings.mcpToken : ''}
        onChangeText={server.setTokenDraft}
        onEndEditing={server.commitToken}
        placeholder={t('settings.mcp.server.tokenPlaceholder')}
        theme={theme}
        styles={styles}
      />
      <FieldHint style={styles.hint}>{t('settings.mcp.server.tokenHint')}</FieldHint>

      <FieldLabel style={styles.label}>{t('settings.mcp.server.tiers')}</FieldLabel>
      {TIER_ROWS.map(row => (
        <View key={row.tier}>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons
                name={row.icon}
                size={17}
                color={tiers[row.tier] === true ? theme.colors.primary : theme.colors.primaryMuted}
              />
              <Text style={styles.linkText} numberOfLines={1}>{t(row.labelKey)}</Text>
            </View>
            <Switch
              value={tiers[row.tier] === true}
              onValueChange={value => server.setTier(row.tier, value)}
              disabled={disabled}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
              accessibilityLabel={t(row.labelKey)}
            />
          </View>
          <FieldHint style={styles.hint}>{t(row.hintKey)}</FieldHint>
        </View>
      ))}
      <FieldHint style={styles.hint}>{t('settings.mcp.server.previewHint')}</FieldHint>

      <FieldLabel style={styles.label}>{t('settings.mcp.server.connection')}</FieldLabel>
      <View style={styles.linkRow}>
        <Text style={styles.linkText} numberOfLines={1}>{server.url}</Text>
        {copied ? <Text style={styles.linkValue}>{t('settings.mcp.server.copied')}</Text> : null}
      </View>
      <View style={styles.personaActions}>
        <GhostButton
          title={t('settings.mcp.server.copy')}
          small
          onPress={onCopy}
          disabled={disabled}
        />
        <GhostButton
          title={t('settings.mcp.server.regenerate')}
          small
          onPress={server.regenerateToken}
          disabled={disabled}
        />
      </View>
    </CollapsibleSection>
  );
}
