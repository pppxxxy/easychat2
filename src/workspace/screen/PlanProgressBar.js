// A3 二期：工作区对话里的计划进度条（`update_plan` 的清单，只读展示）。
//
// 多步任务执行中让用户看到「做到哪一步了」；会话边界清空，纯展示不落盘。
// 从 `ChatPanel.js` 抽出（该文件卡在架构棘轮基线上，只许减不许增）——顺带让它
// 成为 P1「拆面板」的第一块：面板里的自成一体的部件先出去，主文件才腾得出余量。
//
// 折叠状态仍由宿主持有并传下来：宿主在收到新计划时会主动展开（`setPlanCollapsed(false)`），
// 那个时机只有宿主知道，搬进组件会丢掉「新计划自动展开」这个行为。

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { hexToRgba } from '../../theme/themes.js';

export default function PlanProgressBar({
  plan,
  collapsed = false,
  onToggle = null,
  canApprove = false,
  sending = false,
  onApprove = null,
  theme,
  fonts,
  t,
}) {
  const steps = Array.isArray(plan) ? plan : [];
  if (steps.length === 0) return null;
  const styles = createStyles(theme, fonts);
  const done = steps.filter(item => item && item.status === 'done').length;

  return (
    <View style={styles.planPanel}>
      <TouchableOpacity
        style={styles.planHeader}
        onPress={onToggle || undefined}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={t('workspace.chat.plan.title', { done, total: steps.length })}
      >
        <Ionicons name="list-outline" size={14} color={theme.colors.primary} />
        <Text style={styles.planTitle} numberOfLines={1}>
          {t('workspace.chat.plan.title', { done, total: steps.length })}
        </Text>
        <Ionicons
          name={collapsed ? 'chevron-down' : 'chevron-up'}
          size={14}
          color={theme.colors.textFaint}
        />
      </TouchableOpacity>

      {collapsed ? null : steps.map((item, index) => (
        <View key={`${index}-${item.step}`} style={styles.planRow}>
          <Ionicons
            name={item.status === 'done'
              ? 'checkmark-circle'
              : (item.status === 'in_progress' ? 'play-circle' : 'ellipse-outline')}
            size={14}
            color={item.status === 'done' ? theme.colors.primary : theme.colors.textMuted}
          />
          <Text
            style={[styles.planStep, item.status === 'done' && styles.planStepDone]}
            numberOfLines={1}
          >
            {item.step}
          </Text>
        </View>
      ))}

      {/* I2：read 模式 + 计划未完成 → 提议「批准并执行」（切模式 + 注入确认消息）。 */}
      {canApprove ? (
        <TouchableOpacity
          style={styles.planApprovalButton}
          onPress={() => { if (!sending && typeof onApprove === 'function') onApprove(); }}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={t('workspace.chat.planApproval.action')}
        >
          <Ionicons name="checkmark-done-outline" size={14} color={theme.colors.primary} />
          <Text style={styles.planApprovalText}>
            {t('workspace.chat.planApproval.action')}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function createStyles(theme, fonts) {
  return StyleSheet.create({
    planPanel: {
      marginHorizontal: 12,
      marginBottom: 4,
      borderRadius: 10,
      backgroundColor: theme.colors.surfaceAlt,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    planHeader: { flexDirection: 'row', alignItems: 'center' },
    planTitle: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(12.5), fontWeight: '600', marginLeft: 6 },
    planRow: { flexDirection: 'row', alignItems: 'center', marginTop: 5 },
    planStep: { color: theme.colors.text, fontSize: fonts.scaled(12), marginLeft: 6, flex: 1 },
    planStepDone: { color: theme.colors.textFaint, textDecorationLine: 'line-through' },
    // I2：计划批准按钮（计划卡片内的轻量行按钮，不引入大按钮组件）。
    planApprovalButton: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 8,
      paddingVertical: 7,
      paddingHorizontal: 10,
      borderRadius: 8,
      backgroundColor: hexToRgba(theme.colors.primary, 0.14),
    },
    planApprovalText: {
      color: theme.colors.primary,
      fontSize: fonts.scaled(12),
      fontWeight: '600',
      marginLeft: 6,
      flex: 1,
    },
  });
}
