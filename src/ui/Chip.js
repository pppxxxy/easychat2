import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext';

// 选中态 chip：用于人设、标签、尺寸、主题等二/多选场景。
export default function Chip({ label, active = false, onPress, icon, disabled = false, style, textStyle }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive, disabled && styles.disabled, style]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
    >
      {icon ? (
        <Ionicons
          name={icon}
          size={tokens.iconSize.sm}
          color={active ? theme.colors.primary : theme.colors.textMuted}
        />
      ) : null}
      <Text style={[styles.text, active && styles.textActive, icon ? styles.textSpaced : null, textStyle]} numberOfLines={1}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: tokens.radius.pill,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surfaceAlt,
    paddingVertical: tokens.spacing.xs + 2,
    paddingHorizontal: tokens.spacing.md,
    marginRight: tokens.spacing.sm,
    marginBottom: tokens.spacing.sm,
    maxWidth: '100%',
  },
  chipActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface,
  },
  text: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(13),
    fontWeight: '600',
    flexShrink: 1,
  },
  textActive: { color: theme.colors.primary },
  textSpaced: { marginLeft: tokens.spacing.xs + 2 },
  disabled: { opacity: tokens.opacity.disabled },
});