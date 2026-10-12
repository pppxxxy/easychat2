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
import { tActive } from '../i18n/index.js';

export const SECURITY_KEY = '@easychat2_security';
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;
// 密码提示的长度上限：提示是「帮自己回忆」的一句话，不需要更长；
// 限长也顺便挡住把完整密码写进提示这类自掘坑（写不进去总比写进去好）。
export const LOCK_HINT_MAX_LENGTH = 120;

// 读取状态**三态**（照抄先例 src/chat/proactiveMessage.js:21-40 的 true/false/null
// 与 src/workspace/conversation.js:118-125 的 'unknown'：**不假装成功也不假装失败**）：
//   ok      读到且结构完好；
//   missing 键不存在——全新安装，「没有锁」是事实而不是猜测；
//   unknown 读取抛错或 JSON 结构损坏——**我们不知道有没有锁**。
//
// 为什么必须把 unknown 显式带出来：读损坏时本模块已经调过 backupCorruptValue
// （原始值保住了），但旧实现把返回值折叠成「默认 = 未加锁」，SecurityGate 据此判定
// 「不需要解锁」——于是「数据留了副本、保护却被丢弃」。未知必须能被调用方看见，
// 而不是被默认值抹平。
export const SECURITY_STATUS = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',
  UNKNOWN: 'unknown',
});

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

// 读设置并**保留读取状态**。读路径的体验完全不变（损坏时仍返回默认值给 UI），
// status 交给调用方判定「这次算不算知道有没有锁」。
// 参考 src/storage/worldMap.js:19-27（getWorldMapStatus）：把 status 从读函数里带出来，
// 而不是在读函数里就把状态丢掉、让调用方只能拿到一个「看起来正常的默认值」。
// 读损坏归入 SECURITY_STATUS.UNKNOWN（不是 ok/missing）——见文件头 SECURITY_STATUS 的说明。
async function readSecurity() {
  const stored = await readJsonStatus(SECURITY_KEY);
  if (stored.status === 'corrupt') {
    await backupCorruptValue(SECURITY_KEY);
    return {
      status: SECURITY_STATUS.UNKNOWN,
      appLock: normalizeAppLock(null),
      characterLocks: {},
    };
  }
  // 「合法 JSON 但形状不是预期对象」是真实存在的**第四态**：readJsonStatus 只保证
  // JSON.parse 成功（status === 'ok'），**不保证值是我们约定的对象**——null、字符串、
  // 数字、数组都会走到这里。旧实现只筛 `typeof === 'object'`（漏掉 Array.isArray），
  // 却在下一行把 `stored.status === 'ok'` **无条件**翻译成 SECURITY_STATUS.OK：
  // 形状被丢弃、状态却仍宣称「完好」⇒ getSecuritySettings 把 OK 交给 SecurityGate，
  // resolveAppLockPolicy 得出 requireUnlock: false ⇒ **用户以为锁着，实际直接进入**，
  // 且 characterLocks = {} ⇒ 全部角色锁名单一并消失。
  //
  // 这正是本文件 :35-38 判据宣判为缺陷的那件事（「未知必须能被调用方看见，而不是被
  // 默认值抹平」），只是触发条件从「非法 JSON」缩小到了「合法 JSON 但形状不对」；
  // :150-154 也写明名单被整键覆盖的后果是**锁静默失效**而非「少一条记录」。
  //
  // 先例（同仓已确立的正确写法，本模块是唯一「声明了 unknown 态却漏判形状」的）：
  // src/storage/settings/tts.js:52 与 :107、globalPresets.js:90、
  // src/storage/settings/characters/index.js:64,70 都显式判
  // `value === null || typeof value !== 'object' || Array.isArray(value)` 并归入 corrupt。
  const shapeOk = stored.status === 'ok' && stored.value
    && typeof stored.value === 'object' && !Array.isArray(stored.value);
  if (stored.status === 'ok' && !shapeOk) {
    await backupCorruptValue(SECURITY_KEY);
    // 返回形状与上面的 corrupt 分支**逐字一致**（不引入第三种形状）：
    // 归入 UNKNOWN 后由 resolveAppLockPolicy 走 fail-closed（requireUnlock: true）。
    return {
      status: SECURITY_STATUS.UNKNOWN,
      appLock: normalizeAppLock(null),
      characterLocks: {},
    };
  }
  const raw = shapeOk ? stored.value : {};
  return {
    status: stored.status === 'ok' ? SECURITY_STATUS.OK : SECURITY_STATUS.MISSING,
    appLock: normalizeAppLock(raw.appLock),
    characterLocks: normalizeCharacterLocks(raw.characterLocks),
  };
}

// 纯函数：把「读取状态 + 应用锁设置」压成 SecurityGate 要用的**保守策略**。
//
// 为什么单独抽成纯函数：三态里的「未知」必须由**策略**决定，而不是散落在调用点的
// if 里——旧实现的缺陷形态正是「未知」在某处被悄悄折叠回「未加锁」。抽出来之后
// 「未知 ⇒ 要求验证」这条判据可以在 Node 里直接断言（tests/securityStorage.test.mjs）。
//
// unknown：读损坏/读抛错。UI 据此显示「状态未知」而**不是**「未加锁」。
// requireUnlock：未知时按「已开启」处理——宁可多要一次验证（生物识别/系统密码），
//   也绝不静默放行。这与本模块写路径的 fail-closed 守卫
//   （requireSecurityForMutation，见下方注释）方向一致：安全配置域一律往严的一侧倒。
export function resolveAppLockPolicy(status, appLock) {
  const unknown = status === SECURITY_STATUS.UNKNOWN;
  return {
    unknown,
    requireUnlock: unknown || (!!appLock && appLock.enabled === true),
    // 与 normalizeAppLock 同一缺省：只有显式写入 false 才关闭自动重新上锁。
    // 未知态一律回到「开启」：连 enabled 都读不出来时，relockOnBackground 同样不可信。
    relockOnBackground: unknown || !appLock || appLock.relockOnBackground !== false,
  };
}

