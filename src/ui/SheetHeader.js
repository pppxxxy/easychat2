import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext';

// 弹窗标题行：标题 + 关闭按钮，可选左侧返回。
export default function SheetHeader({ title, onClose, onBack, closeLabel = '关闭' }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <View style={styles.header}>
      {onBack ? (
        <TouchableOpacity onPress={onBack} hitSlop={8} accessibilityLabel="返回" style={styles.back}>
          <Ionicons name="chevron-back" size={tokens.iconSize.lg} color={theme.colors.textMuted} />
        </TouchableOpacity>
      ) : null}
      <Text style={styles.title} numberOfLines={1}>{title}</Text>
      {onClose ? (
        <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityLabel={closeLabel}>
          <Ionicons name="close" size={tokens.iconSize.lg} color={theme.colors.textMuted} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  back: { marginRight: tokens.spacing.sm },
  title: {
    flex: 1,
    color: theme.colors.text,
    fontSize: fonts.scaled(17),
    fontWeight: '800',
  },
});