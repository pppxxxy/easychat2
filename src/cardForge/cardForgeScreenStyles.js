// CardForgeScreen 的样式工厂（纯数据，只依赖 theme / fonts / tokens）。
// 从 CardForgeScreen.js 原样外提（无行为变化）。

import { StyleSheet } from 'react-native';

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexShrink: 1,
    marginLeft: 6,
    borderRadius: tokens.radius.pill,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  actionDisabled: { opacity: tokens.opacity.disabled },
  actionText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginLeft: 4 },
  draftLine: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
  },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 12 },
  bubbleRow: { alignItems: 'flex-start', marginBottom: 10 },
  bubbleRowUser: { alignItems: 'flex-end' },
  bubble: {
    maxWidth: '92%',
    borderRadius: tokens.radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  bubbleAi: { backgroundColor: theme.colors.surface },
  bubbleUser: { backgroundColor: theme.colors.primary },
  bubbleNote: { backgroundColor: theme.colors.surfaceAlt, borderStyle: 'dashed' },
  bubbleText: { color: theme.colors.text, fontSize: fonts.scaled(14), lineHeight: fonts.scaled(20) },
  bubbleTextUser: { color: theme.colors.primaryContrast },
  options: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, maxWidth: '96%' },
  freeRow: { flexDirection: 'row', alignItems: 'center', width: '100%', marginTop: 2 },
  freeInput: { flex: 1, marginRight: 8 },
  busyRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 6 },
  busyText: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginLeft: 6 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  input: { flex: 1, marginRight: 8 },
  sendButton: { minWidth: 72 },
  importRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 14,
  },
  importButton: { flex: 1, marginHorizontal: 4 },
});

export default createStyles;
