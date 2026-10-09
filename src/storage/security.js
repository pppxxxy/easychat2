// 隐私安全存储：应用锁（生物识别）与角色锁（数字密码）的设置。
//
// 设计：
// - 单一元数据键 `@easychat2_security`：`{ appLock: { enabled, relockOnBackground },
//   characterLocks: { [characterId]: true } }`。只存「哪些角色上锁」，不存密码。
// - 密码与密码提示都落系统安全存储（expo-secure-store，经 secretStore.js 封装），
//   AsyncStorage 里永远没有明文；`characterLocks` 只是上锁名单。
//   提示按角色各存一条（character_lock_hint_<id>）：提示可能暗含密码线索
//   （「我最常用的那串数字」这类），与密码同级保护、与锁同生命周期。
// - 批量上锁（多选/全选）在存储层就是「对每个选中角色写同一个密码」：
//   校验路径不必区分单角色/批量，SecurityGate 一行都不用改。
// - 角色删除时清理其锁、密码与提示（模块内注册钩子，见 storage/characterLifecycle.js）。
// - 设置页写入后通过本模块的订阅通知 SecurityGate 立即重读（避免跨页面状态不同步）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { onCharacterDeleted } from './characterLifecycle.js';
import { backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';
import { readSecureValue, removeSecureValue, writeSecureValue } from './secretStore.js';

export const SECURITY_KEY = '@easychat2_security';
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;
// 密码提示的长度上限：提示是「帮自己回忆」的一句话，不需要更长；
// 限长也顺便挡住把完整密码写进提示这类自掘坑（写不进去总比写进去好）。
export const LOCK_HINT_MAX_LENGTH = 120;

const LOCK_SECURE_PREFIX = 'character_lock_';
const LOCK_HINT_SECURE_PREFIX = 'character_lock_hint_';
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

// 纯函数：密码提示去掉首尾空白并限长；空串表示「没有提示」。
export function normalizeLockHint(value) {
  return String(value == null ? '' : value).trim().slice(0, LOCK_HINT_MAX_LENGTH);
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

// 批量上锁（设置页「多选 / 全选」）：对每个选中角色写同一个密码，
// 与单个上锁共用同一份存储布局——校验路径不区分「批量密码」与「单个密码」。
// hint 语义：undefined = 不改动原有提示（用户没填就别动他的备忘）；
// 字符串 = 统一覆盖（空串即清除这批角色的提示）。
export function setCharacterLocks(characterIds, passcode, hint) {
  const ids = (Array.isArray(characterIds) ? characterIds : [])
    .map(id => String(id || ''))
    .filter(Boolean);
  if (ids.length === 0) return Promise.resolve(0);
  const pin = normalizePin(passcode);
  if (!isValidPin(pin)) return Promise.resolve(0);
  const nextHint = hint === undefined || hint === null ? undefined : normalizeLockHint(hint);
  return securityMutation.enqueue(async () => {
    const current = await readSecurity();
    const characterLocks = { ...current.characterLocks };
    for (const id of ids) {
      // 先密码后提示、最后名单：中途崩溃也不会出现「名单里有锁但读不到密码」。
      await writeSecureValue(LOCK_SECURE_PREFIX + id, pin);
      if (nextHint !== undefined) {
        if (nextHint) await writeSecureValue(LOCK_HINT_SECURE_PREFIX + id, nextHint);
        else await removeSecureValue(LOCK_HINT_SECURE_PREFIX + id);
      }
      characterLocks[id] = true;
    }
    await writeSecurity({ ...current, characterLocks });
    return ids.length;
  });
}

// 密码提示（「写给自己的备忘」）：不需要密码即可查看——它的用途就是忘了密码时帮回忆。
// 所以它必须能在设置页直接点开；但内容可能暗含密码线索，所以与密码同为安全存储。
export function setCharacterLockHint(characterId, hint) {
  const id = String(characterId || '');
  if (!id) return Promise.resolve('');
  const value = normalizeLockHint(hint);
  return securityMutation.enqueue(async () => {
    if (value) await writeSecureValue(LOCK_HINT_SECURE_PREFIX + id, value);
    else await removeSecureValue(LOCK_HINT_SECURE_PREFIX + id);
    return value;
  });
}

export async function getCharacterLockHint(characterId) {
  const id = String(characterId || '');
  if (!id) return '';
  try {
    return normalizeLockHint(await readSecureValue(LOCK_HINT_SECURE_PREFIX + id));
  } catch (error) {
    return '';
  }
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
    // 提示随锁一起走：留一条「提示」却没有锁，只会让用户误以为有锁。
    await removeSecureValue(LOCK_HINT_SECURE_PREFIX + id);
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
    await removeSecureValue(LOCK_HINT_SECURE_PREFIX + id);
  }
  if (changed) await writeSecurity({ ...current, characterLocks });
}

// 角色删除时清理其锁与密码（谁的数据谁负责）。
onCharacterDeleted('security', deleteCharacterLocksInternal);

// 测试用：清空订阅者，避免用例间泄漏。
export function __resetSecurityListenersForTests() {
  securityListeners.clear();
}

export { LOCK_HINT_SECURE_PREFIX, LOCK_SECURE_PREFIX };
