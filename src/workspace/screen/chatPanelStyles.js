// 工作区对话面板的样式表（从 ChatPanel.js 抽出）。
//
// 为什么抽：那个文件卡在架构棘轮基线上（1853 = 基线），而 P2-1 的聊天搜索、后续的界面线
// 都要往里加东西。样式表是这里最安全的一块——纯数据，只依赖 theme/fonts/tokens，
// 没有闭包状态，搬走不改变任何行为。

import { StyleSheet } from 'react-native';
const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background, paddingTop: 44 },
  // embedded：外层由 WorkspaceScreen 提供容器与安全区，这里不再重复留白。
  embeddedRoot: { flex: 1 },
  containerEmbedded: { paddingTop: 0 },
  embeddedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  embeddedAction: { flexDirection: 'row', alignItems: 'center', marginRight: 16 },
  embeddedActionText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '600', marginLeft: 4 },
  // P2-1：消息检索条（就地过滤消息列表，不是另开结果页）。
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  searchInput: { flex: 1, color: theme.colors.text, fontSize: fonts.scaled(12), marginLeft: 6, padding: 0 },
  searchCount: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginLeft: 8 },
  // 顶栏 / 左栏（topBar、title、exitButton、rail、railItem、railLabel、railSpacer）的样式
  // **不在这里**：单屏化之后它们是 WorkspaceScreen 自己的东西（那里有一份完整定义）。
  // 这里曾照抄过一份，ChatPanel 一个都没用（`styles.topBar` / `styles.railItem` 在
  // ChatPanel 里搜不到），纯死拷贝——两份同名样式漂移起来极难发现（改了不生效的那一份）。
  // 只留 mainRow：ChatPanel 真的在用（它是「左栏 + 聊天列」那行，embedded 模式下左栏由
  // WorkspaceScreen 提供，所以两边同形但各自持有）。
  mainRow: { flex: 1, flexDirection: 'row' },
  chatColumn: { flex: 1 },
  filesLink: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  filesLinkText: {
    flex: 1,
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(11),
    marginHorizontal: 6,
  },
  body: { paddingHorizontal: 14, paddingBottom: 16, paddingTop: 6 },
  intro: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(18), marginTop: 8 },
  bubbleRow: { flexDirection: 'row', marginTop: 10 },
  // P0-3：助手气泡下方的工具轨迹回看（不占满整行，视觉上仍属于这条助手消息）。
  traceRow: { marginTop: 2, marginRight: 40 },
  bubbleRowUser: { justifyContent: 'flex-end' },
  bubbleRowAssistant: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '86%',
    borderRadius: tokens.radius.md || tokens.radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: tokens.border.thin,
  },
  bubbleUser: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  bubbleAssistant: { backgroundColor: theme.colors.surface, borderColor: theme.colors.surfaceBorder },
  bubbleError: { borderColor: theme.colors.danger || theme.colors.surfaceBorder },
  // W1：压缩行（历史压缩说明 / 会话投影里的 compaction 行）是「系统的动作」，不是模型说的话
  // ——虚线描边与普通气泡区分开。**这个键只定义一次**：此前文件里有两处 bubbleCompaction
  //（一处只有颜色+虚线、另一处多了 borderWidth），JS 对象字面量后写者胜，所以第一处永远是
  // 死代码——改它不生效，是最难查的那种「改了没反应」。
  bubbleCompaction: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, borderStyle: 'dashed' },
  bubbleText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19) },
  statusBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 4 },
  statusText: { color: theme.colors.textMuted, fontSize: fonts.scaled(11), marginLeft: 6, flex: 1 },
  attachmentBar: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 10, paddingBottom: 4 },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginRight: 8,
    marginTop: 6,
  },
  attachmentName: { color: theme.colors.text, fontSize: fonts.scaled(11), marginHorizontal: 5, maxWidth: 140 },
  recordingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  recordingText: { color: theme.colors.text, fontSize: fonts.scaled(12), marginLeft: 6, flex: 1 },
  recordingAction: { color: theme.colors.accentText, fontSize: fonts.scaled(12), fontWeight: '600' },
  // 斜杠命令建议条：输入 / 时出现在输入行上方（横向滚动，点击填入命令名）。
  slashBar: {
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  slashChip: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surfaceAlt,
    maxWidth: 240,
  },
  slashChipText: {
    color: theme.colors.primary,
    fontSize: fonts.scaled(12),
    fontWeight: '600',
  },
  slashChipDescription: {
    marginLeft: 6,
    flexShrink: 1,
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.surfaceBorder,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  iconButton: { paddingHorizontal: 5, paddingBottom: 8 },
  input: {
    flex: 1,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    maxHeight: 120,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
  },
  sendButtonDisabled: { opacity: 0.5 },
  stopButton: { backgroundColor: theme.colors.surfaceBorder },
});


export default createStyles;
