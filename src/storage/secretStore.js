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
//
// 脱敏双保险：本模块是密钥进出内存的存储边界，遍历到 SECRET_FIELDS 的明文时顺手登记到
// secrets 模块的登记表，供诊断日志脱敏。使用点（api/imageGen/tts/webSearch/vector）仍各自登记，
// 这里兜住「新接入的密钥字段只走了存储边界、忘了在使用点登记」的漏网情况。

import { registerSecretValues } from './secrets.js';
import { recordDiagnostic } from './diagnostics.js';

const SECRET_FIELDS = new Set(['apiKey', 'appSecretKey', 'secretKey', 'githubToken', 'githubAccessToken', 'githubRefreshToken']);
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
