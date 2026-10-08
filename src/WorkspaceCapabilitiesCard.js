// 工作区能力说明卡片：把 1→5 的工具循环与当前边界如实列出来。
//
// 放在设置页工作区卡片里（可折叠，默认收起，避免把设置页撑长），面板顶部也会用。
// 文案全部走 t()，内容结构来自 workspace/capabilities.js（纯数据，可单测）。

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { CollapsibleSection } from './ui/index.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';
import { capabilityViewModel } from './workspace/capabilities.js';

export default function WorkspaceCapabilitiesCard({ settings, shellAvailable = false, pythonAvailable = false }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const model = useMemo(
    () => capabilityViewModel(settings, { shellAvailable, pythonAvailable }),
    [settings, shellAvailable, pythonAvailable]
  );

  return (
    <CollapsibleSection
      title={t(model.titleKey)}
      icon="git-branch-outline"
      style={styles.wrapper}
    >
      <Text style={styles.intro}>{t(model.introKey)}</Text>

      <View style={styles.stepList}>
        {model.steps.map((step, index) => (
          <View key={step.id} style={styles.stepRow}>
            <View style={styles.stepBadge}>
              <Text style={styles.stepBadgeText}>{index + 1}</Text>
            </View>
            <Text style={styles.stepText}>{t(step.labelKey)}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.limitsTitle}>{t(model.limitsTitleKey)}</Text>
      {model.limits.map(limit => (
        <View key={limit.id} style={styles.limitRow}>
          <Ionicons name="information-circle-outline" size={14} color={theme.colors.textMuted} />
          <Text style={styles.limitText}>{t(limit.labelKey)}</Text>
        </View>
      ))}

      <Text style={styles.tools}>
        {t('workspace.capability.toolsNow', {
          tools: model.tools.length ? model.tools.join('、') : t('workspace.capability.toolsNone'),
        })}
      </Text>
    </CollapsibleSection>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  wrapper: { marginTop: 14 },
  intro: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginBottom: 10,
  },
  stepList: { marginBottom: 12 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  stepBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    marginTop: 1,
  },
  stepBadgeText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(11), fontWeight: '700' },
  stepText: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18) },
  limitsTitle: {
    color: theme.colors.text,
    fontSize: fonts.scaled(12),
    fontWeight: '600',
    marginBottom: 6,
  },
  limitRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 5 },
  limitText: {
    flex: 1,
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(17),
    marginLeft: 5,
  },
  tools: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(17),
    marginTop: 8,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.surfaceBorder,
    paddingTop: 8,
  },
});
