// Sheet 的外壳策略（纯函数，可单测）。
//
// 为什么单独一个模块：仓库没有 React 组件渲染基建（react-native 在 Node 下 import 不进来
// ——Flow 语法直接 SyntaxError），组件内部的分支只能靠「抽纯函数 + 结构断言」覆盖。
// 这两个决策恰好是弹窗之间**唯一**真正不同的行为差异（点空白是否关闭 / 是否抬升卡片），
// 抽出来就能被真行为测试钉住，而不是只断言源码里出现了某个字符串。

// 背景层三种模式。key 即 Sheet 的 backdropMode 取值。
export const SHEET_BACKDROP_MODES = {
  // 点空白关闭（默认）：聊天设置 / 更多菜单 / 会话统计 / 语音设置 / 切换器 /
  // 提及选择 / 附件菜单 / 导出面板 / 模型面板 / 思考设置。
  dismiss: { dismissOnPress: true, keyboardAvoiding: false },
  // 点空白不关闭：选择文本 / 表情包面板——点空白就关会把用户正在看的正文/编辑态丢掉。
  static: { dismissOnPress: false, keyboardAvoiding: false },
  // 键盘弹起时抬升卡片：命名输入 / 压缩关注点。
  keyboard: { dismissOnPress: false, keyboardAvoiding: true },
};

// 未知/缺省模式一律回落到 dismiss（与这些弹窗改造前的默认写法一致）。
export function resolveSheetBackdrop(mode) {
  if (typeof mode === 'string' && Object.prototype.hasOwnProperty.call(SHEET_BACKDROP_MODES, mode)) {
    return SHEET_BACKDROP_MODES[mode];
  }
  return SHEET_BACKDROP_MODES.dismiss;
}

// 头部三态：显式 header 节点优先（各弹窗标题行视觉不同，走自定义节点才能原样保留）；
// 只有 title 时用共享 SheetHeader（标题 + 关闭按钮）；两者都没有则无头部。
export function resolveSheetHeaderKind({ header, title } = {}) {
  if (header !== null && header !== undefined) return 'custom';
  if (typeof title === 'string' && title.length > 0) return 'standard';
  return 'none';
}

// —— R6：dismiss 手势的落点（结构决策，纯函数可单测）——
//
// 背景层是 Pressable 时，Android 上它认领 responder 且拒绝让渡（RN 手势协商的
// 已知行为）：卡片作为它的**后代**，内部的原生 ScrollView/FlatList 收不到触摸流——
// 列表滚不动、轻点还会直接关掉弹窗。卡片里的可点元素（TouchableOpacity，树更深）
// 反而能赢手势，所以表现为「点击正常、拖动全灭」。
//
// 两种结构：
//   'wrap'   —— 旧结构（默认）：背景 Pressable 包住卡片。居中卡片类弹窗没有滚动
//               需求，维持原样（16 个既有弹窗逐字节不变，不碰它们）。
//   'above'  —— 底部面板用：View(flex:1) 纵排 [点上方空白关闭的 Pressable, 卡片]，
//               **卡片不再是 dismiss 背景的后代**——列表滚动恢复，点卡片上方空白
//               仍可关闭（点卡片内空白不误关）。
// 判据：只有 dismiss 语义（backdrop.dismissOnPress）才谈得上 above；static/keyboard
// 本来就没有关闭手势，一律 'wrap'。
export function resolveSheetDismissArea({ backdrop, dismissArea } = {}) {
  if (!(backdrop && backdrop.dismissOnPress === true)) return 'wrap';
  return dismissArea === 'above' ? 'above' : 'wrap';
}
