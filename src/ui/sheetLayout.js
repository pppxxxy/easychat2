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
