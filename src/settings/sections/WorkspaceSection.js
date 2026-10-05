import React from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  FieldHint,
  FieldLabel,
  GhostButton,
  SecondaryButton,
} from '../../ui/index.js';
import WorkspaceCapabilitiesCard from '../../WorkspaceCapabilitiesCard.js';
import { WORKSPACE_ROOT_KINDS } from '../../workspace/location.js';
import { isShellAvailable } from '../../workspace/shell.js';

const WORKSPACE_MODE_OPTIONS = [
  { id: 'ask', labelKey: 'settings.workspace.mode.ask', hintKey: 'settings.workspace.hint.ask' },
  { id: 'read', labelKey: 'settings.workspace.mode.read', hintKey: 'settings.workspace.hint.read' },
  { id: 'write', labelKey: 'settings.workspace.mode.write', hintKey: 'settings.workspace.hint.write' },
];

export default function WorkspaceSection(props) {
  const {
    styles,
    theme,
    t,
    workspaceMode,
    updateWorkspaceMode,
    workspaceFolder,
    workspaceFolderBusy,
    resetWorkspaceFolder,
    chooseWorkspaceFolder,
    commandExecution,
    toggleCommandExecution,
    setWorkspaceOpen,
  } = props;
  return (
    <>
          <FieldLabel style={styles.label}>{t('settings.workspace.mode')}</FieldLabel>
          <View style={styles.fontRow}>
            {WORKSPACE_MODE_OPTIONS.map(option => {
              const active = option.id === workspaceMode;
              return (
                <TouchableOpacity
                  key={option.id}
                  style={[styles.fontChip, active && styles.fontChipActive]}
                  onPress={() => updateWorkspaceMode(option.id)}
                  activeOpacity={0.85}
                  accessibilityLabel={t(option.labelKey)}
                >
                  <Text style={[styles.fontChipText, active && styles.fontChipTextActive]}>
                    {t(option.labelKey)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <FieldHint style={styles.hint}>
            {t((WORKSPACE_MODE_OPTIONS.find(option => option.id === workspaceMode) || WORKSPACE_MODE_OPTIONS[0]).hintKey)}
          </FieldHint>

          <FieldLabel style={styles.label}>{t('settings.workspace.folder')}</FieldLabel>
          <View style={styles.capabilityRow}>
            <View style={styles.linkLeft}>
              <Ionicons
                name={workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF ? 'folder-outline' : 'phone-portrait-outline'}
                size={17}
                color={theme.colors.primaryMuted}
              />
              <Text style={styles.linkText} numberOfLines={1}>
                {workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF
                  ? (workspaceFolder.name || t('settings.workspace.folder.custom'))
                  : t('settings.workspace.folder.app')}
              </Text>
            </View>
            {workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF ? (
              <GhostButton title={t('settings.workspace.folder.reset')} small onPress={resetWorkspaceFolder} />
            ) : null}
          </View>
          <FieldHint style={styles.hint}>
            {workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF
              ? t('settings.workspace.folder.hintExternal', { name: workspaceFolder.name || t('settings.workspace.folder.custom') })
              : t('settings.workspace.folder.hintApp')}
          </FieldHint>
          <SecondaryButton
            title={workspaceFolderBusy ? t('settings.workspace.folder.picking') : t('settings.workspace.folder.pick')}
            small
            disabled={workspaceFolderBusy}
            style={{ alignSelf: 'flex-start', marginTop: 8 }}
            onPress={chooseWorkspaceFolder}
          />

          <View style={[styles.capabilityRow, { marginTop: 16 }]}>
            <View style={styles.linkLeft}>
              <Ionicons name="terminal-outline" size={17} color={theme.colors.primaryMuted} />
              <Text style={styles.linkText}>{t('settings.workspace.shell')}</Text>
            </View>
            <Switch
              value={commandExecution}
              disabled={workspaceMode !== 'write' || workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF}
              onValueChange={toggleCommandExecution}
              trackColor={{ false: theme.colors.surface, true: theme.colors.primary }}
              thumbColor={theme.colors.primaryContrast}
            />
          </View>
          <FieldHint style={styles.hint}>
            {workspaceFolder.kind === WORKSPACE_ROOT_KINDS.SAF
              ? t('settings.workspace.shell.hintExternal')
              : (workspaceMode === 'write'
                ? t('settings.workspace.shell.hint')
                : t('settings.workspace.shell.hintReadonly'))}
          </FieldHint>

          <SecondaryButton
            title={t('settings.workspace.open')}
            small
            style={{ alignSelf: 'flex-start', marginTop: 12 }}
            onPress={() => setWorkspaceOpen(true)}
          />

          <WorkspaceCapabilitiesCard
            settings={{
              mode: workspaceMode,
              location: workspaceFolder,
              allowCommandExecution: commandExecution,
            }}
            shellAvailable={isShellAvailable()}
          />
    </>
  );
}
