// 应用日志装配（Z 系采纳 #10）：把分级 logger 接到本地诊断日志 + 脱敏。
//
// 依赖用惰性 require 获取：本模块可能被纯 Node 测试路径间接加载，顶层 ESM import
// 会拖入 AsyncStorage 等原生模块（与 storage/diagnostics.js 同一约束）。

import { createLogger } from './logger.js';

let depsLoaded = false;
let recordDiagnostic = null;
let maskSecrets = null;

function getDeps() {
  if (!depsLoaded) {
    depsLoaded = true;
    try {
      recordDiagnostic = require('../storage/diagnostics.js').recordDiagnostic;
    } catch (error) {
      recordDiagnostic = null;
    }
    try {
      maskSecrets = require('../storage/secrets.js').maskSecrets;
    } catch (error) {
      maskSecrets = null;
    }
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
    redact: typeof redact === 'function' ? redact : null,
    ...options,
  });
}
