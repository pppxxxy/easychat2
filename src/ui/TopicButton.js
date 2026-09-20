import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext';

// 「教学」入口按钮：问号图标 + 文字，各界面「教学」入口统一使用。
export default function TopicButton({
  onPress,
  label = '教学',
  accessibilityLabel,
  disabled = false,
  style,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <TouchableOpacity
      style={[styles.button, disabled && styles.disabled, style]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
    >
      <Ionicons name="help-circle-outline" size={tokens.iconSize.sm} color={theme.colors.primarySoft} />
      <Text style={styles.text}>{label}</Text>
    </TouchableOpacity>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.pill,
    paddingVertical: tokens.spacing.xs,
    paddingHorizontal: tokens.spacing.sm + 2,
  },
  text: {
    color: theme.colors.primarySoft,
    fontWeight: '700',
    fontSize: fonts.scaled(12),
    marginLeft: tokens.spacing.xs + 1,
  },
  disabled: { opacity: tokens.opacity.disabled },
});