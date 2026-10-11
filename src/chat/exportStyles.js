// 导出面板（长图 / Markdown / HTML）的样式工厂。
// 从 chat/chatStyles.js 外提（2026-10-11 加三种格式预览时）：chatStyles 已 1500+ 行，
// 而导出面板是自成一体的功能（弹层 + 预览区 + 分享卡片）。
// 只含导出相关键；弹层标题仍复用 chatStyles.modalTitle（见 ConversationExportModal）。

import { StyleSheet } from 'react-native';

import { hexToRgba } from '../theme/themes.js';

export const createExportStyles = (theme, fonts, tokens) => StyleSheet.create({
  // 导出面板自带一层背板（不复用 modalBackdrop）：关闭层要铺满整屏、且弹层不能被
  // Touchable 包住——HTML 预览是 WebView，被 Touchable 包着在 Android 上会滚不动。
  // 因此水平内缩改由 exportSheet 的 marginHorizontal 提供。
  exportBackdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
  },
  // 居中 + 水平内缩层。调用方给这一层挂 pointerEvents="box-none"：本层自己不接触摸
  // （否则它的 padding 环会挡住下面铺满整屏的关闭层），子元素（弹层）照常接。
  exportSheetLayer: {
    flex: 1,
    justifyContent: 'center',
    padding: tokens.spacing.xl,
  },
  exportSheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.lg,
    padding: tokens.metrics.cardPadding,
    maxHeight: '82%',
    ...tokens.elevation(2, theme),
  },
  exportHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.sm,
  },
  exportSegments: {
    flexDirection: 'row',
    backgroundColor: hexToRgba(theme.colors.text, 0.08),
    borderRadius: tokens.radius.pill,
    padding: 3,
    marginBottom: tokens.spacing.md,
  },
  exportSegment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 7,
    borderRadius: tokens.radius.pill,
  },
  exportSegmentActive: {
    backgroundColor: theme.colors.primary,
  },
  exportSegmentText: {
    fontSize: 13,
    color: theme.colors.textMuted,
  },
  exportSegmentTextActive: {
    color: theme.colors.primaryContrast,
    fontWeight: '700',
  },
  exportHint: {
    color: theme.colors.textFaint,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: tokens.spacing.sm,
  },
  // 预览说明行：告诉用户「这是预览、可上下滚动、共多少条」。
  exportPreviewCaption: {
    color: theme.colors.textMuted,
    fontSize: 11,
    marginBottom: 6,
  },
  exportPreviewWrap: {
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    overflow: 'hidden',
    marginBottom: tokens.spacing.md,
    backgroundColor: theme.colors.background,
  },
  exportPreviewScroll: { flex: 1 },
  // 长图预览：卡片按实测宽度居中（平板上不会贴左边）。
  exportPreviewCenter: { alignItems: 'center' },
  // 文本预览（Markdown）与兜底提示的内边距。
  exportPreviewPad: { padding: 12 },
  exportPreviewWeb: { flex: 1, backgroundColor: 'transparent' },
  exportPreviewFallback: {
    color: theme.colors.textFaint,
    fontSize: 12,
    lineHeight: 18,
  },
  exportPrimaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.primary,
  },
  exportPrimaryButtonDisabled: {
    opacity: tokens.opacity.disabled,
  },
  exportPrimaryButtonText: {
    color: theme.colors.primaryContrast,
    fontSize: 15,
    fontWeight: '700',
  },
  shareCard: {
    // 兜底宽度；导出面板会按预览区实测宽度覆盖（见 ShareCard 的 width prop）。
    width: 360,
    padding: 20,
    backgroundColor: theme.colors.background,
  },
  shareCardTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: theme.colors.text,
  },
  shareCardSub: {
    fontSize: 12,
    color: theme.colors.textFaint,
    marginTop: 4,
    marginBottom: 16,
  },
  shareCardTrunc: {
    color: theme.colors.star,
  },
  shareCardRow: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  shareCardRowRight: {
    justifyContent: 'flex-end',
  },
  shareCardRowLeft: {
    justifyContent: 'flex-start',
  },
  shareCardBubble: {
    maxWidth: '82%',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  shareCardBubbleUser: {
    backgroundColor: theme.colors.primary,
  },
  shareCardBubbleAssistant: {
    backgroundColor: theme.colors.surface,
  },
  shareCardMeta: {
    fontSize: 11,
    opacity: 0.7,
    marginBottom: 4,
    color: theme.colors.primaryContrast,
  },
  shareCardMetaAssistant: {
    color: theme.colors.textFaint,
  },
  shareCardBody: {
    fontSize: 14,
    lineHeight: 21,
    color: theme.colors.primaryContrast,
  },
  shareCardBodyAssistant: {
    color: theme.colors.text,
  },
  shareCardFooter: {
    marginTop: 18,
    fontSize: 11,
    color: theme.colors.textFaint,
    textAlign: 'center',
  },
});
