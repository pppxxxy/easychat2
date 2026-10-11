// 作息面板（及三个子编辑器）共用的样式。抽出来是为了让面板与子组件各自保持在
// 行数上限内，并让「卡片/行/输入框」的观感只定义一次。

import { StyleSheet } from 'react-native';

export const createScheduleStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 40 },

  select: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  selectLabel: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), marginRight: 10 },
  selectValue: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '600' },
  pickerBody: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    marginTop: 6,
    paddingVertical: 4,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  pickerText: { flex: 1, color: theme.colors.textMuted, fontSize: fonts.scaled(14) },
  pickerTextActive: { color: theme.colors.primary, fontWeight: '700' },

  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  switchLabel: { flex: 1, paddingRight: 12 },
  switchTitle: { color: theme.colors.text, fontSize: fonts.scaled(15) },
  switchSubLabel: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 2 },

  // 工作日 / 休息日分段切换
  tabs: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    padding: 3,
    marginBottom: 14,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: tokens.radius.md },
  tabActive: { backgroundColor: theme.colors.primary },
  tabText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14) },
  tabTextActive: { color: theme.colors.primaryContrast, fontWeight: '700' },

  card: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.lg,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 14,
  },
  cardTitle: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginBottom: 8 },

  row: {
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
    paddingVertical: 10,
  },
  rowFirst: { borderTopWidth: 0 },
  rowHead: { flexDirection: 'row', alignItems: 'center' },
  rowBody: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  rowActions: { flexDirection: 'row', alignItems: 'center' },
  iconButton: { paddingHorizontal: 6, paddingVertical: 4 },

  nameInput: {
    flex: 1,
    color: theme.colors.text,
    fontSize: fonts.scaled(15),
    fontWeight: '600',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface,
  },
  timeInput: {
    minWidth: 74,
    textAlign: 'center',
    color: theme.colors.text,
    fontSize: fonts.scaled(15),
    fontWeight: '600',
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface,
  },
  timeDash: { color: theme.colors.textFaint, fontSize: fonts.scaled(14), paddingHorizontal: 6 },
  fieldGap: { width: 8 },
  flexInput: {
    flex: 1,
    color: theme.colors.text,
    fontSize: fonts.scaled(14),
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface,
  },
  smallInput: {
    width: 64,
    textAlign: 'center',
    color: theme.colors.text,
    fontSize: fonts.scaled(14),
    fontWeight: '600',
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface,
  },
  unit: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), paddingLeft: 6 },
  fieldLabel: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), paddingRight: 6 },

  chipRow: { flexDirection: 'row', alignItems: 'center' },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface,
    marginRight: 8,
  },
  chipActive: { backgroundColor: theme.colors.primary },
  chipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13) },
  chipTextActive: { color: theme.colors.primaryContrast, fontWeight: '700' },

  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: tokens.radius.md,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginTop: 10,
  },
  addButtonText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(14), marginLeft: 6 },

  empty: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), paddingVertical: 6 },
  hint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginBottom: 16,
  },
  cardHint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    lineHeight: fonts.scaled(18),
    marginTop: 8,
  },

  previewCard: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.lg,
    padding: 14,
    marginBottom: 12,
  },
  previewTitle: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginBottom: 6 },
  previewText: { color: theme.colors.text, fontSize: fonts.scaled(14), lineHeight: fonts.scaled(21) },
  previewPeriod: { color: theme.colors.primary, fontSize: fonts.scaled(13), marginTop: 6 },

  saveButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.primary,
  },
  saveButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(15), fontWeight: '700' },
  notice: { color: theme.colors.primarySoft, fontSize: fonts.scaled(13), textAlign: 'center', marginTop: 10 },
});
