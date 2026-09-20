// 设计令牌：间距、圆角、描边、图标尺寸与阴影。
// 与 theme.colors / fonts.scaled 配合，统一全 App 的视觉尺寸来源。
// 新增界面或公共组件一律从这里取常量，不再散落内联数值。

import { Platform } from 'react-native';

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
  bubble: 18,
};

export const border = {
  hairline: 0.5,
  thin: 1,
  thick: 1.5,
};

export const iconSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
};

export const opacity = {
  disabled: 0.45,
  muted: 0.7,
};

// 跨平台阴影：level 1（卡片）/ 2（弹窗、浮层）/ 3（底部按钮、强调浮起）。
export function elevation(level, theme) {
  const shadowColor = (theme && theme.colors && theme.colors.text) || '#000000';
  const config = {
    1: { shadowOpacity: 0.12, shadowRadius: 6, elevation: 2, y: 2 },
    2: { shadowOpacity: 0.22, shadowRadius: 14, elevation: 8, y: 6 },
    3: { shadowOpacity: 0.3, shadowRadius: 10, elevation: 4, y: 3 },
  }[level] || { shadowOpacity: 0.12, shadowRadius: 6, elevation: 2, y: 2 };

  if (Platform.OS === 'android') {
    return { elevation: config.elevation };
  }
  return {
    shadowColor,
    shadowOffset: { width: 0, height: config.y },
    shadowOpacity: config.shadowOpacity,
    shadowRadius: config.shadowRadius,
  };
}

// 常用布局常量：卡片、列表、按钮的默认规格。
export const metrics = {
  cardPadding: spacing.lg,
  cardRadius: radius.lg,
  cardGap: spacing.md,
  buttonHeight: 44,
  buttonRadius: radius.md,
  fieldHeight: 44,
  rowMinHeight: 48,
  avatarSm: 34,
  avatarMd: 40,
};

export const tokens = {
  spacing,
  radius,
  border,
  iconSize,
  opacity,
  metrics,
  elevation,
};

export default tokens;
