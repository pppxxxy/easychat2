// 密钥保险箱：把配置里的密钥字段抽到系统安全存储（expo-secure-store），
// AsyncStorage 中只保留引用 `secure:v1:<id>`，避免明文落盘。
//
// 设计要点：
// - 透明：调用方仍在内存里看到明文密钥，protect/hydrate 只在存储边界做转换；
// - 确定性 id：密钥 id 由「命名空间 + 数据路径」推导（数组优先用条目自身的 id），
//   同一字段反复保存会覆盖同一条记录，不会产生孤儿密钥；
// - 降级安全：SecureStore 不可用或写入失败时保持明文（不丢密钥、不阻断保存），
//   功能行为与改造前一致；
// - 兼容旧数据：读取时遇到明文（非引用）原样返回，下次保存自动转为引用；
// - 字段白名单精确匹配键名，避免误伤 `apiKeyUrl` 这类同前缀字段。
// - 值不是字符串的敏感字段（`headers` 这类「键名用户自定、值才是密钥」的映射）走
//   SECRET_OBJECT_FIELDS：**逐个值**保护、键名留在盘上（见那里的注释）。
//
// 脱敏双保险：本模块是密钥进出内存的存储边界，遍历到 SECRET_FIELDS 的明文时顺手登记到
// secrets 模块的登记表，供诊断日志脱敏。使用点（api/imageGen/tts/webSearch/vector）仍各自登记，
// 这里兜住「新接入的密钥字段只走了存储边界、忘了在使用点登记」的漏网情况。
//
// —— 读侧的两条「读不回」纪律（逐行审查：两条不可逆缺陷）——
// 1) **保留引用，绝不回落空串**：引用还在、值却读不回（Keystore 读失败 / 生物识别失效 /
//    记录被系统清除）时，标量字段与 hydrateSecretObject（:134-140）采取**同一条**处置——
//    原样保留 `secure:v1:...` 引用串 + 记一条诊断。为什么不能回落 `''`：UI 会渲染成
//    「空密钥框」，用户随手一存，写侧 protectValue 的判据 `item && !isSecretRef(item)`
//    对 `''` 为假 ⇒ 既不写 SecureStore 也不保护，直接把 `''` 明文落盘覆盖盘上的引用
//    ⇒ 旧记录成永久孤儿 ⇒ **密钥不可逆丢失**，且诊断里零记录。
// 2) **引用串不得越出内存边界**：`isSecretStoreAvailable()` 为假时读侧**不能原样返回**
//    （写侧 protectSecrets 原样返回是**有意的**降级：保持明文、不丢密钥，是安全的）。
//    读侧原样返回会把内部引用当凭据交给调用方（io.js 的 readJsonWithSecrets 调用方会拼出
//    `Authorization: Bearer secure:v1:...` 发给服务商）。所以此时**置空 + 标记**
//    SECRET_UNAVAILABLE_KEY，并记同一条诊断口径——见 blankUnresolvedRefs 的注释。

import { registerSecretValues } from './secrets.js';
import { recordDiagnostic } from './diagnostics.js';

// 导出给 dataBackup.js：备份脱敏的字段集必须**包含**保险箱保护的字段集，否则备份会成为
// 绕过保险箱的旁路（见那里的 SECRET_FIELD_NAMES）。
export const SECRET_FIELDS = new Set(['apiKey', 'appSecretKey', 'secretKey', 'githubToken', 'githubAccessToken', 'githubRefreshToken', 'mcpToken']);
// 需要按「对象」保护的字段：**键名由用户自定、值才是密钥**的映射（当前只有 MCP 自定义请求头）。
// 为什么不能只加进 SECRET_FIELDS：那里的判据是「值是字符串」，而 headers 是 `{名: 值}` 对象，
// 逐个值保护才是对的——整对象 JSON 化会撞 expo-secure-store 的 **2048 字节单值上限**
//（node_modules/expo-secure-store/build/byteCounter.js: VALUE_BYTES_LIMIT = 2048），
// 而 normalizeHeaders 允许每个值到 512 字符，几个头就能越界，越界后写入「可能不成功」。
// 为什么按**域键前缀**限定而不是全局按键名匹配：`headers` 太通用，将来别的域出现同名对象时
// 不该被无声搬进安全存储（那边有大小上限，语义上又未必是密钥）。与 SECRET_FIELDS 的
//「精确匹配键名、不做子串匹配」是同一条纪律。
export const SECRET_OBJECT_FIELDS = new Map([['headers', ['@easychat2_mcp_servers']]]);
const REF_PREFIX = 'secure:v1:';
const SECURE_STORE_PREFIX = 'easychat2_secret_';

