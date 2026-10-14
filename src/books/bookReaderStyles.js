// BookReaderView 的样式工厂（纯数据，只依赖 theme / fonts / tokens）。
// 从 BookReaderView.js 原样外提（无行为变化）。

import { StyleSheet } from 'react-native';

// 阅读区上下内缩：顶栏/底栏是浮层（absolute），不参与布局——留出恒定内缩，
// 保证工具栏显隐时正文区尺寸不变（否则每次呼出工具栏都会触发重测量→转圈）。
const READER_INSET_TOP = 48;
// 底边内缩：**只让开系统手势条**，不再给提示行留位。
//
// 历史（FIX-6）：这里原先写 56，注释是「给浮层工具栏留位」。但留位是**死**的、
// 提示行是**活**的——提示行是 flex:1 的 Text，章名一长就折行：
//   一行时 8 + ~15 + 24 ≈ 47px < 56 ✓ 装得下
//   两行时 ≈ 62px > 56 ✗ 不透明浮层（bottomBar 是 background 实色 + zIndex 10）
//                       直接压住正文最后一行
// 于是「章名长就压字、章名短就留白」反复横跳。这不是哪次改漏了，是
// 「固定留位伺候动态高度」这个结构本身伺候不了动态高度。
//
// 新设计（用户拍板）：**正文铺满到底，提示行浮在上面、点击即消**。
//   · 压字从结构上绝迹：不存在「留位不够」这回事；
//   · 代价可接受：提示行可见时盖住最后 1~2 行，点一下（或点提示行本身）即还；
//   · 分页不变量仍守住：这个值**依然是常数**（不随 showControls 变），
//     所以 pageInnerWrap 的测量高度照旧不随工具栏显隐变化，toggle 不会重新分页。
// 不取 safe-area inset 的原因：阅读器挂在原生 Stack 里、且 app 未开 edge-to-edge，
// 底部本就是应用区域；这个常数只需覆盖手势条的视觉侵入（与 topBar 的 48 同口径）。
const READER_INSET_BOTTOM = 16;
// 分页模式的实际底边内缩 = max(小常数, 设备安全区底部)。
//
// 为什么取 max 而不是直接用 safe-area：本 app 未开 edge-to-edge、且阅读器在原生 Stack 里，
// 多数设备上 inset.bottom 为 0（系统导航栏在应用窗口之外）——此时靠上面那个 16 让开手势条的
// 视觉侵入。而在「应用确实延伸到系统区」的机型/设置上，16 就太小了，必须让真实 inset 说话。
//
// ⚠️ 这个值**只依赖设备**，不依赖 showControls —— 分页不变量（toggle 提示条不得触发重新分页）
// 照旧成立：同一个设备上它自始至终是同一个数。
function resolveBottomInset(safeAreaBottom) {
  const inset = Number(safeAreaBottom);
  if (!Number.isFinite(inset) || inset <= 0) return READER_INSET_BOTTOM;
  return Math.max(READER_INSET_BOTTOM, Math.round(inset));
}
// 滚动模式（mdContent）的底边内缩：**保持较大值**，与分页模式刻意不同。
//
// 为什么不能一起改小（任务书原意是两处都改成小常数）：
//   分页模式有「点中间收起」的交互（handleTap 绑在 pageArea 上），所以提示行是**临时**浮层；
//   而**滚动模式根本没有收起入口**——!paged 分支只渲染 BookMarkdownList（FlatList），
//   既无 onPress 也无 setShowControls，showControls 恒为初始 true。
// 于是若把这里的内缩也压到 16，提示行会**永久**盖住列表最后 1~2 行，用户滚到底也读不到
// （内容最大滚动位置就在底部，被浮层吃掉的部分永远补不回来）。
//
// 取值依据：提示行自身高度 = paddingTop 8 + 单行文字 ~15 + paddingBottom 24 ≈ 47，
// 留 56 保证「常驻提示行 + 正文完整可读」两者兼得。这是**修正**而非保守：
// 一旦将来给滚动模式补上收起入口，这个常数就可以跟着降下来。
const SCROLL_INSET_BOTTOM = 56;

