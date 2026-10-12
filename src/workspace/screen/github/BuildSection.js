// H1 云构建（GitHub Actions）的展示层：触发输入 + 最近构建列表 + 日志。
// 从 screen/GithubPanel.js 原样外提（无行为变化）：纯展示，状态与动作由宿主经 props 注入。

import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { FieldHint, FieldLabel, GhostButton, PrimaryButton } from '../../../ui/index.js';

export default function BuildSection({
  styles,
  theme,
  t,
  buildWorkflow,
  setBuildWorkflow,
  buildBusy,
  buildRuns,
  buildLog,
  buildNotice,
  branch,
  onRefresh,
  onSubmit,
  onOpenLog,
}) {
  return (
    <View style={styles.formCard}>
      <FieldLabel>{t('workspace.github.build.title')}</FieldLabel>
      <TextInput
        style={styles.input}
        value={buildWorkflow}
        onChangeText={setBuildWorkflow}
        placeholder={t('workspace.github.build.workflowPlaceholder')}
        placeholderTextColor={theme.colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <FieldHint>{t('workspace.github.build.hint', { branch: branch || '-' })}</FieldHint>
      <View style={styles.actions}>
        <PrimaryButton
          title={buildBusy ? t('workspace.github.build.busy') : t('workspace.github.build.action')}
          small
          onPress={onSubmit}
        />
        <GhostButton
          title={t('workspace.github.build.refresh')}
          small
          onPress={onRefresh}
        />
      </View>
      {buildNotice ? <FieldHint>{buildNotice}</FieldHint> : null}
      {buildRuns.map(run => (
        <TouchableOpacity
          key={run.id}
          style={styles.manageRow}
          onPress={() => onOpenLog(run.id)}
          activeOpacity={0.8}
        >
          <Ionicons
            name={run.status === 'completed'
              ? (run.conclusion === 'success' ? 'checkmark-circle' : 'close-circle')
              : 'sync-circle'}
            size={16}
            color={run.status === 'completed' && run.conclusion === 'success'
              ? theme.colors.primary
              : theme.colors.textMuted}
          />
          <Text style={styles.historyText} numberOfLines={1}>
            {`#${run.id} ${run.displayTitle || run.name}`}
          </Text>
          <Text style={styles.historyMeta}>
            {run.status === 'completed' ? (run.conclusion || 'done') : run.status}
          </Text>
        </TouchableOpacity>
      ))}
      {buildRuns.length === 0 ? (
        <FieldHint>{t('workspace.github.build.noRuns')}</FieldHint>
      ) : null}
      {buildLog ? (
        <>
          <FieldLabel>{`#${buildLog.runId} ${t('workspace.github.build.logTitle')}`}</FieldLabel>
          <Text style={styles.skippedList} selectable numberOfLines={150}>
            {buildLog.text}
          </Text>
        </>
      ) : null}
    </View>
  );
}
