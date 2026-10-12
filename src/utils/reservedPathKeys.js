// 点路径（`a.b.c`）逐段写入对象时的**保留键清单**——单一来源。
//
// 为什么需要单独一层拦截：把「用户可编辑的键名」当成点路径逐段写进对象时，这三个键
// 在对象上**不是普通数据键**——`__proto__` 的赋值会改原型（写 `target.__proto__.x`
// 等于把 `Object.prototype` 写脏，此后任意空对象都会「继承」到攻击者塞进来的字段），
// `constructor` / `prototype` 会沿继承链撞上 `Object` / `Function` 的成员。
// 先例与最初那份清单见 chat/toolNoticeVisibility.js:27（那边由
// tests/toolNoticeVisibility.test.mjs 钉死），生图侧见 imageGen/index.js 的 setByPath。
//
// 为什么必须**逐层**拦、而不是只看首段：危险键可以藏在任意一层
// （`a.__proto__.x` 的第一段 `a` 完全合法），只在首段查会整类漏掉。
//
// 为什么必须共用一份：这份清单此前已经在仓库里手写了三处（chat/toolNoticeVisibility.js、
// imageGen/index.js、tts/index.js）。漏同步一处就等于留一条旁路——所以抽成这个零依赖
// 叶子模块，任何需要「点路径写入」的调用方都从这里取，不再各抄一份。
//
// 本模块**必须保持零依赖**（不 import 任何东西）：它同时被 imageGen 与 tts 的引擎引用，
// 一旦拖进 RN/expo 依赖，两个引擎的 Node 测试加载器都得跟着打桩；而且它处在依赖图
// 最底层，保持叶子状态才不可能与调用方形成环（scripts/guard-structure.mjs 会查环）。
export const RESERVED_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isReservedPathKey(key) {
  return RESERVED_PATH_KEYS.has(String(key));
}
