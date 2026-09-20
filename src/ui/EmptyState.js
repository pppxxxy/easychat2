import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext';

export default function EmptyState({
  icon = 'albums-outline',
  title,
  description,
  action,
  style,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  return (
    <View style={[styles.container, style]}>
      <View style={styles.iconBadge}>
        <Ionicons name={icon} size={32} color={theme.colors.primarySoft} />
      </View>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {description ? <Text style={styles.description}>{description}</Text> : null}
      {action ? <View style={styles.actionWrap}>{action}</View> : null}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.xl,
    paddingVertical: tokens.spacing.xxl,
  },
  iconBadge: {
    width: 68,
    height: 68,
    borderRadius: tokens.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primaryAlpha(0.14),
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primaryMutedAlpha(0.35),
    marginBottom: tokens.spacing.md,
  },
  title: {
    color: theme.colors.text,
    fontSize: fonts.scaled(17),
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: tokens.spacing.xs,
  },
  description: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(13),
    lineHeight: fonts.scaled(19),
    textAlign: 'center',
    maxWidth: 280,
  },
  actionWrap: {
    marginTop: tokens.spacing.lg,
  },
});
