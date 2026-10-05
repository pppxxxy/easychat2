// 新建项目面板：从 GitHub 拉一个仓库到工作区，或在已有项目之间切换。
//
// 纯展示 + 回调：拉取动作由 WorkspacePanel 执行（那里有工作区 store 与 GitHub 令牌），
// 这里只负责收集 owner/repo 与分支、展示项目列表与当前选择。

import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';

export default function WorkspaceProjectSheet({
  visible,
  onClose,
  projects = [],
  activeProjectId = '',
  onSelectProject,
  onPull,
  pulling = false,
}) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');

  const canPull = !pulling && String(repo).trim().length > 0;

  const submit = () => {
    if (!canPull || !onPull) return;
    onPull({ repo: String(repo).trim(), branch: String(branch).trim() });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{t('workspace.project.title')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={20} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.sheetBody} contentContainerStyle={styles.sheetBodyContent}>
            <Text style={styles.label}>{t('workspace.project.repo')}</Text>
            <TextInput
              style={styles.input}
              value={repo}
              onChangeText={setRepo}
              placeholder={t('workspace.project.repo.placeholder')}
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!pulling}
            />

            <Text style={styles.label}>{t('workspace.project.branch')}</Text>
            <TextInput
              style={styles.input}
              value={branch}
              onChangeText={setBranch}
              placeholder={t('workspace.project.branch.placeholder')}
              placeholderTextColor={theme.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!pulling}
            />

            <TouchableOpacity
              style={[styles.primaryButton, !canPull && styles.primaryButtonDisabled]}
              onPress={submit}
              disabled={!canPull}
              activeOpacity={0.85}
            >
              {pulling ? (
                <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
              ) : (
                <Ionicons name="cloud-download-outline" size={16} color={theme.colors.primaryContrast} />
              )}
              <Text style={styles.primaryButtonText}>
                {pulling ? t('workspace.project.pulling') : t('workspace.project.pull')}
              </Text>
            </TouchableOpacity>
            <Text style={styles.hint}>{t('workspace.project.hint')}</Text>

            <Text style={styles.sectionLabel}>{t('workspace.project.existing')}</Text>
            {projects.length === 0 ? (
              <Text style={styles.hint}>{t('workspace.project.empty')}</Text>
            ) : (
              projects.map(item => {
                const active = String(item.id) === String(activeProjectId);
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.projectRow, active && styles.projectRowActive]}
                    onPress={() => onSelectProject && onSelectProject(item.id)}
                    activeOpacity={0.8}
                  >
                    <Ionicons
                      name={active ? 'radio-button-on' : 'radio-button-off'}
                      size={16}
                      color={active ? theme.colors.primary : theme.colors.textFaint}
                    />
                    <View style={styles.projectTextBlock}>
                      <Text style={[styles.projectName, active && styles.projectNameActive]} numberOfLines={1}>
                        {item.name || item.id}
                      </Text>
                      {item.repo ? (
                        <Text style={styles.hint} numberOfLines={1}>{item.repo}</Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderTopLeftRadius: tokens.radius.lg,
    borderTopRightRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.divider,
    maxHeight: '80%',
    paddingBottom: 10,
    ...tokens.elevation(2, theme),
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  sheetTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '800' },
  sheetBody: { flexGrow: 0 },
  sheetBodyContent: { paddingHorizontal: 16, paddingBottom: 16 },
  label: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    fontWeight: '700',
    marginTop: 14,
    marginBottom: 6,
  },
  sectionLabel: {
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    fontWeight: '700',
    marginTop: 20,
    marginBottom: 8,
  },
  input: {
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: fonts.scaled(13),
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingVertical: 11,
    marginTop: 16,
  },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonText: {
    color: theme.colors.primaryContrast,
    fontSize: fonts.scaled(13),
    fontWeight: '700',
    marginLeft: 6,
  },
  hint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 8,
  },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
  projectRowActive: {
    backgroundColor: theme.colors.primaryAlpha(0.15),
    borderColor: theme.colors.primary,
  },
  projectTextBlock: { flex: 1, marginLeft: 10 },
  projectName: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600' },
  projectNameActive: { color: theme.colors.primarySoft },
});
