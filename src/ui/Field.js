import React, { useMemo } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useTheme } from '../theme/ThemeContext';

export function FieldLabel({ children, style }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return <Text style={[styles.label, style]}>{children}</Text>;
}

export function FieldHint({ children, style }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return <Text style={[styles.hint, style]}>{children}</Text>;
}

// 统一输入框：高度、圆角、占位色与多行支持。
export function TextField({ style, multiline = false, ...props }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <TextInput
      style={[styles.input, multiline && styles.inputMultiline, style]}
      placeholderTextColor={theme.colors.textFaint}
      multiline={multiline}
      {...props}
    />
  );
}

export function FieldGroup({ label, hint, children, style }) {
  const { tokens } = useTheme();
  return (
    <View style={[{ marginBottom: tokens.spacing.md }, style]}>
      {label ? <FieldLabel>{label}</FieldLabel> : null}
      {children}
      {hint ? <FieldHint>{hint}</FieldHint> : null}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  label: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(13),
    fontWeight: '700',
    marginBottom: tokens.spacing.xs + 2,
  },
  hint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginTop: tokens.spacing.xs + 2,
  },
  input: {
    minHeight: tokens.metrics.fieldHeight,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
    color: theme.colors.text,
    fontSize: fonts.scaled(14),
  },
  inputMultiline: {
    minHeight: tokens.metrics.fieldHeight * 2,
    textAlignVertical: 'top',
    paddingTop: tokens.spacing.md,
  },
});