// 写路径守卫（变体①：拒绝写回 / 抛错）。
// 参考 src/storage/worldMap.js:34-40（updateWorldMap）：「读失败就抛错中止：绝不用空列表
// 覆盖已有地图」；同型见 src/storage/cardForge.js:182-186（saveCardForgeInternal）。
//
// 为什么本域**必须** fail-closed（这是安全配置域）：密码/提示在 expo-secure-store，
// 上锁名单只在 AsyncStorage。名单一旦被「默认值 + 本次补丁」整键覆盖，结果不是
// 「少了一条记录」而是**锁静默失效**——密码还躺在安全存储里，但没有任何角色被登记为
// 已上锁，SecurityGate 再也不会拦人。用户以为锁着，实际谁都能打开。
// 宁可这次保存失败并明确报错，也绝不悄悄解锁。
function requireSecurityForMutation(current) {
  if (current.status === SECURITY_STATUS.UNKNOWN) {
    throw new Error(tActive('error.storage.securityReadFailed'));
  }
  return current;
}

// 落盘载荷：只取数据字段，绝不把 status 写进存储（否则下次读出来会多一个无意义字段）。
function securityPayload(current) {
  return { appLock: current.appLock, characterLocks: current.characterLocks };
}

async function writeSecurity(next) {
  await AsyncStorage.setItem(SECURITY_KEY, JSON.stringify(next));
  notifySecurityChanged();
  return next;
}

// 对外形状：{ status, appLock, characterLocks }。
// status **必须外泄**——SecurityGate 要据它区分「未知」与「未加锁」（本次修复的核心）。
// 其余读取入口（getAppLockSettings / getCharacterLocks）保持「只回值」的形状，供设置页
// 回显；设置页要显示「状态未知」得另开入口，不在本次改动范围内（写路径已有守卫，
// 损坏时任何保存都会被 requireSecurityForMutation 拒绝，不会把名单冲成默认值）。
export async function getSecuritySettings() {
  const { status, appLock, characterLocks } = await readSecurity();
  return { status, appLock, characterLocks };
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
    const current = requireSecurityForMutation(await readSecurity());
    const appLock = normalizeAppLock({
      ...current.appLock,
      ...(patch && typeof patch === 'object' ? patch : {}),
    });
    await writeSecurity({ ...securityPayload(current), appLock });
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
    // 守卫必须在写安全存储**之前**：读不出名单时连密码都不该落盘，
    // 否则会留下「密码在、名单里没有」的孤儿——与下面注释里「先密码后名单」的
    // 顺序纪律同一个目的：任何中途状态都不能出现「有锁却查不到」或反过来。
    const current = requireSecurityForMutation(await readSecurity());
    await writeSecureValue(LOCK_SECURE_PREFIX + id, pin);
    const characterLocks = { ...current.characterLocks, [id]: true };
    await writeSecurity({ ...securityPayload(current), characterLocks });
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
    // 同 setCharacterLock：守卫在最前，名单读不出就一个密码都不写。
    const current = requireSecurityForMutation(await readSecurity());
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
    await writeSecurity({ ...securityPayload(current), characterLocks });
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
    // 解锁同样要守卫：写回的是 `{...current.characterLocks}`，读失败时它是空的，
    // 一写就把**整份**名单清空（不只是这一个角色）。删除永远是可推迟的
    // （参考 src/storage/mediaProtection.js:47 的方向选择），这次失败下次再删即可。
    const current = requireSecurityForMutation(await readSecurity());
    const wasLocked = current.characterLocks[id] === true;
    const characterLocks = { ...current.characterLocks };
    delete characterLocks[id];
    await removeSecureValue(LOCK_SECURE_PREFIX + id);
    // 提示随锁一起走：留一条「提示」却没有锁，只会让用户误以为有锁。
    await removeSecureValue(LOCK_HINT_SECURE_PREFIX + id);
    if (wasLocked) await writeSecurity({ ...securityPayload(current), characterLocks });
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

function deleteCharacterLocksInternal(characterIds) {
  const ids = (Array.isArray(characterIds) ? characterIds : [])
    .map(id => String(id || ''))
    .filter(Boolean);
  if (ids.length === 0) return Promise.resolve();
  // 入队串行：与 saveAppLockSettings / setCharacterLock 并发时，不在同一队列里做读-改-写
  // 会互相整表覆盖（复活已删角色的锁或丢掉新锁）。
  return securityMutation.enqueue(async () => {
    // 队列内 fail-closed（同本文件其余写入路径）：读不出名单就没有「安全的部分写入」可言
    // ——先删密码再发现名单写不回去，只会得到「名单说锁着、密码已没」的坏状态。
    // 抛错由 characterLifecycle.runCharacterCleanup 记诊断后继续跑其余域；这次没清掉的
    // 密码/提示留到下次清理（留孤儿是可恢复的，抹掉整份名单不是）。
    const current = requireSecurityForMutation(await readSecurity());
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
    if (changed) await writeSecurity({ ...securityPayload(current), characterLocks });
  });
}

// 角色删除时清理其锁与密码（谁的数据谁负责）。
onCharacterDeleted('security', deleteCharacterLocksInternal);

// 测试用：清空订阅者，避免用例间泄漏。
export function __resetSecurityListenersForTests() {
  securityListeners.clear();
}

export { LOCK_HINT_SECURE_PREFIX, LOCK_SECURE_PREFIX };