// 「读不回」的统一标记：hydrate 结果里挂上它，UI 据此提示「安全存储不可用，密钥需重新填写」。
// 刻意做成**非枚举**属性（Object.defineProperty，见 blankUnresolvedRefs）：
// - 它要能穿透 JSON/对象展开以外的常规读取（调用方 `payload[KEY] === true` 即可判断）；
// - 但不能被 JSON.stringify 带进存储、也不能污染 `deepEqual`/`Object.keys` 这类结构断言
//   （既有测试大量用 deepEqual 比对 hydrate 结果）。
// 用一个模块级常量而不是散落的字面量：① 与 ①（引用保留）共用**同一套**「读不回」语义，
// 不造两套标记；② 调用方/测试从这里 import，避免各写一份字符串而漂移。
export const SECRET_UNAVAILABLE_KEY = '__secretUnavailable';

let secureStoreModule;
let secureStoreLoaded = false;

function getSecureStore() {
  if (!secureStoreLoaded) {
    secureStoreLoaded = true;
    try {
      // 原生模块在 Node/测试环境可能不可用，惰性加载并容错。
      secureStoreModule = require('expo-secure-store');
    } catch (error) {
      secureStoreModule = null;
    }
  }
  return secureStoreModule;
}

// 进程内缓存：同一次运行里同一 id 的密钥只读一次安全存储。
const secretCache = new Map();

function sanitizeSegment(value) {
  return String(value == null ? '' : value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// 数组里优先用条目自身的 id 作为路径段：配置增删/重排后密钥仍指向同一条目。
function arraySegment(item, index) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const id = sanitizeSegment(item.id);
    if (id) return id;
  }
  return String(index);
}

function childPath(path, segment) {
  return path ? `${path}.${sanitizeSegment(segment)}` : sanitizeSegment(segment);
}

export function isSecretRef(value) {
  return typeof value === 'string' && value.startsWith(REF_PREFIX);
}

function makeSecretId(namespace, path) {
  return sanitizeSegment(namespace) + (path ? `_${sanitizeSegment(path)}` : '');
}

function refId(value) {
  return value.slice(REF_PREFIX.length);
}

