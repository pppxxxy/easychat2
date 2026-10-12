// 应用日志装配（Z 系采纳 #10）：把分级 logger 接到本地诊断日志 + 脱敏。
//
// 依赖用惰性 require 获取：本模块可能被纯 Node 测试路径间接加载，顶层 ESM import
// 会拖入 AsyncStorage 等原生模块（与 storage/diagnostics.js 同一约束）。

import { createLogger } from './logger.js';

let diagnosticsLoaded = false;
let secretsLoaded = false;
let recordDiagnostic = null;
let maskSecrets = null;

// 惰性 require。**失败绝不缓存**：置位语句放在 require 成功之后（而不是进函数就置位），
// 这样「依赖还没就绪」只是这一次降级，下次调用会重试。
//
// 为什么必须这样：旧实现一进函数就 `depsLoaded = true`，一旦 require 失败就把
// maskSecrets 永久钉成 null——脱敏器从那一刻起对**全部**诊断失效（粘性失败），
// 把一次加载异常放大成「此后所有日志都不脱敏」。脱敏器加载失败是异常态，
// 缓存它等于把异常态固化成常态。
//
// 两个依赖各自独立置位：diagnostics 拿不到不该连带让脱敏也不可用（反之亦然）。
function getDeps() {
  if (!diagnosticsLoaded) {
    try {
      const mod = require('../storage/diagnostics.js');
      if (typeof mod.recordDiagnostic === 'function') {
        recordDiagnostic = mod.recordDiagnostic;
        diagnosticsLoaded = true;
      }
    } catch (error) {}
  }
  if (!secretsLoaded) {
    try {
      const mod = require('../storage/secrets.js');
      if (typeof mod.maskSecrets === 'function') {
        maskSecrets = mod.maskSecrets;
        secretsLoaded = true;
      }
    } catch (error) {}
  }
  return { recordDiagnostic, maskSecrets };
}

function isDev() {
  return typeof __DEV__ !== 'undefined' ? Boolean(__DEV__) : false;
}

// info 及以上落本地诊断日志（kind='log'）；debug 不落盘。
function appSink(entry) {
  const { recordDiagnostic: record } = getDeps();
  if (typeof record !== 'function') return;
  const error = new Error(entry.message);
  error.name = `Log:${entry.scope}`;
  try {
    record('log', error, entry.scope);
  } catch (e) {}
}

// 建一个带 scope 的应用 logger。dev 下同时打到 console；生产只落诊断日志。
export function createAppLogger(scope, options = {}) {
  const { maskSecrets: redact } = getDeps();
  const dev = isDev();
  return createLogger({
    scope,
    dev,
    sink: appSink,
    consoleLike: dev && typeof console !== 'undefined' ? console : null,
    // 取不到脱敏器就传 null：logger.js 对「没有可用的 redact」是 **fail-closed**
    //（省略文本 + 占位符），绝不回落原文——见 logger.js 里 clean 的注释。
    // 另注意 getDeps 不缓存失败，所以下次 createAppLogger 会重新尝试拿脱敏器。
    redact: typeof redact === 'function' ? redact : null,
    ...options,
  });
}
