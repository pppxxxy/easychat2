// CardForgeEditor 的样式工厂（纯数据，只依赖 theme / fonts / tokens）。
// 从 CardForgeEditor.js 原样外提（无行为变化）；组件与 AssistButton 各自 useMemo 调用。

import { StyleSheet } from 'react-native';

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '800' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  previewAction: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: 12,
    borderRadius: tokens.radius.pill,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  previewActionText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 24 },
  hint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginBottom: tokens.spacing.md,
  },
  preserved: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginBottom: tokens.spacing.md,
  },
  aigcNotice: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginBottom: tokens.spacing.xs,
  },
  aigcBadge: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(11),
    fontWeight: '700',
    marginBottom: tokens.spacing.md,
  },
  assistButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginBottom: tokens.spacing.xs + 2,
    backgroundColor: theme.colors.surface,
  },
  assistButtonText: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(11),
    fontWeight: '700',
    marginLeft: 3,
  },
  emptyText: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    marginBottom: tokens.spacing.sm,
  },
  entryCard: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: tokens.spacing.md,
    marginBottom: tokens.spacing.md,
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.sm,
  },
  entryToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: tokens.spacing.sm,
  },
  entryDisabled: {
    marginLeft: 6,
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
  },
  // 危险正则的标记（badge 与展开后的提示行共用）：extraction 分支基于旧版，漏了这个键
  // ——它是 f1ff705d「危险正则标记」加进组件的，合并时按内联版本的实测定义补回，
  // 否则 styles.entryUnsafe 是 undefined，标记会静默不显示（这类漏键 JS 不报错）。
  entryUnsafe: {
    marginLeft: 6,
    color: theme.colors.danger,
    fontSize: fonts.scaled(11),
  },
  entryBody: {
    marginTop: 2,
  },
  entryActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: tokens.spacing.sm,
  },
  entrySummary: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
  },
  entryTitle: {
    flex: 1,
    marginRight: tokens.spacing.sm,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    fontWeight: '700',
  },
  removeText: {
    color: theme.colors.danger,
    fontSize: fonts.scaled(12),
    fontWeight: '700',
  },
  entryInput: {
    marginBottom: tokens.spacing.sm,
  },
  entryContent: {
    marginBottom: tokens.spacing.sm,
    minHeight: tokens.metrics.fieldHeight * 2,
  },
  imageRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  avatarPreview: {
    width: 56,
    height: 56,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surfaceBorder,
  },
  bgPreview: {
    width: 96,
    height: 56,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surfaceBorder,
  },
  imagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  imageButtons: {
    flex: 1,
    marginLeft: tokens.spacing.md,
  },
  smallButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
    marginBottom: tokens.spacing.xs,
  },
  smallButtonText: {
    color: theme.colors.text,
    fontSize: fonts.scaled(12),
  },
  imageGenButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: tokens.spacing.xs,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
  },
  imageGenText: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(11),
    fontWeight: '700',
    marginLeft: 3,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  switchLabel: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
  },
  assistOverlay: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  assistCard: {
    width: '100%',
    maxWidth: 380,
    maxHeight: '80%',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: tokens.spacing.lg,
  },
  assistTitle: {
    color: theme.colors.text,
    fontSize: fonts.scaled(15),
    fontWeight: '800',
    marginBottom: tokens.spacing.sm,
  },
  assistCurrent: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(17),
    marginBottom: tokens.spacing.sm,
  },
  assistWarning: {
    color: theme.colors.danger,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(17),
    marginTop: tokens.spacing.xs,
    marginBottom: tokens.spacing.sm,
  },
  assistScroll: {
    flexGrow: 0,
  },
  assistInput: {
    minHeight: tokens.metrics.fieldHeight * 2,
    marginBottom: tokens.spacing.md,
  },
  assistBusyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: tokens.spacing.sm,
  },
  assistBusyText: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    marginLeft: tokens.spacing.sm,
  },
  assistActions: {
    flexDirection: 'row',
  },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: tokens.spacing.lg,
    paddingBottom: tokens.spacing.xl,
    paddingTop: tokens.spacing.sm,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
  },
  footerButton: { flex: 1, marginHorizontal: 4 },
});

export default createStyles;
