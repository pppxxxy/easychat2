// 工作区设置面板的样式表（从 WorkspaceSettingsSheet.js 抽出）。
//
// 为什么抽：那个文件卡在架构棘轮基线上（904 = 基线，**余量 0**），而 P3 要往面板里加
// 「子代理档案 / 技能逐条」等行，加不动。样式表是这里最安全的一块——它只依赖
// theme/fonts/tokens，搬走不改变任何行为（纯数据，没有闭包状态）。

import { StyleSheet } from 'react-native';
const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  // embedded：作为对话面板内的设置层，不再有遮罩与底部弹层外壳。
  embeddedRoot: { paddingHorizontal: 4 },
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.colors.surfaceAlt,
    borderTopLeftRadius: tokens.radius.lg,
    borderTopRightRadius: tokens.radius.lg,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.divider,
    maxHeight: '78%',
    paddingBottom: 8,
    ...tokens.elevation(2, theme),
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  sheetTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '800' },
  sheetBody: { flexGrow: 0 },
  sheetBodyContent: { paddingHorizontal: 12, paddingBottom: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 4,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  rowLabel: { color: theme.colors.text, fontSize: fonts.scaled(13), fontWeight: '600', marginLeft: 10 },
  rowValue: {
    flex: 1,
    textAlign: 'right',
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    marginHorizontal: 10,
  },
  actionTextBlock: { flex: 1, marginLeft: 10, marginRight: 8 },
  actionHint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 2,
  },
  rowBody: {
    paddingHorizontal: 4,
    paddingBottom: 12,
    paddingTop: 2,
  },
  bodyHint: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(16),
    marginTop: 8,
  },
  // 「清除全部授权」：危险动作给危险色 + 描边，但不填满（防误点视觉权重过大）。
  permissionClear: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.danger,
  },
  permissionClearText: {
    marginLeft: 6,
    color: theme.colors.danger,
    fontSize: fonts.scaled(12),
  },
  // P0-6：手写规则的输入区（工具名 / 匹配内容）。
  permissionAddTitle: {
    marginTop: 14,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    fontWeight: '600',
  },
  // 手写规则 / 保留口径共用的输入框（两处都是「草稿 → 宿主落盘」）。
  sheetInput: {
    marginTop: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    color: theme.colors.text,
    fontSize: fonts.scaled(12),
  },
  retentionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  retentionLabel: {
    flex: 1,
    color: theme.colors.text,
    fontSize: fonts.scaled(12),
  },
  retentionRange: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(10),
  },
  permissionAdd: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
  },
  permissionAddDisabled: {
    opacity: 0.4,
  },
  permissionAddText: {
    marginLeft: 6,
    color: theme.colors.primary,
    fontSize: fonts.scaled(12),
  },
  // 「安装示例技能」：中性动作（主题色描边），与上面那个危险色的清除按钮区分开。
  skillsInstall: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
  },
  skillsInstallText: {
    marginLeft: 6,
    color: theme.colors.primary,
    fontSize: fonts.scaled(12),
  },
  // 工作区模板行：左信息右按钮（每行一个模板，各带「创建」）。
  templateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  templateInfo: {
    flex: 1,
    marginRight: 10,
  },
  templateName: {
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
  },
  templateDescription: {
    marginTop: 2,
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    lineHeight: fonts.scaled(15),
  },
  templateCreate: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
  },
  templateCreateText: {
    color: theme.colors.primary,
    fontSize: fonts.scaled(12),
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  chip: {
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.sm,
    paddingHorizontal: 11,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 8,
  },
  chipActive: {
    backgroundColor: theme.colors.primaryAlpha(0.2),
    borderColor: theme.colors.primary,
  },
  chipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600' },
  chipTextActive: { color: theme.colors.primarySoft },
  usageTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    overflow: 'hidden',
    marginTop: 6,
  },
  usageFill: { height: '100%', backgroundColor: theme.colors.primary },
  usageFillWarn: { backgroundColor: theme.colors.danger || theme.colors.primary },
  divider: { height: tokens.border.thin, backgroundColor: theme.colors.surfaceBorder, marginVertical: 4 },
});


export default createStyles;
