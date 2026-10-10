// 本地诊断日志：捕获异常并脱敏留存，供用户/开发者在应用内查看与复制。
//
// 设计约束（与 SECURITY.md「未接入任何分析、广告或遥测 SDK」一致）：
// - 只写本机、绝不上报：不接入 Sentry/Crashlytics 等第三方 SDK，也不发起任何网络请求；
// - 全部文本经 maskSecrets 脱敏，绝不落明文密钥；
// - 有界：内存与持久化都限制条数，避免日志无限增长；
// - 容错：诊断自身失败时静默，绝不影响主流程。
//
// 说明：本模块顶层不放 import，依赖用惰性 require 获取——storage.js 会把本模块
// 间接带入纯 Node 测试环境，顶层 ESM import 在那种加载路径下会解析失败。

const DIAGNOSTICS_KEY = '@easychat2_diagnostics';
const MAX_ENTRIES = 50;
const MAX_FIELD_CHARS = 2000;
const DEDUP_WINDOW_MS = 3000;

// kind：storage（存储损坏/读写失败）、api（接口失败）、webview（卡片渲染异常）、
// unhandled（未捕获异常）、startup（启动异常）、log（分级日志，见 src/logging/）。
const VALID_KINDS = ['storage', 'api', 'webview', 'unhandled', 'startup', 'log'];

let asyncStorage;
let asyncStorageLoaded = false;
function getAsyncStorage() {
  if (!asyncStorageLoaded) {
    asyncStorageLoaded = true;
    try {
      asyncStorage = require('@react-native-async-storage/async-storage').default;
    } catch (error) {
      asyncStorage = null;
    }
  }
  return asyncStorage;
}

let maskSecretsFn;
let maskSecretsLoaded = false;
function getMaskSecrets() {
  if (!maskSecretsLoaded) {
    maskSecretsLoaded = true;
    try {
      maskSecretsFn = require('./secrets.js').maskSecrets;
    } catch (error) {
      maskSecretsFn = null;
    }
  }
  return maskSecretsFn;
}

let cache = null;
let writeQueue = Promise.resolve();
// 读-改-写（读 cache → 追加 → 写回）必须整体串行：recordDiagnostic 可并发调用，
// 若各自基于同一份 current 追加，后写的会覆盖先写的，丢掉日志。
let mutationQueue = Promise.resolve();
let lastSignature = '';
let lastAt = 0;

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function truncate(text) {
  const value = clean(text);
  return value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value;
}

function mask(text) {
  const raw = clean(text);
  const masker = getMaskSecrets();
  return truncate(masker ? masker(raw) : raw);
}

function normalizeKind(kind) {
  const key = clean(kind).trim();
  return VALID_KINDS.includes(key) ? key : 'unhandled';
}

export function normalizeDiagnostic(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const at = Number(source.at);
  return {
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
    kind: normalizeKind(source.kind),
    message: truncate(source.message || ''),
    stack: truncate(source.stack || ''),
    context: truncate(source.context || ''),
  };
}

export function formatDiagnostics(list) {
  const entries = (Array.isArray(list) ? list : []).map(normalizeDiagnostic);
  if (entries.length === 0) return '';
  return entries
    .map(entry => {
      const time = new Date(entry.at).toISOString();
      const lines = [`[${time}] ${entry.kind}: ${entry.message}`];
      if (entry.context) lines.push(`  context: ${entry.context}`);
      if (entry.stack) lines.push(`  ${entry.stack}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

async function readCache() {
  if (cache) return cache;
  const store = getAsyncStorage();
  if (!store) {
    cache = [];
    return cache;
  }
  try {
    const raw = await store.getItem(DIAGNOSTICS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    cache = (Array.isArray(parsed) ? parsed : []).map(normalizeDiagnostic).slice(-MAX_ENTRIES);
  } catch (error) {
    cache = [];
  }
  return cache;
}

function persist(next) {
  const task = writeQueue.then(async () => {
    const store = getAsyncStorage();
    if (!store) return;
    try {
      await store.setItem(DIAGNOSTICS_KEY, JSON.stringify(next));
    } catch (error) {
      // 诊断持久化失败时静默：它不该影响主流程。
    }
  });
  writeQueue = task.catch(() => {});
  return task;
}

// 记录一条诊断。error 可为 Error 或字符串；context 为可选补充说明。
export function recordDiagnostic(kind, error, context = '') {
  try {
    const message = mask(error && error.message !== undefined ? error.message : error);
    const stack = mask(error && error.stack ? error.stack : '');
    const ctx = mask(context);
    const safeKind = normalizeKind(kind);
    // 同内容短窗口去重：连续同错误不刷屏。
    const signature = `${safeKind}|${message}`;
    const now = Date.now();
    if (signature === lastSignature && now - lastAt < DEDUP_WINDOW_MS) {
      return undefined;
    }
    lastSignature = signature;
    lastAt = now;
    const entry = normalizeDiagnostic({ at: now, kind: safeKind, message, stack, context: ctx });
    const task = mutationQueue.then(async () => {
      const current = await readCache();
      const next = [...current, entry].slice(-MAX_ENTRIES);
      cache = next;
      await persist(next);
      return next;
    });
    mutationQueue = task.catch(() => {});
    return task.catch(() => {});
  } catch (error) {
    return undefined;
  }
}

export async function getDiagnostics() {
  const current = await readCache();
  return [...current];
}

export async function clearDiagnostics() {
  cache = [];
  lastSignature = '';
  lastAt = 0;
  const task = mutationQueue.then(async () => {
    const store = getAsyncStorage();
    if (!store) return;
    try {
      await store.removeItem(DIAGNOSTICS_KEY);
    } catch (error) {}
  });
  mutationQueue = task.catch(() => {});
  return task;
}

// 仅测试用：重置内存缓存与惰性依赖。
export function __resetDiagnosticsForTests() {
  cache = null;
  lastSignature = '';
  lastAt = 0;
  writeQueue = Promise.resolve();
  mutationQueue = Promise.resolve();
  asyncStorage = undefined;
  asyncStorageLoaded = false;
  maskSecretsFn = undefined;
  maskSecretsLoaded = false;
}
