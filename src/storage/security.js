// 隐私安全存储：应用锁（生物识别）与单角色锁（数字密码）的设置。
//
// 设计：
// - 单一元数据键 `@easychat2_security`：`{ appLock: { enabled, relockOnBackground },
//   characterLocks: { [characterId]: true } }`。只存「哪些角色上锁」，不存密码。
// - 密码本身落系统安全存储（expo-secure-store，经 secretStore.js 封装），
//   AsyncStorage 里永远没有明文；`characterLocks` 只是上锁名单。
// - 角色删除时清理其锁与密码（模块内注册钩子，见 storage/characterLifecycle.js）。
// - 设置页写入后通过本模块的订阅通知 SecurityGate 立即重读（避免跨页面状态不同步）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { onCharacterDeleted } from './characterLifecycle.js';
import { backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';
import { readSecureValue, removeSecureValue, writeSecureValue } from './secretStore.js';

export const SECURITY_KEY = '@easychat2_security';
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

const LOCK_SECURE_PREFIX = 'character_lock_';
const securityMutation = createMutationQueue();

// 进程内订阅：设置页保存后通知 SecurityGate 重新读取设置并与存储保持一致。
const securityListeners = new Set();

export function subscribeSecuritySettings(listener) {
  if (typeof listener !== 'function') return () => {};
  securityListeners.add(listener);
  return () => securityListeners.delete(listener);
}

function notifySecurityChanged() {
  securityListeners.forEach(listener => {
    try {
      listener();
    } catch (error) {}
  });
}

// 纯函数：密码只接受数字，最长 PIN_MAX_LENGTH 位。
export function normalizePin(value) {
  return String(value == null ? '' : value).replace(/\D/g, '').slice(0, PIN_MAX_LENGTH);
}

export function isValidPin(value) {
  const pin = normalizePin(value);
  return pin.length >= PIN_MIN_LENGTH && pin.length <= PIN_MAX_LENGTH;
}

export function normalizeAppLock(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: source.enabled === true,
    // 缺省开启：应用锁的意义在于离开后自动重新验证；显式写入 false 才关闭。
    relockOnBackground: source.relockOnBackground !== false,
  };
}

function normalizeCharacterLocks(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  Object.keys(source).forEach(key => {
    const id = String(key || '');
    if (id && source[key] === true) result[id] = true;
  });
  return result;
}

async function readSecurity() {
  const stored = await readJsonStatus(SECURITY_KEY);
  if (stored.status === 'corrupt') {
    await backupCorruptValue(SECURITY_KEY);
    return { appLock: normalizeAppLock(null), characterLocks: {} };
  }
  const raw = stored.status === 'ok' && stored.value && typeof stored.value === 'object'
    ? stored.value
    : {};
  return {
    appLock: normalizeAppLock(raw.appLock),
    characterLocks: normalizeCharacterLocks(raw.characterLocks),
  };
}

async function writeSecurity(next) {
  await AsyncStorage.setItem(SECURITY_KEY, JSON.stringify(next));
  notifySecurityChanged();
  return next;
}

export async function getSecuritySettings() {
  return readSecurity();
}

export async function getAppLockSettings() {
  return (await readSecurity()).appLock;
}

export async function getCharacterLocks() {
  return (await readSecurity()).characterLocks;
}

export async function isCharacterLocked(characterId) {
  const id = String(characterId || '');
  if (!id) return false;
  return !!(await readSecurity()).characterLocks[id];
}

// 局部更新应用锁设置：读现值 → 合并补丁 → 归一化写回（与外观设置同一惯例，
// 避免只带单字段的写入把另一字段归回默认值）。
export function saveAppLockSettings(patch) {
  return securityMutation.enqueue(async () => {
    const current = await readSecurity();
    const appLock = normalizeAppLock({
      ...current.appLock,
      ...(patch && typeof patch === 'object' ? patch : {}),
    });
    await writeSecurity({ ...current, appLock });
    return appLock;
  });
}

// 给角色上锁：密码写入安全存储，随后把角色登记进上锁名单。两组写入都在队列内，
// 顺序为「先密码、后名单」——即便中途崩溃，也不会出现「名录里有锁但密码读不到」。
export function setCharacterLock(characterId, passcode) {
  const id = String(characterId || '');
  if (!id) return Promise.resolve(false);
  const pin = normalizePin(passcode);
  if (!isValidPin(pin)) return Promise.resolve(false);
  return securityMutation.enqueue(async () => {
    const current = await readSecurity();
    await writeSecureValue(LOCK_SECURE_PREFIX + id, pin);
    const characterLocks = { ...current.characterLocks, [id]: true };
    await writeSecurity({ ...current, characterLocks });
    return true;
  });
}

export function removeCharacterLock(characterId) {
  const id = String(characterId || '');
  if (!id) return Promise.resolve(false);
  return securityMutation.enqueue(async () => {
    const current = await readSecurity();
    const wasLocked = current.characterLocks[id] === true;
    const characterLocks = { ...current.characterLocks };
    delete characterLocks[id];
    await removeSecureValue(LOCK_SECURE_PREFIX + id);
    if (wasLocked) await writeSecurity({ ...current, characterLocks });
    return wasLocked;
  });
}

// 校验密码：读安全存储里的原值逐字符比较（定长+按位异或，避免明显的时间差）。
export async function verifyCharacterPasscode(characterId, passcode) {
  const id = String(characterId || '');
  if (!id) return false;
  const pin = normalizePin(passcode);
  if (!pin) return false;
  const stored = await readSecureValue(LOCK_SECURE_PREFIX + id);
  if (!stored || stored.length !== pin.length) return false;
  let diff = 0;
  for (let index = 0; index < stored.length; index += 1) {
    diff |= stored.charCodeAt(index) ^ pin.charCodeAt(index);
  }
  return diff === 0;
}

async function deleteCharacterLocksInternal(characterIds) {
  const ids = (Array.isArray(characterIds) ? characterIds : [])
    .map(id => String(id || ''))
    .filter(Boolean);
  if (ids.length === 0) return;
  const current = await readSecurity();
  const characterLocks = { ...current.characterLocks };
  let changed = false;
  for (const id of ids) {
    if (characterLocks[id]) {
      delete characterLocks[id];
      changed = true;
    }
    await removeSecureValue(LOCK_SECURE_PREFIX + id);
  }
  if (changed) await writeSecurity({ ...current, characterLocks });
}

// 角色删除时清理其锁与密码（谁的数据谁负责）。
onCharacterDeleted('security', deleteCharacterLocksInternal);

// 测试用：清空订阅者，避免用例间泄漏。
export function __resetSecurityListenersForTests() {
  securityListeners.clear();
}

export { LOCK_SECURE_PREFIX };
