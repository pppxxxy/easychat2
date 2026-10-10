// 分级日志（Z 系采纳 #10，对照 zai-org/ZCode 的 createServiceLogger）。
//
// 现状：全仓 30+ 处 `console.warn/error`，多数裹在 `if (__DEV__)` 里，生产环境
// 既不落盘、也没有统一口径（有的写 storage，有的写 unhandled，有的纯 console）。
// 这里定一条统一的纪律：
//   debug  协议原始数据、流式 chunk 等高频诊断——**只在 dev**，不落盘、不刷屏；
//   info   生命周期、一次性初始化等生产可用事件；
//   warn   可恢复异常（失败但已兜底）；
//   error  崩溃、握手失败、鉴权丢失等不可恢复错误。
// 所有文本经 redact 脱敏；落盘由注入的 sink 决定（默认接本地诊断日志）。
//
// 纯模块：零 import、零原生依赖（redact 由调用方注入），Node 直测。

export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
const RANK = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function safeStringify(value) {
  if (value === undefined) return '';
  if (value instanceof Error) return value.message || String(value);
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

export function createLogger({
  scope = 'app',
  minLevel = 'info',
  dev = false,
  sink = null,
  consoleLike = null,
  redact = null,
} = {}) {
  const threshold = Number.isFinite(RANK[minLevel]) ? RANK[minLevel] : RANK.info;
  const clean = text => (typeof redact === 'function' ? redact(String(text)) : String(text));

  const log = (level, message, detail) => {
    if (!Number.isFinite(RANK[level]) || RANK[level] < threshold) return;
    // debug 只在 dev 生效：生产既不落盘也不刷屏。
    if (level === 'debug' && !dev) return;
    const text = clean(message === undefined || message === null ? '' : message);
    const detailText = detail === undefined ? '' : safeStringify(detail);
    if (consoleLike && typeof consoleLike[level] === 'function') {
      consoleLike[level](`[${scope}] ${text}${detailText ? ` ${detailText}` : ''}`);
    }
    // 只有 info 及以上落盘；debug 是纯诊断，不进诊断日志。
    if (level !== 'debug' && typeof sink === 'function') {
      try {
        sink({ level, scope, message: text, detail: detail === undefined ? null : detailText, at: Date.now() });
      } catch (error) {
        // 日志自身失败绝不能影响主流程。
      }
    }
  };

  return {
    scope,
    debug: (message, detail) => log('debug', message, detail),
    info: (message, detail) => log('info', message, detail),
    warn: (message, detail) => log('warn', message, detail),
    error: (message, detail) => log('error', message, detail),
  };
}