const createStyles = (theme, fonts, tokens, safeAreaBottom = 0) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  modalRoot: { paddingTop: 48 },
  // 目录 / 评论这类全屏 Modal 的顶栏：**不浮层**、参与布局。
  // 阅读页那套 topBar 是 absolute 贴屏幕顶，直接复用会把「返回阅读 / 目录」顶进系统状态栏。
  modalTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    // 浮层：不参与布局——工具栏显隐不再改变正文区高度，避免每次呼出都重测量。
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: theme.colors.background,
  },
  backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingRight: 10 },
  backText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), marginLeft: 2 },
  title: {
    color: theme.colors.text,
    fontSize: fonts.scaled(15),
    fontWeight: '700',
    flex: 1,
    textAlign: 'center',
    marginHorizontal: 8,
  },
  topActions: { flexDirection: 'row', alignItems: 'center' },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  iconButtonActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  modeButtonText: { color: theme.colors.text, fontSize: fonts.scaled(10), fontWeight: '700' },
  modeButtonTextActive: { color: theme.colors.primaryContrast },
  fontButtonText: { color: theme.colors.text, fontSize: fonts.scaled(11), fontWeight: '700' },
  contentWrap: { flex: 1 },
  mdContent: {
    paddingHorizontal: 20,
    paddingTop: READER_INSET_TOP,
    // 滚动模式用较大的底边内缩——那里没有收起入口，提示行是**常驻**的（见 SCROLL_INSET_BOTTOM）。
    paddingBottom: SCROLL_INSET_BOTTOM,
  },
  // 分页模式：正文铺满到底，提示行浮在上面、点一下即消（FIX-6）。
  // 恒定上下内缩，给浮层工具栏留位；pageInner 才是测量容器（尺寸不随工具栏变化）。
  // 底边取 max(小常数, 设备安全区)——只跟设备走，不跟提示条显隐走（见 resolveBottomInset）。
  pageArea: {
    flex: 1,
    paddingTop: READER_INSET_TOP,
    paddingBottom: resolveBottomInset(safeAreaBottom),
  },
  pageInnerWrap: { flex: 1 },
  modeHint: {
    position: 'absolute',
    alignSelf: 'center',
    top: '45%',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: tokens.radius.pill || 999,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    zIndex: 20,
  },
  modeHintText: { color: '#FFFFFF', fontSize: fonts.scaled(13), fontWeight: '600' },
  pageText: { flex: 1 },
  measureText: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    opacity: 0,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // 底部提示行：**浮层**（不参与布局），正文铺满到它下面，点击任意处即消。
  //
  // `pointerEvents: 'none'`（在组件上设）是必须的：这层盖在正文最底部，
  // 若它吃掉触摸，用户点「提示行那一块」就没法收起（而中键收起正是 FIX-6 的主要交互）。
  // 设 none 后触摸穿透到底下的 TouchableWithoutFeedback（paged 模式的中键处理）。
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    // 底部让开系统导航栏 / 手势条：贴到屏幕最下沿时最后一行进度字会被遮掉一半。
    paddingBottom: 24,
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: theme.colors.background,
  },
  // 单行不折：章名再长也截断（见 BookReaderView 的三段式渲染）。
  // 折行会让浮层高度随内容变化，「盖住几行」就变得不可预期；截断后高度恒定。
  //
  // 三段布局：`52%` + ` · 章名…` + ` · 本段 16/19`。
  // 只有**章名**长度无界，所以只有它带 flexShrink:1（宽度不够时收缩并出省略号）；
  // 两端的百分比与页码是定长短串，永远完整显示——整行 numberOfLines=1 会把
  // 「本段 x/y」也截掉，而那是分页模式唯一的位置信息，不能丢。
  // 用 flexShrink 而非 flex:1：后者会让章名吃掉全部剩余宽度，把页码顶到最右、
  // 与章名之间留出一大段空档；flexShrink 只在真的放不下时才收缩，排布更自然。
  progressText: { color: theme.colors.textFaint, fontSize: fonts.scaled(11) },
  progressTitle: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), flexShrink: 1 },
  chapterBody: { flex: 1 },
  chapterSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginTop: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  chapterSearchInput: {
    flex: 1,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    marginLeft: 6,
    paddingVertical: 0,
  },
  chapterEmpty: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    marginTop: 20,
    textAlign: 'center',
  },
  // 右侧留出 46px 给定位条，章节文字不会压到滑块下面。
  chapterList: { paddingLeft: 20, paddingRight: 46, paddingBottom: 30 },
  chapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: tokens.radius.sm,
    marginBottom: 4,
  },
  // 「正在阅读」的那一章：底色 + 主色标题 + 徽标（见 chapterCurrentBadge）。
  chapterRowCurrent: { backgroundColor: theme.colors.surface },
  chapterRowMain: { flex: 1, marginRight: 8 },
  chapterText: { color: theme.colors.text, fontSize: fonts.scaled(14) },
  chapterTextCurrent: { color: theme.colors.accentText, fontWeight: '700' },
  chapterCurrentBadge: {
    color: theme.colors.accentText,
    fontSize: fonts.scaled(10),
    fontWeight: '700',
    marginTop: 2,
  },
  chapterPercent: { color: theme.colors.textFaint, fontSize: fonts.scaled(11) },
  commentsBody: { flex: 1, paddingHorizontal: 20, paddingBottom: 20 },
  sectionHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginBottom: 6 },
  chipScroll: { flexGrow: 0, flexShrink: 0, marginBottom: 10 },
  characterChip: {
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
  },
  characterChipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  characterChipText: { color: theme.colors.text, fontSize: fonts.scaled(12), maxWidth: 120 },
  characterChipTextActive: { color: theme.colors.primaryContrast, fontWeight: '600' },
  generateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingVertical: 10,
  },
  generateRow: { marginBottom: 10 },
  // 第二个入口用描边样式区分开：同为「让某角色聊」，但范围是整章。
  generateButtonChapter: {
    marginTop: 8,
    backgroundColor: 'transparent',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
  },
  generateText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '600', marginLeft: 6 },
  generateTextChapter: { color: theme.colors.accentText },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 10,
  },
  errorText: { color: theme.colors.danger || theme.colors.text, fontSize: fonts.scaled(12), flex: 1, marginRight: 8 },
  emptyComments: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 12, lineHeight: fonts.scaled(17) },
  commentCard: {
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: 10,
    marginTop: 10,
  },
  commentHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  commentName: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), flex: 1, marginRight: 8 },
  quoteButton: {
    borderRadius: tokens.metrics.buttonRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  quoteButtonText: { color: theme.colors.primary, fontSize: fonts.scaled(11), fontWeight: '600' },
  commentText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19) },
});

export default createStyles;
