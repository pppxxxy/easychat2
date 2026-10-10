// 面板内确认条（P4-4）。
//
// 背景：破坏性操作的确认此前一律走 `Alert.alert`（全仓 90 处）。系统弹框的问题不是难看，
// 而是**它打断的是整个屏幕**——用户在文件面板里删一个文件，弹框却盖住整个工作区，还得
// 先读完两行字才知道删的是哪个。面板内确认条把「问什么」留在**它问的那件事旁边**。
//
// 分工（不打算把所有 Alert 都换掉）：
// - **面板内确认条**：用户主动发起的、可撤销性低的操作（删除 / 覆盖 / 清空）——他知道自己
//   刚点了什么，只需要一次确认。
// - **系统 Alert**：必须打断的、用户没预期的（报错、权限被拒、需要立刻知道的失败）。
//
// 纯展示组件：不持有待确认状态，宿主决定「现在在等哪一次确认」（不同面板的确认对象不同，
// 收进组件反而要把宿主的业务状态搬进来）。

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export default function ConfirmBar({
  title,
  body = '',
  confirmLabel,
  cancelLabel,
  busy = false,
  destructive = true,
  onConfirm,
  onCancel,
  theme,
  fonts,
  tokens,
}) {
  const styles = createStyles(theme, fonts, tokens);
  return (
    <View style={styles.bar}>
      <View style={styles.textBlock}>
        <Text style={styles.title} numberOfLines={2}>{title}</Text>
        {body ? <Text style={styles.body} numberOfLines={3}>{body}</Text> : null}
      </View>
      <TouchableOpacity
        style={styles.cancel}
        onPress={onCancel}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={styles.cancelText}>{cancelLabel}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.confirm, destructive && styles.confirmDanger, busy && styles.disabled]}
        onPress={onConfirm}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={[styles.confirmText, destructive && styles.confirmTextDanger]}>{confirmLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

function createStyles(theme, fonts, tokens) {
  return StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: 12,
      marginBottom: 10,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: tokens.radius.md,
      backgroundColor: theme.colors.surfaceAlt,
      borderWidth: tokens.border.thin,
      borderColor: theme.colors.surfaceBorder,
    },
    textBlock: { flex: 1, marginRight: 8 },
    title: { color: theme.colors.text, fontSize: fonts.scaled(12), fontWeight: '600' },
    body: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginTop: 2 },
    cancel: { paddingHorizontal: 10, paddingVertical: 6 },
    cancelText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600' },
    confirm: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: tokens.radius.sm,
      backgroundColor: theme.colors.primary,
    },
    confirmDanger: { backgroundColor: theme.colors.danger },
    confirmText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(12), fontWeight: '700' },
    confirmTextDanger: { color: '#fff' },
    disabled: { opacity: 0.5 },
  });
}
