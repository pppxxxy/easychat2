// 插件槽位的**接线表**——「能画」与「有地方画」的分界（纯数据、零依赖、零 RN/JSX，可 Node 直测）。
//
// 为什么单独成一个纯数据文件（而不是留在 screen/PluginSlot.js 里）：
// 这张表同时被两类模块消费——
//   · screen/PluginSlot.js —— 渲染端（RN 组件，按 kind 画贡献）；
//   · plugins/manifest.js 与 plugins/registry.js —— 数据契约与注册表，它们必须知道
//     「哪些 kind 注册得下、但界面上没有落点」，才能如实标注「暂不支持」而不是静默收下。
// 后两者的定位是「纯数据/纯逻辑，零 IO、零 RN，可 Node 直测」，而 PluginSlot.js 是 JSX 文件
// ——直接 import 它会让 Node 解析 JSX 抛 SyntaxError，把 tests/plugins.test.mjs 整条插件
// 测试链打挂。抽到本文件后，渲染端与数据端 import 的是**同一份表**，结构上不可能漂移。
//
// 「能画」不等于「有地方画」：真正决定某个 kind 会不会出现在界面上的，是下面这张
// SLOT_RENDER_POINTS（谁在哪里挂了 `<PluginSlot kind=... />`）。缺了落点的 kind 注册得再成功
// 也永远不显示——「注册成功却永不显示」是插件系统里最难发现的假接线：manifest 收下了、
// 注册表也 render 出来了，用户却永远看不到，而且不报错。
export const SLOT_RENDER_POINTS = Object.freeze({
  'chat.header': null,   // 对话面板顶部徽标行：暂无挂载点
  'chat.footer': null,   // 输入区上方：暂无挂载点
  'settings.row': 'src/extension/WorkspacePluginsPanel.js', // 唯一已接线：插件面板的槽位演示区
  'files.toolbar': null, // 文件面板工具条：暂无挂载点
  'message.action': null, // 消息气泡动作按钮：暂无挂载点
  'composer.button': null, // 输入框旁按钮：暂无挂载点
});

// 未接线的 kind（**派生**，别再手写第二份）：插件面板据此把它们如实列出来，
// manifest/registry 据此标「暂不支持」。新增 kind 时必须选一边——真接线（填渲染点文件）
// 或显式标 null（由界面如实列出），不会再默默漏掉。
export const UNWIRED_SLOT_KINDS = Object.freeze(
  Object.keys(SLOT_RENDER_POINTS).filter(kind => !SLOT_RENDER_POINTS[kind]),
);
