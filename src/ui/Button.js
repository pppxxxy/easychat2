import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';

function PressScaleTouchable({ children, scale: pressScale = 0.97, disabled, style, ...props }) {
  const anim = React.useRef(new Animated.Value(1)).current;

  const onPressIn = React.useCallback(() => {
    Animated.timing(anim, {
      toValue: pressScale,
      duration: 80,
      useNativeDriver: true,
    }).start();
  }, [anim, pressScale]);

  const onPressOut = React.useCallback(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 120,
      useNativeDriver: true,
    }).start();
  }, [anim]);

  return (
    <TouchableOpacity
      {...props}
      disabled={disabled}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      activeOpacity={0.85}
      style={style}
    >
      <Animated.View style={{ transform: [{ scale: anim }] }}>
        {children}
      </Animated.View>
    </TouchableOpacity>
  );
}

export function PrimaryButton({
  title,
  onPress,
  icon,
  disabled = false,
  loading = false,
  small = false,
  pill = false,
  style,
  textStyle,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const isDisabled = disabled || loading;
  return (
    <PressScaleTouchable
      style={[
        styles.base,
        small ? styles.small : styles.regular,
        pill && styles.pill,
        styles.primary,
        isDisabled && styles.disabled,
        tokens.elevation(1, theme),
        style,
      ]}
      onPress={onPress}
      disabled={isDisabled}
    >
      {loading ? (
        <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
      ) : (
        <View style={styles.content}>
          {icon ? (
            <Ionicons name={icon} size={small ? tokens.iconSize.sm : tokens.iconSize.md} color={theme.colors.primaryContrast} />
          ) : null}
          <Text style={[styles.primaryText, small && styles.smallText, icon ? styles.textSpaced : null, textStyle]}>{title}</Text>
        </View>
      )}
    </PressScaleTouchable>
  );
}

export function SecondaryButton({
  title,
  onPress,
  icon,
  disabled = false,
  loading = false,
  small = false,
  pill = false,
  style,
  textStyle,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const isDisabled = disabled || loading;
  return (
    <PressScaleTouchable
      style={[
        styles.base,
        small ? styles.small : styles.regular,
        pill && styles.pill,
        styles.secondary,
        isDisabled && styles.disabled,
        style,
      ]}
      onPress={onPress}
      disabled={isDisabled}
    >
      {loading ? (
        <ActivityIndicator size="small" color={theme.colors.primarySoft} />
      ) : (
        <View style={styles.content}>
          {icon ? (
            <Ionicons name={icon} size={small ? tokens.iconSize.sm : tokens.iconSize.md} color={theme.colors.primarySoft} />
          ) : null}
          <Text style={[styles.secondaryText, small && styles.smallText, icon ? styles.textSpaced : null, textStyle]}>{title}</Text>
        </View>
      )}
    </PressScaleTouchable>
  );
}

export function DangerButton({
  title,
  onPress,
  icon,
  disabled = false,
  loading = false,
  small = false,
  pill = false,
  style,
  textStyle,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const isDisabled = disabled || loading;
  return (
    <PressScaleTouchable
      style={[
        styles.base,
        small ? styles.small : styles.regular,
        pill && styles.pill,
        styles.danger,
        isDisabled && styles.disabled,
        tokens.elevation(1, theme),
        style,
      ]}
      onPress={onPress}
      disabled={isDisabled}
    >
      {loading ? (
        <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
      ) : (
        <View style={styles.content}>
          {icon ? (
            <Ionicons name={icon} size={small ? tokens.iconSize.sm : tokens.iconSize.md} color={theme.colors.primaryContrast} />
          ) : null}
          <Text style={[styles.primaryText, small && styles.smallText, icon ? styles.textSpaced : null, textStyle]}>{title}</Text>
        </View>
      )}
    </PressScaleTouchable>
  );
}

export function GhostButton({
  title,
  onPress,
  icon,
  disabled = false,
  small = false,
  pill = false,
  style,
  textStyle,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <PressScaleTouchable
      style={[
        styles.base,
        small ? styles.small : styles.regular,
        pill && styles.pill,
        styles.ghost,
        disabled && styles.disabled,
        style,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <View style={styles.content}>
        {icon ? (
          <Ionicons name={icon} size={small ? tokens.iconSize.sm : tokens.iconSize.md} color={theme.colors.primarySoft} />
        ) : null}
        <Text style={[styles.ghostText, small && styles.smallText, icon ? styles.textSpaced : null, textStyle]}>{title}</Text>
      </View>
    </PressScaleTouchable>
  );
}

export function IconButton({ name, onPress, disabled = false, size = 'md', color, hitSlop = 8, accessibilityLabel, style }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const iconSize = tokens.iconSize[size] || tokens.iconSize.md;
  return (
    <PressScaleTouchable
      onPress={onPress}
      disabled={disabled}
      scale={0.88}
      hitSlop={hitSlop}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
    >
      <View style={[disabled && styles.disabled, style]}>
        <Ionicons name={name} size={iconSize} color={color || theme.colors.textMuted} />
      </View>
    </PressScaleTouchable>
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
  pill: { borderRadius: tokens.radius.pill },
  content: { flexDirection: 'row', alignItems: 'center' },
  textSpaced: { marginLeft: tokens.spacing.sm },
  smallText: { fontSize: fonts.scaled(13) },
  primary: { backgroundColor: theme.colors.primary },
  primaryText: {
    color: theme.colors.primaryContrast,
    fontWeight: '800',
    fontSize: fonts.scaled(15),
  },
  secondary: {
    backgroundColor: theme.colors.primaryAlpha(0.14),
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primaryMutedAlpha(0.35),
  },
  secondaryText: {
    color: theme.colors.primarySoft,
    fontWeight: '700',
    fontSize: fonts.scaled(15),
  },
  danger: { backgroundColor: theme.colors.danger },
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
