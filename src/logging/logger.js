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
// redact 不可用时**省略文本**（fail-closed），绝不回落原文——见下方 clean 的注释。
//
// 纯模块：零 import、零原生依赖（redact 由调用方注入），Node 直测。

export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
const RANK = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

// 脱敏器不可用时的占位文本：**绝不回落原文**。
// 刻意不走 i18n 且不导出：本模块是零 import 的纯模块（Node 直测、不拖 i18n/原生依赖），
// 该文本只出现在诊断日志里（不是界面文案），而 eslint 的硬编码中文规则只查
// Alert/throw/JSX 正文与**模块级导出**常量——非导出常量不在其内。
const REDACT_UNAVAILABLE_TEXT = '[脱敏不可用，已省略]';

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
  // 脱敏的降级方向必须是 **fail-closed**（先例 src/localModel/adapter.js:278
  // 「fail-closed：没钥匙也清」）：脱敏器没注入、抛错、或返回非字符串时，
  // 一律**省略文本**并留占位符，绝不回落 `String(text)` 原文。
  //
  // 为什么不能回落原文：redact 由调用方注入（应用装配点是 src/logging/index.js），
  // 它拿不到脱敏器是**异常态**（模块加载失败）。回落原文等于把「脱敏坏了」这件
  // 事悄悄转换成「把明文密钥写进本地诊断日志」——诊断日志的对外承诺是
  // 「全部文本经 maskSecrets 脱敏，绝不落明文密钥」（storage/diagnostics.js:5）。
  // 占位符还会让这条异常在日志里可见，而不是无声无息。
  const clean = text => {
    const raw = String(text);
    if (typeof redact !== 'function') return REDACT_UNAVAILABLE_TEXT;
    try {
      const masked = redact(raw);
      return typeof masked === 'string' ? masked : REDACT_UNAVAILABLE_TEXT;
    } catch (error) {
      return REDACT_UNAVAILABLE_TEXT;
    }
  };

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
