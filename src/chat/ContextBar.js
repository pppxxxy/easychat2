// 上下文条统一组件：引用条 / 附件条 / 录音条三条「临时上下文条」共用。
// 同一容器样式（圆角/边框/bgUri 变体）+ 同一左图标位 + 同一右侧动作位；
// 内容区由 children 决定（附件条在内部做横向滚动，不再撑高输入区）。

import React, { useMemo } from 'react';
import { TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '../theme/ThemeContext.js';
import { createChatStyles } from './chatStyles.js';

export default function ContextBar({
  bgUri,
  icon,
  iconDanger = false,
  actionIcon = 'close',
  onAction,
  actionDisabled = false,
  actionA11y,
  children,
}) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createChatStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  return (
    <View style={[styles.contextBar, bgUri ? styles.inputBarOverlay : styles.inputBarSurface]}>
      <Ionicons name={icon} size={16} color={iconDanger ? theme.colors.danger : theme.colors.primarySoft} />
      <View style={styles.contextBarBody}>{children}</View>
      {typeof onAction === 'function' ? (
        <TouchableOpacity
          onPress={onAction}
          disabled={actionDisabled}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={actionA11y}
        >
          <Ionicons name={actionIcon} size={16} color={theme.colors.textFaint} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
