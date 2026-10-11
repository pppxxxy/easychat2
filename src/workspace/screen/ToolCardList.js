// P0：工作区 agent 工具过程卡片列表。
//
// 此前工作区只有一行会闪过的 `toolStatus`（「正在读取 xxx」），用户看不到
// 「哪一步读了什么、改了什么、失败在哪」，只能等终稿。卡片模型在
// `chat/toolCardView.js`（纯函数、可 Node 直测）；本组件只负责渲染与折叠。
//
// 与聊天页的 ToolBubble 分开：那个是 web_search/web_fetch 的两阶段气泡且按「轮次+工具名」
// 折叠，这里是**逐次调用**的卡片（同一轮读三遍同一个文件 = 三张卡，那本身就是信息）。

import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { TOOL_CARD_STATUS, toolCardLabelKey } from '../../chat/toolCardView.js';

const STATUS_ICON = {
  [TOOL_CARD_STATUS.DONE]: 'checkmark-circle-outline',
  [TOOL_CARD_STATUS.ERROR]: 'alert-circle-outline',
  // 历史轨迹卡片：中性图标——**不知道成败**（轨迹里没这个信息），不标勾也不标叹号。
  [TOOL_CARD_STATUS.RECORDED]: 'document-text-outline',
};

export default function ToolCardList({ cards, theme, fonts, tokens, t }) {
  // 折叠状态由本组件自己持有：宿主不需要为它多开一行 state（ChatPanel 卡在架构棘轮上）。
  // 每轮开始时宿主会清空 cards → 本组件卸载 → 下一轮自动回到展开态，正是想要的。
  const [collapsed, setCollapsed] = useState(false);
  const list = Array.isArray(cards) ? cards : [];
  if (list.length === 0) return null;
  const failed = list.filter(item => item.status === TOOL_CARD_STATUS.ERROR).length;
  const styles = createStyles(theme, fonts, tokens);

  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setCollapsed(value => !value)}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={t('workspace.toolCard.title')}
      >
        <Ionicons
          name={collapsed ? 'chevron-forward' : 'chevron-down'}
          size={13}
          color={theme.colors.textMuted}
        />
        <Text style={styles.title}>{t('workspace.toolCard.title')}</Text>
        <Text style={styles.meta}>{t('workspace.toolCard.count', { total: list.length })}</Text>
        {failed > 0 ? (
          <Text style={styles.fail}>{t('workspace.toolCard.failed', { failed })}</Text>
        ) : null}
      </TouchableOpacity>

      {collapsed ? null : list.map(card => {
        const labelKey = toolCardLabelKey(card.name);
        // 未登记的工具**显示原始工具名**，不吞信息也不编一个不存在的中文名。
        const label = labelKey ? t(labelKey) : card.name;
        const running = card.status === TOOL_CARD_STATUS.RUNNING;
        const isError = card.status === TOOL_CARD_STATUS.ERROR;
        const recorded = card.status === TOOL_CARD_STATUS.RECORDED;
        return (
          <View key={card.id} style={styles.row}>
            <View style={styles.rowIcon}>
              {running ? (
                <ActivityIndicator size="small" color={theme.colors.primaryMuted} />
              ) : (
                <Ionicons
                  name={STATUS_ICON[card.status] || 'ellipse-outline'}
                  size={13}
                  color={isError ? theme.colors.danger : (recorded ? theme.colors.textFaint : theme.colors.primary)}
                />
              )}
            </View>
            <View style={styles.rowBody}>
              <View style={styles.rowTop}>
                <Text style={[styles.label, isError && styles.labelError]} numberOfLines={1}>{label}</Text>
                {card.summary ? (
                  <Text style={styles.summary} numberOfLines={1}>{card.summary}</Text>
                ) : null}
              </View>
              {/* 历史轨迹只回看「结果开头」；没有配对结果时如实说「未返回结果」——
                  被拒绝、报错、中止都会留下这种卡，所以不能写成「失败」。 */}
              {recorded ? (
                <Text style={styles.preview} numberOfLines={1}>
                  {card.preview || t('workspace.toolCard.noResult')}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function createStyles(theme, fonts, tokens) {
  return StyleSheet.create({
    wrap: {
      marginHorizontal: 10,
      marginBottom: 6,
      paddingVertical: 6,
      paddingHorizontal: 8,
      borderRadius: tokens.radius.md,
      backgroundColor: theme.colors.surfaceAlt,
      borderWidth: tokens.border.thin,
      borderColor: theme.colors.surfaceBorder,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    title: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), fontWeight: '600' },
    meta: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginLeft: 4 },
    fail: { color: theme.colors.danger, fontSize: fonts.scaled(11), marginLeft: 4 },
    row: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 5 },
    rowIcon: { width: 18, alignItems: 'center', justifyContent: 'center', paddingTop: 1 },
    rowBody: { flex: 1 },
    rowTop: { flexDirection: 'row', alignItems: 'center' },
    label: { color: theme.colors.text, fontSize: fonts.scaled(12), flexShrink: 0 },
    labelError: { color: theme.colors.danger },
    summary: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginLeft: 6, flex: 1 },
    preview: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  });
}
