// 设置卡渲染顺序——**唯一事实源**（纯数据、零依赖、无副作用，可在 Node 直测）。
//
// 为什么单独成一个文件（而不是留在 SettingsScreen.js 里）：
// 这份顺序同时被两个模块消费——
//   · SettingsScreen.js —— stickyHeaderIndices 由它推导（:1412），每张卡的 onLayout 用同一个
//     id 走 registerSection（:380），JSX 里 15 张卡的书写顺序也按它排；
//   · settings/searchIndex.js —— 搜索条目的 sectionId 必须落在它里面，否则搜索会跳错卡或
//     静默不滚动（tests/settingsSectionLayout.test.mjs / tests/settingsSearch.test.mjs 钉住）。
// 而 SettingsScreen.js **反过来 import searchIndex.js**（:77 用 searchSettings /
// settingsSectionLabel），所以 searchIndex.js 不能从 SettingsScreen.js 取这份顺序：
// 那会成环，被 scripts/guard-structure.mjs:184-261 的循环依赖检查直接判红（动态 import()
// 也在它的覆盖内），而且会把 React Native 组件依赖拖进一个本该零依赖的纯数据模块。
// 抽到本文件后，两边 import 的是**同一个数组对象**——结构上不可能漂移。
//
// 维护提示：调序只改下面这一行。JSX 里 15 张卡的书写顺序无法在不重写整段的前提下由数组
// 生成，故由 tests/settingsSectionLayout.test.mjs 逐条比对（2026-10-07 调序：本地模型独立成卡；
// 2026-10-12：自动备份卡 autoBackup 在 security 与 language 之间）。
export const SECTION_RENDER_ORDER = Object.freeze([
  'api',
  'sampling',
  'persona',
  'appearance',
  'experience',
  'extensions',
  'vector',
  'workspace',
  'github',
  'mcpservers',
  'localmodel',
  'security',
  'autoBackup',
  'language',
  'about',
]);