// 该字段在本命名空间下是否需要「按对象保护」。命名空间就是存储键（如
// `@easychat2_mcp_servers`），同域的分键形式（`@easychat2_mcp_servers::x`）也算命中。
function isScopedSecretObject(key, namespace) {
  const scopes = SECRET_OBJECT_FIELDS.get(key);
  if (!scopes) return false;
  const ns = String(namespace || '');
  return scopes.some(prefix => ns === prefix || ns.startsWith(`${prefix}::`));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 按对象保护的写侧：**每个值单独一条安全存储记录**，键名留在盘上。
// 键名留在盘上是有意的——排查「配了哪些头」不需要密钥，而值一个都不能留。
async function protectSecretObject(source, namespace, path) {
  const out = {};
  for (const [name, value] of Object.entries(source)) {
    const text = typeof value === 'string' ? value : '';
    if (!text) {
      out[name] = value;
      continue;
    }
    registerSecretValues([text]);
    const id = makeSecretId(namespace, childPath(path, name));
    try {
      await writeSecret(id, text);
      out[name] = `${REF_PREFIX}${id}`;
    } catch (error) {
      // 与标量字段同一条降级纪律：写入失败保持明文（不丢配置），但必须可查。
      recordDiagnostic('secrets', error, `secure-store 写入失败，请求头降级明文：${namespace}/${childPath(path, name)}`);
      out[name] = text;
    }
  }
  return out;
}

// 按对象保护的读侧。读不回的那一条**不还原**：宁可少一个头（连不上、报错可见），
// 也绝不把 `secure:v1:...` 这个引用串当成真头发出去——那既连不上，又把引用泄漏给服务端。
async function hydrateSecretObject(source, namespace, path) {
  const out = {};
  for (const [name, value] of Object.entries(source)) {
    if (!isSecretRef(value)) {
      // legacy 明文（改造前整块存盘）同样是密钥：登记进脱敏表，否则升级后第一次
      // 读盘拿到的旧 token 不会被日志脱敏。
      registerSecretValues([value]);
      out[name] = value;
      continue;
    }
    const text = await readSecret(refId(value));
    if (text !== null && text !== '') {
      registerSecretValues([text]);
      out[name] = text;
    } else {
      // 与标量分支共用**同一条**诊断口径（error.message 一致，只有 context 更具体）：
      // 「读不回」是一个语义，不该因为字段是对象值就换一套说法。
      // 判据从 `if (text)` 改为 `text !== null && text !== ''`：readSecret 现在用 null 表示
      // 「读不回」，而 `''` 是「确实存了空串」——两者都不还原（空头值没有意义），
      // 但只有前者是异常，必须留痕 + 打标记。
      recordDiagnostic('secrets', new Error('secure-store 引用无法还原'), `请求头丢失：${namespace}/${childPath(path, name)}`);
      markSecretUnavailable(out);
    }
  }
  return out;
}

export function isSecretStoreAvailable() {
  const store = getSecureStore();
  return !!(store && typeof store.setItemAsync === 'function' && typeof store.getItemAsync === 'function');
}

export function clearSecretCache() {
  secretCache.clear();
}

// 仅测试用：重置模块加载状态与缓存，便于切换 mock。
export function __resetSecretStoreForTests() {
  secretCache.clear();
  secureStoreModule = undefined;
  secureStoreLoaded = false;
}

async function writeSecret(id, value) {
  const store = getSecureStore();
  if (!store) throw new Error('secure store unavailable');
  await store.setItemAsync(SECURE_STORE_PREFIX + id, value);
  secretCache.set(id, value);
}

// 读一条安全存储记录。**返回值必须能区分「确实存了空串」与「读不回」**：
// 旧实现在 store 不存在 / getItemAsync 抛错 / 记录为 null 三条失败路径上**一律 return ''**，
// 调用方（hydrate）无从区分，于是把「值读不回」静默写成了空串——见文件头两条纪律。
// 现在统一返回 **null = 读不回（失败）**，`''` 只表示「这条记录确实是空串」。
// 兼容面：readSecureValue 仍按旧契约对外返回字符串（见那里），本函数不外露 null。
async function readSecret(id) {
  if (secretCache.has(id)) return secretCache.get(id);
  const store = getSecureStore();
  if (!store) return null;
  try {
    const value = await store.getItemAsync(SECURE_STORE_PREFIX + id);
    // null/undefined = 记录不存在（引用成了孤儿），同样是「读不回」，**不缓存**：
    // 缓存会把一次失败钉死成常态（先例 diagnostics.js:40-58 对 maskSecrets 的论证），
    // 且 Keystore 短暂不可用后恢复时，进程内缓存会继续喂旧结论。
    if (value === null || value === undefined) return null;
    const resolved = String(value);
    secretCache.set(id, resolved);
    return resolved;
  } catch (error) {
    return null;
  }
}

async function deleteSecret(id) {
  secretCache.delete(id);
  const store = getSecureStore();
  if (!store || typeof store.deleteItemAsync !== 'function') return;
  try {
    await store.deleteItemAsync(SECURE_STORE_PREFIX + id);
  } catch (error) {}
}

// 通用安全存储读写：供密钥字段以外的敏感值（如单角色锁密码）复用，保持
// 「expo-secure-store 只在本模块出现」的单一封装点。写入失败会抛出，调用方需处理。
export async function writeSecureValue(id, value) {
  await writeSecret(String(id), String(value));
}

// 对外保留旧契约：返回字符串（读不回时为 ''）。单角色锁密码（security.js:308）的判据是
// 「空 = 没设过密码」，它**不能**拿到 null，否则调用方每次都要多写一层判空。
// 内部 hydrate 路径一律走 readSecret 以保留 null（见那里的注释）。
export async function readSecureValue(id) {
  const value = await readSecret(String(id));
  return value === null ? '' : value;
}

export async function removeSecureValue(id) {
  await deleteSecret(String(id));
}

// 从任意嵌套值里收集 secure 引用 id（纯函数）：删除配置/清凭据时据此找出不再被引用的
// 密钥 id。与 protectValue 的遍历口径一致（字符串 / 数组 / 对象）。
export function collectSecretRefIdsFromValue(value, out = new Set()) {
  if (typeof value === 'string') {
    if (value.startsWith(REF_PREFIX)) out.add(value.slice(REF_PREFIX.length));
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectSecretRefIdsFromValue(item, out));
    return out;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(item => collectSecretRefIdsFromValue(item, out));
  }
  return out;
}

