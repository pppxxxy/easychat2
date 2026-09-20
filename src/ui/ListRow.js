import React, { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext';

// 统一列表行：左图标 + 主/副文本 + 右侧内容（chevron / 开关等）。
export default function ListRow({
  icon,
  label,
  subtitle,
  value,
  right,
  onPress,
  disabled = false,
  destructive = false,
  showChevron = false,
  style,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const Container = onPress ? TouchableOpacity : View;
  const labelColor = destructive ? theme.colors.danger : theme.colors.text;

  return (
    <Container
      style={[styles.row, disabled && styles.disabled, style]}
      onPress={onPress}
      disabled={onPress ? disabled : undefined}
      activeOpacity={0.8}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={label}
    >
      {icon ? (
        <Ionicons
          name={icon}
          size={tokens.iconSize.lg}
          color={destructive ? theme.colors.danger : theme.colors.primaryMuted}
          style={styles.icon}
        />
      ) : null}
      <View style={styles.textWrap}>
        <Text style={[styles.label, { color: labelColor }]} numberOfLines={1}>{label}</Text>
        {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {value ? <Text style={styles.value} numberOfLines={1}>{value}</Text> : null}
      {right ? <View style={styles.right}>{right}</View> : null}
      {showChevron ? (
        <Ionicons name="chevron-forward" size={tokens.iconSize.md} color={theme.colors.textFaint} />
      ) : null}
    </Container>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: tokens.metrics.rowMinHeight,
    paddingVertical: tokens.spacing.sm,
  },
  icon: { marginRight: tokens.spacing.md },
  textWrap: { flex: 1 },
  label: { fontSize: fonts.scaled(15), fontWeight: '600' },
  subtitle: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    marginTop: tokens.spacing.xs,
  },
  value: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(14),
    marginLeft: tokens.spacing.sm,
    maxWidth: '45%',
  },
  right: { marginLeft: tokens.spacing.sm },
  disabled: { opacity: tokens.opacity.disabled },
});