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

import { registerSecretValues } from './secrets.js';
import { recordDiagnostic } from './diagnostics.js';

const SECRET_FIELDS = new Set(['apiKey', 'appSecretKey', 'secretKey', 'githubToken', 'githubAccessToken', 'githubRefreshToken', 'mcpToken']);
// 需要按「对象」保护的字段：**键名由用户自定、值才是密钥**的映射（当前只有 MCP 自定义请求头）。
// 为什么不能只加进 SECRET_FIELDS：那里的判据是「值是字符串」，而 headers 是 `{名: 值}` 对象，
// 逐个值保护才是对的——整对象 JSON 化会撞 expo-secure-store 的 **2048 字节单值上限**
//（node_modules/expo-secure-store/build/byteCounter.js: VALUE_BYTES_LIMIT = 2048），
// 而 normalizeHeaders 允许每个值到 512 字符，几个头就能越界，越界后写入「可能不成功」。
// 为什么按**域键前缀**限定而不是全局按键名匹配：`headers` 太通用，将来别的域出现同名对象时
// 不该被无声搬进安全存储（那边有大小上限，语义上又未必是密钥）。与 SECRET_FIELDS 的
//「精确匹配键名、不做子串匹配」是同一条纪律。
const SECRET_OBJECT_FIELDS = new Map([['headers', ['@easychat2_mcp_servers']]]);
const REF_PREFIX = 'secure:v1:';
const SECURE_STORE_PREFIX = 'easychat2_secret_';

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
    if (text) {
      registerSecretValues([text]);
      out[name] = text;
    } else {
      recordDiagnostic('secrets', new Error('secure-store 引用无法还原'), `请求头丢失：${namespace}/${childPath(path, name)}`);
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

async function readSecret(id) {
  if (secretCache.has(id)) return secretCache.get(id);
  const store = getSecureStore();
  if (!store) return '';
  try {
    const value = await store.getItemAsync(SECURE_STORE_PREFIX + id);
    const resolved = value === null || value === undefined ? '' : String(value);
    secretCache.set(id, resolved);
    return resolved;
  } catch (error) {
    return '';
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

export async function readSecureValue(id) {
  return readSecret(String(id));
}

export async function removeSecureValue(id) {
  await deleteSecret(String(id));
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

async function hydrateValue(value, namespace, path) {
  if (Array.isArray(value)) {
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
      const segment = arraySegment(value[index], index);
      out.push(await hydrateValue(value[index], namespace, childPath(path, segment)));
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_FIELDS.has(key) && isSecretRef(item)) {
        out[key] = await readSecret(refId(item));
        registerSecretValues([out[key]]);
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
    }
    return out;
  }
  return value;
}

// 写盘前：把明文密钥搬进安全存储，payload 中替换为引用。
export async function protectSecrets(namespace, payload) {
  if (!isSecretStoreAvailable()) return payload;
  return protectValue(payload, namespace, '');
}

// 读盘后：把引用回填为明文密钥，供内存业务逻辑使用。
export async function hydrateSecrets(namespace, payload) {
  if (!isSecretStoreAvailable()) return payload;
  return hydrateValue(payload, namespace, '');
}
