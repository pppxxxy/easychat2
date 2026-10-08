// 工作区「设置」领域面板：助手工作模式 / 工作区文件夹 / 命令执行 / 能力说明。
//
// 复用设置页的编排 hook（useWorkspaceSettings）——同一份存储、同一套 patch 语义
//（局部更新，绝不整体 save，否则切模式会把刚选好的文件夹与开关冲回默认）。
// 面板内的二级层（选文件夹走系统选择器）不在本组件里，不产生任何 Modal 嵌套。

import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel, GhostButton, SecondaryButton } from '../../ui/index.js';
import WorkspaceCapabilitiesCard from '../../WorkspaceCapabilitiesCard.js';
import WorkspaceGeneralSettings from '../WorkspaceGeneralSettings.js';
import PythonSection from './PythonSection.js';
import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';
import useWorkspaceSettings from '../../settings/useWorkspaceSettings.js';
import { WORKSPACE_ROOT_KINDS } from '../location.js';
import { isShellAvailable } from '../shell.js';
import { isPythonBridgePresent } from '../python.js';

export default function WorkspaceSettingsPanel({ characterId = 'default' }) {
  const { theme, fonts } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const {
    workspaceMode,
    workspaceFolder,
    commandExecution,
    pythonExecution,
    workspaceFolderBusy,
    updateWorkspaceMode,
    chooseWorkspaceFolder,
    resetWorkspaceFolder,
    toggleCommandExecution,
    togglePythonExecution,
  } = useWorkspaceSettings();

  const isExternal = workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF;
  // 执行类开关都需要「可改」模式 + 应用内根：外部根下 shell 碰不到 content://，
  // Python 也拿不到真实路径。
  const executionDisabled = workspaceMode !== 'write' || isExternal;

  return (
    <ScrollView contentContainerStyle={styles.body}>
      {/* 语言 / 助手工作模式 / 帮助：收编自 WorkspaceGeneralSettings（内嵌，不再弹层）。 */}
      <WorkspaceGeneralSettings
        embedded
        mode={workspaceMode}
        onSelectMode={updateWorkspaceMode}
      />

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
          disabled={executionDisabled}
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

      {/* 与命令执行**各自独立**的第二个执行开关：Python 能联网、能读整个应用沙盒，
          风险面与 shell 不同，共用一个开关会让「开一个顺带开了另一个」。 */}
      <View style={[styles.row, styles.rowSpaced]}>
        <View style={styles.rowLeft}>
          <Ionicons name="logo-python" size={17} color={theme.colors.primaryMuted} />
          <Text style={styles.rowText}>{t('settings.workspace.pythonExec')}</Text>
        </View>
        <Switch
          value={pythonExecution}
          disabled={executionDisabled}
          onValueChange={togglePythonExecution}
          trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
          thumbColor={theme.colors.primaryContrast}
        />
      </View>
      <FieldHint style={styles.hint}>
        {isExternal
          ? t('settings.workspace.pythonExec.hintExternal')
          : (workspaceMode === 'write'
            ? t('settings.workspace.pythonExec.hint')
            : t('settings.workspace.pythonExec.hintReadonly'))}
      </FieldHint>

      <PythonSection characterId={characterId} />

      <WorkspaceCapabilitiesCard
        settings={{
          mode: workspaceMode,
          location: workspaceFolder,
          allowCommandExecution: commandExecution,
          allowPythonExecution: pythonExecution,
        }}
        shellAvailable={isShellAvailable()}
        pythonAvailable={isPythonBridgePresent()}
      />
    </ScrollView>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  label: { marginTop: 12 },
  hint: { marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  rowSpaced: { marginTop: 16 },
  rowLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  rowText: { color: theme.colors.text, fontSize: fonts.scaled(13), marginLeft: 8, flex: 1 },
  selfStart: { alignSelf: 'flex-start', marginTop: 8 },
});
