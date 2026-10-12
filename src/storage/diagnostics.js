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

// 损坏键的备份后缀。**权威定义在 io.js:11（CORRUPT_BACKUP_SUFFIX）**，这里刻意只写同一个
// 字面量而**不 import**：io.js 已经依赖本模块（io.js:8 recordDiagnostic），再 require/import
// 回去就是环，guard-structure 的循环依赖守卫会红（「请打破环：把公共依赖抽到第三方模块，
// 或改用参数注入」）。同型先例：storage/backup.js:19 与 dataBackup.js:172 也是同一字面量。
const CORRUPT_SUFFIX = '__corrupt_backup';

// 结构损坏（JSON.parse 失败）时先留原始字节的副本再抛错：覆盖不可逆，同仓惯例见
// io.js:180-199（backupCorruptValue）。
// 只在本函数**已经拿到原始串**时备份：连 getItem 都抛错时手里没有字节，也就没得备份
//（io.js 的 backupCorruptValue 在同一情形下同样只能返回 false）。
// 这里不调 recordDiagnostic 记「已备份」：那会经 readCache 又回到失败分支（本函数正是它的
// 失败路径），那条诊断必然被丢弃，还会绕一圈。证据就是 `<键>__corrupt_backup` 本身，加上
// DiagnosticsModal 现在会显示的「读取失败」态。
async function backupUnreadableDiagnostics(store, raw) {
  if (typeof raw !== 'string' || !raw) return;
  try {
    await store.setItem(`${DIAGNOSTICS_KEY}${CORRUPT_SUFFIX}`, raw);
  } catch (error) {
  }
}

// 读诊断记录：**读失败绝不返回空数组**。
// 旧实现在 catch 里 `cache = []`，而 `if (cache) return cache` 对 [] 为真 ⇒ 失败态被钉死在
// 内存里，且 DiagnosticsModal 的 `loaded && entries.length === 0` 把它渲染成绿勾
// 「暂无可查看的记录」——「读不出来」被说成「一切正常」；更糟的是随后任一次
// recordDiagnostic 读到的 current 是 []，persist([entry]) 会把存储里几十条历史整份覆盖成
// 一条，且不留下损坏副本。
// 与 :40-58 对 maskSecrets 的论证完全同形：**缓存异常态等于把异常固化成常态**。故这里改为
// 原样抛出、cache 保持 null（下次调用重试），由调用方区分「读失败」与「确实没有记录」。
async function readCache() {
  if (cache) return cache;
  const store = getAsyncStorage();
  if (!store) {
    // 没有存储（纯 Node 环境 / AsyncStorage 不可用）：既没有可读的原值，也没有被覆盖的风险。
    cache = [];
    return cache;
  }
  const raw = await store.getItem(DIAGNOSTICS_KEY);
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch (error) {
    await backupUnreadableDiagnostics(store, raw);
    throw error;
  }
  cache = (Array.isArray(parsed) ? parsed : []).map(normalizeDiagnostic).slice(-MAX_ENTRIES);
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
      // readCache 读不出来时会抛错 ⇒ 本任务直接中止，**读不出原值就不写**
      //（先例 storage/settings/chatOptions.js:19-33 的 assertReadableForMutation）。
      // 代价是丢掉这一条新诊断；换来的是不把存储里的历史整份覆盖成一条（旧行为）。
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

// 清空诊断记录：**失败必须传得出去**。旧实现把 removeItem 的失败吞在内部（永不 reject），
// 于是调用方写的 `.catch(() => {})` 是死代码，UI 还会把列表清成空 ⇒ 看起来清掉了，
// 重启后日志「复活」。同时内存缓存只在**真正删掉之后**才清：删失败时保留缓存，
// 界面与存储保持一致（与 readCache 的 fail-closed 同一条纪律）。
export async function clearDiagnostics() {
  const task = mutationQueue.then(async () => {
    const store = getAsyncStorage();
    if (store) await store.removeItem(DIAGNOSTICS_KEY);
    cache = [];
    lastSignature = '';
    lastAt = 0;
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
