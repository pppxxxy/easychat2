// A3 二期的计划进度条（W1 从 ChatPanel 外提）。
//
// update_plan 的清单只读展示——多步任务执行中对用户可见「做到哪一步了」；会话边界清空，
// 纯展示不落盘。I2：read 模式 + 计划未完成时，底部给「批准并执行」（切模式 + 注入确认消息）。
//
// 折叠状态归本组件自己（原先挂在 ChatPanel 上，白白占一行 state）。

import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../../theme/ThemeContext.js';
import { useTranslation } from '../../i18n/I18nContext.js';

const STEP_ICONS = Object.freeze({
  done: 'checkmark-circle',
  in_progress: 'play-circle',
  pending: 'ellipse-outline',
});

export default function AgentPlanPanel({ plan = [], canApprove = false, sending = false, onApprove = null }) {
  const { theme, fonts } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const [collapsed, setCollapsed] = useState(false);
  const steps = Array.isArray(plan) ? plan : [];
  // 新计划到达时自动展开（原先由 ChatPanel 在 update_plan 事件里 setPlanCollapsed(false)）。
  // 用「清单指纹」判断新计划：状态推进（pending→done）不重展开——用户收起后不该被打扰。
  const planKey = useMemo(() => steps.map(item => String(item && item.step)).join('|'), [steps]);
  useEffect(() => { setCollapsed(false); }, [planKey]);

  if (steps.length === 0) return null;
  const done = steps.filter(item => item.status === 'done').length;

  return (
    <View style={styles.panel}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setCollapsed(value => !value)}
        activeOpacity={0.8}
      >
        <Ionicons name="list-outline" size={14} color={theme.colors.primary} />
        <Text style={styles.title} numberOfLines={1}>
          {t('workspace.chat.plan.title', { done, total: steps.length })}
        </Text>
        <Ionicons
          name={collapsed ? 'chevron-down' : 'chevron-up'}
          size={14}
          color={theme.colors.textFaint}
        />
      </TouchableOpacity>
      {collapsed ? null : steps.map((item, index) => (
        <View key={`${index}-${item.step}`} style={styles.row}>
          <Ionicons
            name={STEP_ICONS[item.status] || STEP_ICONS.pending}
            size={14}
            color={item.status === 'done' ? theme.colors.primary : theme.colors.textMuted}
          />
          <Text
            style={[styles.step, item.status === 'done' && styles.stepDone]}
            numberOfLines={1}
          >
            {item.step}
          </Text>
        </View>
      ))}
      {canApprove ? (
        <TouchableOpacity
          style={styles.approvalButton}
          onPress={() => { if (!sending && typeof onApprove === 'function') onApprove(); }}
          activeOpacity={0.8}
        >
          <Ionicons name="checkmark-done-outline" size={14} color={theme.colors.primary} />
          <Text style={styles.approvalText}>{t('workspace.chat.planApproval.action')}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const createStyles = (theme, fonts) => StyleSheet.create({
  panel: {
    marginHorizontal: 12, marginBottom: 8, padding: 10, borderRadius: 10,
    backgroundColor: theme.colors.surface,
  },
  header: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(12.5), fontWeight: '600', marginLeft: 6 },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  step: { color: theme.colors.text, fontSize: fonts.scaled(12), marginLeft: 6, flex: 1 },
  stepDone: { color: theme.colors.textFaint, textDecorationLine: 'line-through' },
  approvalButton: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  approvalText: { color: theme.colors.primary, fontSize: fonts.scaled(12), marginLeft: 6 },
});
