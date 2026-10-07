// 工作区「设置」领域面板：助手工作模式 / 工作区文件夹 / 命令执行 / 能力说明。
//
// 复用设置页的编排 hook（useWorkspaceSettings）——同一份存储、同一套 patch 语义
//（局部更新，绝不整体 save，否则切模式会把刚选好的文件夹与开关冲回默认）。
// 面板内的二级层（选文件夹走系统选择器）不在本组件里，不产生任何 Modal 嵌套。

import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel, GhostButton, SecondaryButton } from '../../ui/index.js';
import WorkspaceCapabilitiesCard from '../../WorkspaceCapabilitiesCard.js';
import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import useWorkspaceSettings from '../../settings/useWorkspaceSettings.js';
import { WORKSPACE_ROOT_KINDS } from '../location.js';
import { isShellAvailable } from '../shell.js';

const MODE_OPTIONS = [
  { id: 'ask', labelKey: 'settings.workspace.mode.ask', hintKey: 'settings.workspace.hint.ask' },
  { id: 'read', labelKey: 'settings.workspace.mode.read', hintKey: 'settings.workspace.hint.read' },
  { id: 'write', labelKey: 'settings.workspace.mode.write', hintKey: 'settings.workspace.hint.write' },
];

export default function WorkspaceSettingsPanel() {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const {
    workspaceMode,
    workspaceFolder,
    commandExecution,
    workspaceFolderBusy,
    updateWorkspaceMode,
    chooseWorkspaceFolder,
    resetWorkspaceFolder,
    toggleCommandExecution,
  } = useWorkspaceSettings();

  const activeMode = MODE_OPTIONS.find(option => option.id === workspaceMode) || MODE_OPTIONS[0];
  const isExternal = workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF;

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <FieldLabel style={styles.label}>{t('settings.workspace.mode')}</FieldLabel>
      <View style={styles.chipRow}>
        {MODE_OPTIONS.map(option => {
          const active = option.id === workspaceMode;
          return (
            <TouchableOpacity
              key={option.id}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => updateWorkspaceMode(option.id)}
              activeOpacity={0.85}
              accessibilityLabel={t(option.labelKey)}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{t(option.labelKey)}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <FieldHint style={styles.hint}>{t(activeMode.hintKey)}</FieldHint>

      <FieldLabel style={styles.label}>{t('settings.workspace.folder')}</FieldLabel>
      <View style={styles.row}>
        <View style={styles.rowLeft}>
          <Ionicons
            name={isExternal ? 'folder-outline' : 'phone-portrait-outline'}
            size={17}
            color={theme.colors.primaryMuted}
          />
          <Text style={styles.rowText} numberOfLines={1}>
            {isExternal
              ? (workspaceFolder.name || t('settings.workspace.folder.custom'))
              : t('settings.workspace.folder.app')}
          </Text>
        </View>
        {isExternal ? (
          <GhostButton title={t('settings.workspace.folder.reset')} small onPress={resetWorkspaceFolder} />
        ) : null}
      </View>
      <FieldHint style={styles.hint}>
        {isExternal
          ? t('settings.workspace.folder.hintExternal', { name: workspaceFolder.name || t('settings.workspace.folder.custom') })
          : t('settings.workspace.folder.hintApp')}
      </FieldHint>
      <SecondaryButton
        title={workspaceFolderBusy ? t('settings.workspace.folder.picking') : t('settings.workspace.folder.pick')}
        small
        disabled={workspaceFolderBusy}
        style={styles.selfStart}
        onPress={chooseWorkspaceFolder}
      />

      <View style={[styles.row, styles.rowSpaced]}>
        <View style={styles.rowLeft}>
          <Ionicons name="terminal-outline" size={17} color={theme.colors.primaryMuted} />
          <Text style={styles.rowText}>{t('settings.workspace.shell')}</Text>
        </View>
        <Switch
          value={commandExecution}
          disabled={workspaceMode !== 'write' || isExternal}
          onValueChange={toggleCommandExecution}
          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
          thumbColor={theme.colors.primaryContrast}
        />
      </View>
      <FieldHint style={styles.hint}>
        {isExternal
          ? t('settings.workspace.shell.hintExternal')
          : (workspaceMode === 'write'
            ? t('settings.workspace.shell.hint')
            : t('settings.workspace.shell.hintReadonly'))}
      </FieldHint>

      <WorkspaceCapabilitiesCard
        settings={{ mode: workspaceMode, location: workspaceFolder, allowCommandExecution: commandExecution }}
        shellAvailable={isShellAvailable()}
      />
    </ScrollView>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  label: { marginTop: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
    marginRight: 8,
    marginBottom: 8,
  },
  chipActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary },
  chipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600' },
  chipTextActive: { color: theme.colors.primaryContrast },
  hint: { marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  rowSpaced: { marginTop: 16 },
  rowLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  rowText: { color: theme.colors.text, fontSize: fonts.scaled(13), marginLeft: 8, flex: 1 },
  selfStart: { alignSelf: 'flex-start', marginTop: 8 },
});
