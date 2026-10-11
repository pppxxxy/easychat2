// 工作区聊天的「本轮工具调用」折叠面板：助手消息下展示 agent 这一步做了哪些工具调用。
//
// 数据来自消息上持久化的 toolTrace（见 chat/toolTrace.js / toolTraceView.js）——纯展示，
// 默认折叠成一行「工具调用 (N)」，展开后逐条列出名字 / 参数 / 结果摘要。

import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { summarizeToolTrace } from '../chat/toolTraceView.js';

export default function AgentTrace({ trace, defaultCollapsed = true }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const steps = useMemo(() => summarizeToolTrace(trace), [trace]);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  if (steps.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setCollapsed(value => !value)}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={t('workspace.chat.trace.title', { count: steps.length })}
      >
        <Ionicons name="construct-outline" size={13} color={theme.colors.primary} />
        <Text style={styles.title} numberOfLines={1}>
          {t('workspace.chat.trace.title', { count: steps.length })}
        </Text>
        <Ionicons
          name={collapsed ? 'chevron-down' : 'chevron-up'}
          size={13}
          color={theme.colors.textFaint}
        />
      </TouchableOpacity>
      {collapsed ? null : (
        <View style={styles.body}>
          {steps.map((step, index) => (
            <View key={`${step.name}-${index}`} style={styles.step}>
              <Text style={styles.stepName}>{step.name}</Text>
              {step.args ? <Text style={styles.stepDetail} selectable>{step.args}</Text> : null}
              {step.result ? <Text style={styles.stepResult} selectable>{step.result}</Text> : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  wrap: {
    marginTop: 4,
    marginHorizontal: 2,
    borderWidth: 1,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.surface,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  title: {
    flex: 1,
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    fontWeight: '600',
  },
  body: {
    paddingHorizontal: 10,
    paddingBottom: 8,
    gap: 6,
  },
  step: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.surfaceBorder,
    paddingTop: 6,
  },
  stepName: {
    color: theme.colors.primary,
    fontSize: fonts.scaled(12),
    fontWeight: '700',
  },
  stepDetail: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(11),
    marginTop: 1,
  },
  stepResult: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    marginTop: 1,
  },
});
