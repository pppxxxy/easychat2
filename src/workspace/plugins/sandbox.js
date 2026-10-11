// 插件沙盒（capability-restricted execution）——差距 #2「沙盒执行」。
//
// **诚实的能力边界（先读这段）**：这是**能力受限**，不是**安全沙盒**。`new Function` 无法
// 真正隔离 `globalThis`（JS 没有进程级隔离），所以插件代码理论上仍可摸到全局对象。本模块
// 做的是：
//   1. 把**注入的能力面**收窄到 manifest 声明的 `permissions`（默认最小：只有 log）；
//   2. 遮蔽常见危险全局（fetch / XMLHttpRequest / require / process / setTimeout…）；
//   3. 对返回的 Promise 加超时（异步挂死可被切断；同步死循环切不断，如实说明）。
// 结论：**只装你信任来源的插件**。真要强隔离得换原生进程 / WebView，不在本切面内。
//
// 纯逻辑 + `new Function`，Node 可直测（Node 与 Hermes 都支持 `new Function`）。

export const SANDBOX_DEFAULT_TIMEOUT_MS = 3000;
export const SANDBOX_LOG_MAX = 4000;

// 被遮蔽的全局名（注入为 undefined，降低误用/误伤面）。
// 注意：严格模式下 `eval`/`arguments` 不能作形参名，故不在此列。
const SHADOWED_GLOBALS = Object.freeze([
  'fetch', 'XMLHttpRequest', 'WebSocket', 'require', 'module', 'exports',
  'process', 'setTimeout', 'setInterval', 'setImmediate',
]);

// 依据授权能力构建注入给插件代码的 ctx。capabilities 是宿主提供的实现（可注入、可空）。
export function createCapabilityContext({ permissions = [], capabilities = {}, log = null } = {}) {
  const granted = new Set(Array.isArray(permissions) ? permissions : []);
  const cap = capabilities && typeof capabilities === 'object' ? capabilities : {};
  const lines = [];
  const push = (...args) => {
    if (lines.length >= 200) return;
    lines.push(args.map(a => (typeof a === 'string' ? a : safeJson(a))).join(' '));
  };
  const ctx = {
    // log 永远可用（纯内存，无副作用）。
    log: (...args) => { push(...args); if (typeof log === 'function') log(...args); },
    lines: () => lines.slice(),
    has: name => granted.has(name),
  };
  if (granted.has('fs.read') && typeof cap.read === 'function') {
    ctx.read = (path, options) => cap.read(String(path), options || {});
  }
  if (granted.has('fs.write') && typeof cap.write === 'function') {
    ctx.write = (path, content) => cap.write(String(path), String(content == null ? '' : content));
  }
  if (granted.has('search') && typeof cap.search === 'function') {
    ctx.search = (query, options) => cap.search(String(query), options || {});
  }
  if (granted.has('notify') && typeof cap.notify === 'function') {
    ctx.notify = text => cap.notify(String(text == null ? '' : text));
  }
  return ctx;
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch (error) { return String(value); }
}

// 编译一段 handler 源码为**异步**函数（handler 里可 `await ctx.read(...)`）。handler 是
// **函数体**（用 return 返回结果），形如："const r = await ctx.read('a.txt'); return r;"
// 编译失败抛错（调用方包成 { ok:false, error }）。
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export function compileHandler(handler) {
  const src = String(handler == null ? '' : handler);
  if (!src.trim()) throw new Error('empty handler source');
  // 遮蔽全局：作为形参传入并绑定 undefined（无法穷尽，但抬高门槛）。
  const params = ['ctx', 'args', ...SHADOWED_GLOBALS, 'globalThis'];
  const factory = new AsyncFunction(...params, `"use strict";\n${src}`);
  return (ctx, args) => factory(ctx, args, ...SHADOWED_GLOBALS.map(() => undefined), undefined);
}

// 在能力面里跑一段 handler。返回 { ok, value, error, logs, timedOut }。
export async function runInSandbox(handler, { args = {}, permissions = [], capabilities = {}, timeoutMs = SANDBOX_DEFAULT_TIMEOUT_MS } = {}) {
  const ctx = createCapabilityContext({ permissions, capabilities });
  let fn;
  try {
    fn = compileHandler(handler);
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error), logs: ctx.lines() };
  }
  try {
    const result = fn(ctx, args || {});
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('插件执行超时')), Math.max(1, Number(timeoutMs) || SANDBOX_DEFAULT_TIMEOUT_MS));
    });
    const value = await Promise.race([Promise.resolve(result), timeout]);
    return { ok: true, value, logs: ctx.lines() };
  } catch (error) {
    const timedOut = /插件执行超时/.test(String((error && error.message) || ''));
    return { ok: false, error: String((error && error.message) || error), logs: ctx.lines(), timedOut };
  }
}
