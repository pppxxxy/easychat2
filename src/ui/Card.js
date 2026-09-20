import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext';

// 统一卡片：背景、圆角、描边与可选阴影；可带标题行与右侧操作。
export default function Card({
  children,
  title,
  titleIcon,
  right,
  padded = true,
  elevated = false,
  style,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const hasHeader = Boolean(title) || Boolean(right);
  return (
    <View style={[styles.card, padded && styles.padded, elevated && styles.elevated, style]}>
      {hasHeader ? (
        <View style={styles.header}>
          <View style={styles.titleRow}>
            {titleIcon ? (
              <Ionicons name={titleIcon} size={tokens.iconSize.md} color={theme.colors.primaryMuted} />
            ) : null}
            {title ? (
              <Text style={[styles.title, titleIcon ? styles.titleSpaced : null]}>{title}</Text>
            ) : null}
          </View>
          {right ? <View style={styles.right}>{right}</View> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.metrics.cardRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginBottom: tokens.metrics.cardGap,
  },
  padded: { padding: tokens.metrics.cardPadding },
  elevated: tokens.elevation(1, theme),
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.sm,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  title: {
    color: theme.colors.text,
    fontSize: fonts.scaled(15),
    fontWeight: '800',
  },
  titleSpaced: { marginLeft: tokens.spacing.sm },
  right: { flexDirection: 'row', alignItems: 'center' },
});