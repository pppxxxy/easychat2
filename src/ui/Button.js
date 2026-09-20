import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext';

export function PrimaryButton({
  title,
  onPress,
  icon,
  disabled = false,
  loading = false,
  small = false,
  style,
  textStyle,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const isDisabled = disabled || loading;
  return (
    <TouchableOpacity
      style={[styles.base, small ? styles.small : styles.regular, styles.primary, isDisabled && styles.disabled, style]}
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.85}
    >
      {loading ? (
        <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
      ) : (
        <View style={styles.content}>
          {icon ? (
            <Ionicons name={icon} size={tokens.iconSize.md} color={theme.colors.primaryContrast} />
          ) : null}
          <Text style={[styles.primaryText, icon ? styles.textSpaced : null, textStyle]}>{title}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

export function GhostButton({
  title,
  onPress,
  icon,
  disabled = false,
  small = false,
  style,
  textStyle,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <TouchableOpacity
      style={[styles.base, small ? styles.small : styles.regular, styles.ghost, disabled && styles.disabled, style]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
    >
      <View style={styles.content}>
        {icon ? (
          <Ionicons name={icon} size={tokens.iconSize.md} color={theme.colors.primarySoft} />
        ) : null}
        <Text style={[styles.ghostText, icon ? styles.textSpaced : null, textStyle]}>{title}</Text>
      </View>
    </TouchableOpacity>
  );
}

export function IconButton({ name, onPress, disabled = false, size = 'md', color, hitSlop = 8, accessibilityLabel, style }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const iconSize = tokens.iconSize[size] || tokens.iconSize.md;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      activeOpacity={0.7}
      style={[disabled && styles.disabled, style]}
    >
      <Ionicons name={name} size={iconSize} color={color || theme.colors.textMuted} />
    </TouchableOpacity>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  base: {
    borderRadius: tokens.metrics.buttonRadius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  regular: { height: tokens.metrics.buttonHeight, paddingHorizontal: tokens.spacing.lg },
  small: { height: tokens.metrics.buttonHeight * 0.72, paddingHorizontal: tokens.spacing.md },
  content: { flexDirection: 'row', alignItems: 'center' },
  textSpaced: { marginLeft: tokens.spacing.sm },
  primary: { backgroundColor: theme.colors.primary },
  primaryText: {
    color: theme.colors.primaryContrast,
    fontWeight: '800',
    fontSize: fonts.scaled(15),
  },
  ghost: {
    backgroundColor: 'transparent',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  ghostText: {
    color: theme.colors.primarySoft,
    fontWeight: '700',
    fontSize: fonts.scaled(15),
  },
  disabled: { opacity: tokens.opacity.disabled },
});