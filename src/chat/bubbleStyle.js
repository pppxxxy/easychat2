// 气泡风格偏好的纯决策层：把「圆润 / 卡片 / 无底纹」三种风格解析成一组具体样式值。
// 刻意不 import react-native：供 chatStyles 工厂消费，也可在 Node 里直接断言/回归。
//
// 三种风格语义：
//   rounded（默认）——大圆角 + 尾角、彩色用户气泡、带阴影；
//   card          ——统一中等圆角、无尾角，偏阅读；
//   plain         ——去底色/阴影/内边距，直角，仅靠左右对齐区分角色。

import { BUBBLE_STYLES } from '../theme/themes.js';

export function normalizeBubbleStyle(value) {
  return BUBBLE_STYLES.includes(value) ? value : 'rounded';
}

// 返回一组与主题/令牌相关的关键样式值。theme.colors 与 tokens.radius 为必需入参。
export function resolveBubbleStyle(bubbleStyle, theme, tokens) {
  const style = normalizeBubbleStyle(bubbleStyle);
  const plain = style === 'plain';
  const card = style === 'card';
  const colors = (theme && theme.colors) || {};
  const radius = (tokens && tokens.radius) || {};
  const bubbleRadius = plain ? 0 : (card ? radius.md : radius.bubble);
  return {
    style,
    plain,
    card,
    bubbleRadius,
    // 圆润才有「收角」方向感；卡片与无底纹四角一致。
    tailRadius: (plain || card) ? bubbleRadius : radius.tail,
    userBackground: plain ? 'transparent' : colors.primary,
    assistantBackground: plain ? 'transparent' : colors.bubbleAssistant,
    // 用户气泡底即 primary：无底纹时落在页面背景上改用正文色，其余用 primaryContrast。
    userTextColor: plain ? colors.text : colors.primaryContrast,
    bubblePaddingHorizontal: plain ? 0 : 14,
    bubblePaddingVertical: plain ? 2 : 10,
    hasShadow: !plain,
    // 媒体消息（图片/表情包/内联配图）圆角：随风格走。圆润/卡片用中等圆角（与现状一致），
    // 无底纹去底色后图片也应为直角，避免「透明气泡里飘一张圆角图」的割裂。
    mediaRadius: plain ? 0 : radius.md,
  };
}