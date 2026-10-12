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

// 三个「按开关注册」的能力：与 capabilityViewModel 的 shellEnabled / pythonEnabled / gitEnabled
// 一一对应（enabledKey 就是那几个字段名，不另起一套叫法）。
// 为什么必须渲染它们：这三个标志此前**只被测试消费**——卡片只画 model.tools，于是
// 「能力说明如实」只落在数据层，用户看到一行工具名，既不知道哪个能力开着，也不知道
// 某个工具为什么不在清单里（开关没开？根目录是外部文件夹？原生模块不可用？）。
// 名字复用工具卡词条（同一能力不该有两套叫法），git 单补一条；tools 是该开关真正管着的
// 工具名，直接摆在用户眼前，「未生效 ⇒ 所以清单里没有它」才看得出来。
// tests/workspaceCapabilities.test.mjs 把这张表与 capabilityViewModel 逐条对账。
const CAPABILITY_SWITCHES = [
  { id: 'shell', labelKey: 'workspace.toolCard.name.shell', enabledKey: 'shellEnabled', tools: ['run_shell'] },
  { id: 'python', labelKey: 'workspace.toolCard.name.python', enabledKey: 'pythonEnabled', tools: ['run_python'] },
  { id: 'git', labelKey: 'workspace.capability.switch.git', enabledKey: 'gitEnabled', tools: ['git_status', 'git_diff', 'git_log'] },
];

export default function WorkspaceCapabilitiesCard({ settings, shellAvailable = false, pythonAvailable = false, mcpToolNames = [] }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const model = useMemo(
    () => capabilityViewModel(settings, { shellAvailable, pythonAvailable, mcpToolNames }),
    [settings, shellAvailable, pythonAvailable, mcpToolNames]
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

      <Text style={styles.limitsTitle}>{t('workspace.capability.switchesTitle')}</Text>
      {CAPABILITY_SWITCHES.map(item => {
        // 状态直接读 capabilityViewModel 的标志（与工具清单同源，见 capabilities.js 的
        // switchedCapabilities）——这里不再自己判一遍开关，避免又一处平行定义。
        const on = model[item.enabledKey] === true;
        return (
          <View key={item.id} style={styles.switchRow}>
            <Ionicons
              name={on ? 'checkmark-circle' : 'ellipse-outline'}
              size={14}
              color={on ? theme.colors.primary : theme.colors.textMuted}
            />
            <Text style={styles.switchText}>
              {t('workspace.capability.switch.row', {
                name: t(item.labelKey),
                state: t(on ? 'workspace.capability.switch.on' : 'workspace.capability.switch.off'),
                tools: item.tools.join('、'),
              })}
            </Text>
          </View>
        );
      })}
      <Text style={styles.switchNote}>{t('workspace.capability.switch.offNote')}</Text>

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
  // 三个开关的状态行：与上面「边界」条目同一视觉层级，但用状态图标区分开/关。
  switchRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 5 },
  switchText: {
    flex: 1,
    color: theme.colors.text,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(17),
    marginLeft: 5,
  },
  switchNote: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(10.5),
    lineHeight: fonts.scaled(16),
    marginTop: 2,
    marginBottom: 2,
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