// 批量删除安全存储条目（孤儿回收用）。单条失败不抛（安全存储不可用时自然 no-op）。
export async function deleteSecretsByIds(ids) {
  for (const id of ids || []) {
    try {
      await deleteSecret(String(id));
    } catch (error) {}
  }
}

async function protectValue(value, namespace, path) {
  if (Array.isArray(value)) {
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
      const segment = arraySegment(value[index], index);
      out.push(await protectValue(value[index], namespace, childPath(path, segment)));
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_FIELDS.has(key) && typeof item === 'string' && item && !isSecretRef(item)) {
        registerSecretValues([item]);
        const id = makeSecretId(namespace, childPath(path, key));
        try {
          await writeSecret(id, item);
          out[key] = `${REF_PREFIX}${id}`;
        } catch (error) {
          // 安全存储写入失败：保持明文，至少不丢密钥、不阻断保存。
          // 但这个降级必须可查——静默降级意味着用户以为密钥在 Keystore 里，
          // 实际已落明文（root/调试工具可读）。recordDiagnostic 内部做了脱敏，
          // 这里只传字段路径，不传密钥本身。
          recordDiagnostic('secrets', error, `secure-store 写入失败，密钥降级明文：${namespace}/${childPath(path, key)}`);
          out[key] = item;
        }
      } else if (isScopedSecretObject(key, namespace) && isPlainObject(item)) {
        out[key] = await protectSecretObject(item, namespace, childPath(path, key));
      } else {
        out[key] = await protectValue(item, namespace, childPath(path, key));
      }
    }
    return out;
  }
  return value;
}

// 「读不回」标记要能**冒泡到最外层**：调用方拿到的是整份 payload（io.js 的
// readJsonWithSecrets 返回值），它不可能去遍历深层节点找标记。所以每一层算完子节点后
// 检查子节点是否带标记，带则把自己也标记上（hasSecretUnavailable 只读不建）。
function hasSecretUnavailable(value) {
  return !!value && typeof value === 'object' && value[SECRET_UNAVAILABLE_KEY] === true;
}

async function hydrateValue(value, namespace, path) {
  if (Array.isArray(value)) {
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
      const segment = arraySegment(value[index], index);
      const child = await hydrateValue(value[index], namespace, childPath(path, segment));
      if (hasSecretUnavailable(child)) markSecretUnavailable(out);
      out.push(child);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_FIELDS.has(key) && isSecretRef(item)) {
        // 与 hydrateSecretObject（:134-140）**对齐**：读不回时**保留原引用串**（`out[key] = item`），
        // 记同一条诊断，绝不写 `''`。判据用 `!== null` 而不是真值判断：`''` 是「确实存了空串」
        // 这一种**成功**结果，不能与「读不回」混为一谈（后者才是必须留痕的异常）。
        const secret = await readSecret(refId(item));
        if (secret !== null) {
          out[key] = secret;
          registerSecretValues([secret]);
        } else {
          // 保留引用串，不用空串：空串会让 UI 显示空密钥框，用户随手一存就把盘上的引用
          // 覆盖成 `''` 明文（写侧 `item && !isSecretRef(item)` 对 '' 为假），旧记录成永久孤儿。
          // 引用串本身**不是**凭据，登记脱敏即可（避免它出现在错误文本里）。
          out[key] = item;
          registerSecretValues([item]);
          recordDiagnostic('secrets', new Error('secure-store 引用无法还原'), `密钥引用无法还原：${namespace}/${childPath(path, key)}`);
          markSecretUnavailable(out);
        }
      } else if (isScopedSecretObject(key, namespace) && isPlainObject(item)) {
        out[key] = await hydrateSecretObject(item, namespace, childPath(path, key));
      } else {
        // legacy 明文（非引用）也要登记：否则密钥进入内存却未登记，错误文本里
        // 一旦带出就只能靠最佳努力的正则兜底，对 sk-ant- 等形态会漏。
        if (SECRET_FIELDS.has(key) && typeof item === 'string' && item) {
          registerSecretValues([item]);
        }
        out[key] = await hydrateValue(item, namespace, childPath(path, key));
      }
      if (hasSecretUnavailable(out[key])) markSecretUnavailable(out);
    }
    return out;
  }
  return value;
}

