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
// unhandled（未捕获异常）、startup（启动异常）、log（分级日志，见 src/logging/）、
// secrets（密钥保险箱降级/引用还原失败，见 storage/secretStore.js）。
// 注意 'secrets' 必须在这里登记：normalizeKind 对未知 kind 会归到 'unhandled'，
// 那样「密钥降级明文」这条最需要被看见的记录会被埋在未捕获异常里。
const VALID_KINDS = ['storage', 'api', 'webview', 'unhandled', 'startup', 'log', 'secrets'];

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
// 惰性 require。**失败绝不缓存**：置位语句放在 require 成功之后（不是进函数就置位），
// 「脱敏器还没就绪」只是这一次降级，下次调用会重试。
//
// 为什么必须这样：旧实现一进函数就 `maskSecretsLoaded = true`，一次 require 失败
// 就把 maskSecretsFn 永久钉成 null——脱敏器从那一刻起对**全部**诊断失效（粘性失败），
// 一次加载异常被放大成「此后所有诊断日志都不脱敏」。脱敏器加载失败是异常态，
// 缓存它等于把异常态固化成常态。
function getMaskSecrets() {
  if (maskSecretsLoaded) return maskSecretsFn;
  try {
    const mod = require('./secrets.js');
    if (typeof mod.maskSecrets !== 'function') return null;
    maskSecretsFn = mod.maskSecrets;
    maskSecretsLoaded = true;
  } catch (error) {
    return null;
  }
  return maskSecretsFn;
}

// 脱敏不可用时的占位文本：**绝不回落原文**。
// 不导出是刻意的：eslint 的硬编码中文规则查「模块级**导出**常量」，非导出常量不在其内，
// 而该文本只出现在诊断日志里（不是界面文案）。含中文也比落明文密钥好得多。
const MASK_UNAVAILABLE_TEXT = '[脱敏不可用，已省略]';

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

// 脱敏的降级方向必须是 **fail-closed**（先例 src/localModel/adapter.js:278
// 「fail-closed：没钥匙也清」）：脱敏器不可用、抛错、或返回非字符串时，一律
// **省略文本**并留占位符，绝不 `truncate(raw)` 回落原文。
//
// 为什么不能回落原文：本文件的对外承诺是「全部文本经 maskSecrets 脱敏，绝不落明文密钥」
// （见文件头第 5 行）。回落原文会把「脱敏器加载失败」这件异常悄悄转换成
// 「把明文 API Key 写进本地诊断日志」——而且旧实现还会把这个失败粘性缓存下来，
// 一次失败等于此后全部诊断都未脱敏。占位符同时让这条异常在日志里可见。
function mask(text) {
  const raw = clean(text);
  const masker = getMaskSecrets();
  if (typeof masker !== 'function') return truncate(MASK_UNAVAILABLE_TEXT);
  try {
    const masked = masker(raw);
    return truncate(typeof masked === 'string' ? masked : MASK_UNAVAILABLE_TEXT);
  } catch (error) {
    return truncate(MASK_UNAVAILABLE_TEXT);
  }
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