// 在 hydrate 结果上挂「读不回」标记。用 defineProperty 而非赋值，理由见
// SECRET_UNAVAILABLE_KEY 的注释（不可被 JSON 序列化带走、不污染 deepEqual 断言）。
// 已有标记就跳过：同一个 payload 里多处读不回只挂一次，也避免重复 defineProperty。
function markSecretUnavailable(out) {
  if (!out || typeof out !== 'object') return out;
  if (Object.prototype.hasOwnProperty.call(out, SECRET_UNAVAILABLE_KEY)) return out;
  Object.defineProperty(out, SECRET_UNAVAILABLE_KEY, {
    value: true,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return out;
}

// 安全存储不可用时的读侧兜底：**扫描残留引用串，就地置空**。
// 为什么必须置空而不是原样返回：引用串 `secure:v1:<id>` 是**内部寻址标识、不是凭据**，
// 而调用方（io.js:70-79 的 readJsonWithSecrets/readJsonStatusWithSecrets）拿到的就是
// 「可以直接用的明文密钥」——它会拼出 `Authorization: Bearer secure:v1:...` 发给服务商
// （api.js:77-79 只做 String(source.apiKey || '') 拼接，**网络层没有任何引用串守卫**）。
// 也就是说原样返回 = 把内部引用泄漏成凭据，且用户看到 `secure:v1:xxx` 会以为自己配过。
// 置空（而不是删键）是刻意的：字段仍在、值为空 ⇒ UI 的「请先填写 API 密钥」判据
//（api.js:281 `!config.apiKey`）能正常触发，用户被明确要求重新填写；
// 配合 SECRET_UNAVAILABLE_KEY 标记，界面可以给出比「密钥为空」更准确的提示。
// 与 ① 的分工：① 存储**可用**、只是某条记录读不回 ⇒ 保留引用 + 留痕（可逆、可自愈）；
// ② 存储**整体不可用**、连解引用能力都没有 ⇒ 置空 + 标记 + 留痕（**绝不外泄引用串**）。
// 两处共用同一个标记与同一条诊断口径（'secure-store 引用无法还原'），不造两套语义。
function blankUnresolvedRefs(value, namespace, path) {
  if (Array.isArray(value)) {
    return value.map((item, index) => blankUnresolvedRefs(item, namespace, childPath(path, arraySegment(item, index))));
  }
  if (value && typeof value === 'object') {
    const out = {};
    let blanked = false;
    for (const [key, item] of Object.entries(value)) {
      if (isSecretRef(item)) {
        out[key] = '';
        blanked = true;
        // 引用串登记脱敏：它不该出现在任何错误文本里（虽然本身不是凭据，
        // 但泄漏它等于告诉外界「这台设备上有一条 id 为 X 的安全存储记录」）。
        registerSecretValues([item]);
        recordDiagnostic('secrets', new Error('secure-store 引用无法还原'), `密钥引用无法还原：${namespace}/${childPath(path, key)}`);
        continue;
      }
      const next = blankUnresolvedRefs(item, namespace, childPath(path, key));
      out[key] = next;
      if (hasSecretUnavailable(next)) blanked = true;
    }
    // 标记同样要冒泡到最外层（调用方只看得见顶层 payload）。
    if (blanked) markSecretUnavailable(out);
    return out;
  }
  return value;
}

// 写盘前：把明文密钥搬进安全存储，payload 中替换为引用。
export async function protectSecrets(namespace, payload) {
  // 写侧原样返回是**有意的**降级：保持明文（不丢密钥、不阻断保存），
  // 与读侧的置空**语义相反但都是对的**——写侧怕丢数据，读侧怕泄漏凭据。见文件头纪律 2。
  if (!isSecretStoreAvailable()) return payload;
  return protectValue(payload, namespace, '');
}

// 读盘后：把引用回填为明文密钥，供内存业务逻辑使用。
export async function hydrateSecrets(namespace, payload) {
  if (!isSecretStoreAvailable()) {
    // 不能原样返回：那会让引用串以「明文密钥」的身份流进网络层（见 blankUnresolvedRefs 注释）。
    recordDiagnostic('secrets', new Error('secure-store 引用无法还原'), `安全存储不可用，已置空引用字段：${namespace}`);
    const blanked = blankUnresolvedRefs(payload, namespace, '');
    // 即使这一份 payload 里没有引用串（全是 legacy 明文），也要打标记：
    // 调用方据此知道「本进程的安全存储不可用」，UI 提示「安全存储不可用，密钥需重新填写」。
    return markSecretUnavailable(blanked);
  }
  return hydrateValue(payload, namespace, '');
}
