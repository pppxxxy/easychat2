// 用户人设 / 全局资料存储领域。从 src/storage.js 原样外提（无行为变化）。
// USER_PROFILE_KEY 仍作为「全局资料」真实键：新结构下人设拆到 PERSONAS_KEY，avatarUri 留在该键。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, createMutationQueue, readJson, readJsonStatus } from './io.js';
import { tActive } from '../i18n/index.js';

// 供 barrel 的媒体清理函数判断损坏备份键时复用。
export const USER_PROFILE_KEY = '@easychat2_user_profile';
const PERSONAS_KEY = '@easychat2_personas';
const ACTIVE_PERSONA_KEY = '@easychat2_active_persona';

const DEFAULT_USER_PROFILE = { userName: '', persona: '', avatarUri: '' };
const DEFAULT_PERSONA_ID = 'default';

// 人设与全局资料的所有读-改-写走同一队列：create/delete/saveUserProfile/切活跃
// 都基于「重读当前列表再整表写回」，并发会互相覆盖。内部读helper保持不入队，
// 由队列任务直接调用，避免同队列重入死锁（与 moments/sessionCore 同构）。
const personasMutation = createMutationQueue();

function makePersonaId(now = Date.now()) {
  return `persona-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePersona(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const createdAt = Number(source.createdAt);
  const updatedAt = Number(source.updatedAt);
  return {
    id: String(source.id || '').trim() || makePersonaId(),
    userName: String(source.userName || ''),
    persona: String(source.persona || ''),
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

function readGlobalProfileMeta(rawProfile) {
  const source = rawProfile && typeof rawProfile === 'object' ? rawProfile : {};
  return {
    avatarUri: String(source.avatarUri || ''),
  };
}

// 写路径专用读：读失败（corrupt）时抛错中止，绝不用「合成出来的默认人设」整表覆盖。
// 变体①，参考 src/storage/worldMap.js:34-40（updateWorldMap）与
// src/storage/cardForge.js:182-186（saveCardForgeInternal）。
//
// 为什么必须守卫：getPersonas() 在损坏时返回的是一条**内存里合成**的默认人设
// （刻意不落盘，见那里的注释）。而 create/delete/saveUserProfile 全都是
// 「拿它当当前列表 → 改 → setItem(PERSONAS_KEY)」：读失败后任意一次保存
// 都会把用户全部人设替换成那一条合成结果——「下次可重试」的承诺当场作废。
async function getPersonasForMutation() {
  const stored = await readJsonStatus(PERSONAS_KEY);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(PERSONAS_KEY);
    throw new Error(tActive('error.storage.personasReadFailed'));
  }
  return getPersonas();
}

export async function getPersonas() {
  const stored = await readJsonStatus(PERSONAS_KEY);
  if (stored.status === 'ok' && Array.isArray(stored.value) && stored.value.length > 0) {
    return stored.value.map(normalizePersona);
  }
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    // 读不出就不落盘，更不能把其余人设覆盖成一条；返回默认值，下次可重试。
    await backupCorruptValue(PERSONAS_KEY);
    const now = Date.now();
    return [{ id: DEFAULT_PERSONA_ID, userName: '', persona: '', createdAt: now, updatedAt: now }];
  }
  // 走到这里 PERSONAS_KEY 是 missing（首次升级）或空数组（`[]` 会被上面的形状判据放行到
  // 这里，语义同样是「还没有人设」）——也只有这条路会做 legacy 迁移。
  //
  // 为什么这一步必须用 readJsonStatus 而不是 readJson：readJson 在 getItem 抛错或
  // JSON.parse 失败时**吞掉原错误**返回默认值，而下面的 setItem(PERSONAS_KEY, …) 会
  // 立刻把「迁移已完成」写死——此后 getPersonas 永远走上方的 ok 分支、迁移不再重跑，
  // 磁盘上完好的旧资料（USER_PROFILE_KEY）就永久不可达（除非用户手动改回存储）。
  // 判据与同一文件 getUserProfileStatus 对同一键的三态处理一致（复用同一份纪律）。
  const legacyStatus = await readJsonStatus(USER_PROFILE_KEY);
  if (
    legacyStatus.status === 'corrupt'
    || (legacyStatus.status === 'ok' && (
      legacyStatus.value === null
      || typeof legacyStatus.value !== 'object'
      || Array.isArray(legacyStatus.value)
    ))
  ) {
    // 先留原始副本再抛错中止迁移：**不写 PERSONAS_KEY**，迁移标记不落地 ⇒ 下次启动重试。
    // 变体①，参考 src/storage/worldMap.js:34-40（读失败就抛错中止，绝不用默认值覆盖）。
    await backupCorruptValue(USER_PROFILE_KEY);
    throw new Error(tActive('error.storage.personasMigrationReadFailed'));
  }
  const legacy = legacyStatus.status === 'ok' ? legacyStatus.value : DEFAULT_USER_PROFILE;
  const now = Date.now();
  const migrated = {
    id: DEFAULT_PERSONA_ID,
    userName: String(legacy?.userName || ''),
    persona: String(legacy?.persona || ''),
    createdAt: now,
    updatedAt: now,
  };
  await AsyncStorage.setItem(PERSONAS_KEY, JSON.stringify([migrated]));
  const active = await getActivePersonaIdStatus([migrated]);
  // corrupt：读不出「上次用的人设」就连指针一个字节都不写（裁定同
  // src/context/sessionLibrary.js:153-156 的 shouldPersistResolvedId：ok/missing 才写）。
  if (active.status !== 'corrupt') {
    if (!active.value) await AsyncStorage.setItem(ACTIVE_PERSONA_KEY, JSON.stringify(DEFAULT_PERSONA_ID));
    else if (active.value !== DEFAULT_PERSONA_ID) {
      await AsyncStorage.setItem(ACTIVE_PERSONA_KEY, JSON.stringify(migrated.id));
    }
  }
  return [migrated];
}

// 活动人设指针的**三态读取**，与 characters/index.js 的 getActiveCharacterIdStatus 完全同构、同理。
//
// 为什么必须有：原实现是裸 `getItem + JSON.parse + catch { stored = '' }`，读失败被折叠成
// 「没设过」，随后 `return personas[0].id`——这不只是把两种状态合并，而是**主动指向另一个人设**
//（会话/角色那两处指针读失败返回的是 ''，保守且不写回），而且该返回值会被写回盘上。
// 两条可复现路径：
//   路径 A（写错人设 = 数据丢失）：getUserProfile 此刻读到真实值（人设 B）→ UI 显示 B
//     → 用户敲一个字符 → 600ms 防抖 saveUserProfile 里**再读一次**指针恰好失败 → 回落人设 A
//     → personas.map 把 B 的 userName/persona 整段写进 A，且用户看不到任何提示。
//   路径 B（指针被永久改写）：deletePersona 读失败 → activeId = personas[0].id
//     → setItem(ACTIVE_PERSONA_KEY, …) ⇒ 一次瞬时读失败就把「上次用的人设」永久改成第一个人设。
// 所以 corrupt 时**不回落、不写回**，由调用方抛错中止。
// 裁定同 src/context/sessionLibrary.js:153-156：ok/missing 且解析结果确实变了才写，corrupt 一律不写。
export async function getActivePersonaIdStatus(list) {
  const personas = Array.isArray(list) ? list : await getPersonas();
  const stored = await readJsonStatus(ACTIVE_PERSONA_KEY);
  if (stored.status === 'corrupt') return { status: 'corrupt', stored: '', value: '' };
  const raw = stored.status === 'ok' && stored.value !== null && stored.value !== undefined
    ? String(stored.value)
    : '';
  // ok / missing：保持既有容错——从未设过、或值已不在列表里（人设被删过）→ 回落首个人设。
  const resolved = raw && personas.some(item => item.id === raw)
    ? raw
    : ((personas[0] && personas[0].id) || '');
  return { status: stored.status, stored: raw, value: resolved };
}

// 只读便捷包装：供展示路径（getUserProfile / settings/useUserProfile）继续按字符串使用。
// corrupt 时返回 ''（**不回落**）：回落成首个人设会让界面显示成「另一个人设的资料」，
// 而所有写路径已改走 getActivePersonaIdStatus 并在 corrupt 时中止。
export async function getActivePersonaId(list) {
  const { value } = await getActivePersonaIdStatus(list);
  return value;
}

async function setActivePersonaIdInternal(id) {
  const personas = await getPersonas();
  const target = personas.find(item => item.id === id);
  const resolved = target ? target.id : (personas[0] && personas[0].id) || '';
  await AsyncStorage.setItem(ACTIVE_PERSONA_KEY, JSON.stringify(resolved));
  return resolved;
}

export function setActivePersonaId(id) {
  return personasMutation.enqueue(() => setActivePersonaIdInternal(id));
}

export function createPersona(partial = {}) {
  return personasMutation.enqueue(async () => {
    const personas = await getPersonasForMutation();
    const now = Date.now();
    const created = normalizePersona({
      id: makePersonaId(now),
      userName: String(partial.userName || ''),
      persona: String(partial.persona || ''),
      createdAt: now,
      updatedAt: now,
    });
    const next = [...personas, created];
    await AsyncStorage.setItem(PERSONAS_KEY, JSON.stringify(next));
    await setActivePersonaIdInternal(created.id);
    return created;
  });
}

export function deletePersona(id) {
  return personasMutation.enqueue(async () => {
    const personas = await getPersonasForMutation();
    if (personas.length <= 1) throw new Error(tActive('error.storage.personaKeepOne'));
    const remaining = personas.filter(item => item.id !== id);
    if (remaining.length === personas.length) throw new Error(tActive('error.storage.personaNotFound'));
    // 指针**在写列表之前**读一次，且整段操作只读这一次（第二层：同一次操作内两次独立读取，
    // 中间失败即错位）。读到的值一直用到底，不再回头重读。
    const active = await getActivePersonaIdStatus(personas);
    await AsyncStorage.setItem(PERSONAS_KEY, JSON.stringify(remaining));
    // corrupt 时不猜：返回 ''（不知道上次用的人设），且下面一个字节都不写回。
    let resolved = active.value;
    if (active.status !== 'corrupt' && (!resolved || resolved === id)) {
      resolved = (remaining[0] && remaining[0].id) || '';
    }
    let activeIdPersisted = false;
    if (active.status === 'corrupt') {
      // 读不出「上次用的人设」→ 拒绝写回指针：否则一次瞬时读失败就把活跃人设永久改成
      // 第一个人设（见 getActivePersonaIdStatus 的路径 B）。先留原始副本，供人工恢复。
      await backupCorruptValue(ACTIVE_PERSONA_KEY);
    } else if (resolved && resolved !== active.stored) {
      // 裁定同 sessionLibrary.shouldPersistResolvedId：ok/missing 且解析结果**确实变了**才写。
      await AsyncStorage.setItem(ACTIVE_PERSONA_KEY, JSON.stringify(resolved));
      activeIdPersisted = true;
    }
    return { personas: remaining, activeId: resolved, activeIdPersisted };
  });
}

export async function getUserProfile() {
  const global = await readJson(USER_PROFILE_KEY, DEFAULT_USER_PROFILE);
  const meta = readGlobalProfileMeta(global);
  const personas = await getPersonas();
  const activeId = await getActivePersonaId(personas);
  const active = personas.find(item => item.id === activeId) || personas[0];
  return {
    userName: String(active?.userName || ''),
    persona: String(active?.persona || ''),
    avatarUri: meta.avatarUri,
  };
}

export async function getUserProfileStatus() {
  const stored = await readJsonStatus(USER_PROFILE_KEY);
  if (stored.status === 'missing') {
    return { status: 'missing', profile: { ...DEFAULT_USER_PROFILE, avatarUri: '' } };
  }
  if (
    stored.status !== 'ok'
    || !stored.value
    || typeof stored.value !== 'object'
    || Array.isArray(stored.value)
  ) {
    await backupCorruptValue(USER_PROFILE_KEY);
    return { status: 'corrupt', profile: null };
  }
  const meta = readGlobalProfileMeta(stored.value);
  const personas = await getPersonas();
  const activeId = await getActivePersonaId(personas);
  const active = personas.find(item => item.id === activeId) || personas[0];
  return {
    status: 'ok',
    profile: {
      userName: String(active?.userName || ''),
      persona: String(active?.persona || ''),
      avatarUri: String(meta.avatarUri || ''),
    },
  };
}

export function saveUserProfile(profile) {
  return personasMutation.enqueue(async () => {
    const personas = await getPersonasForMutation();
    // 两个键都在**写之前**先判定：读不出任一原值就整体中止，不做「写了一半」。
    // USER_PROFILE_KEY 这一处此前只备份就往下走，而下面构造的载荷是三个字段整表覆盖，
    // avatarUri 取自「读失败后的默认值 ''」——保存一次用户名就把用户头像静默清掉。
    // 变体①，参考 src/storage/worldMap.js:34-40。
    const profileStatus = await readJsonStatus(USER_PROFILE_KEY);
    // 形状判据（第四态：合法 JSON 但不是普通对象）与同文件 getUserProfileStatus 一致：
    // readJsonStatus 的 ok 只保证 JSON.parse 成功，null / 数组 / 原语同样返回 ok。
    if (
      profileStatus.status === 'corrupt'
      || (profileStatus.status === 'ok' && (
        profileStatus.value === null
        || typeof profileStatus.value !== 'object'
        || Array.isArray(profileStatus.value)
      ))
    ) {
      await backupCorruptValue(USER_PROFILE_KEY);
      throw new Error(tActive('error.storage.personasReadFailed'));
    }
    // 指针同样在写之前读**一次**，整段只读这一次（第二层：同一次操作两次读取，中间失败即错位）。
    // corrupt 就整体中止：此时回落会指向**另一个人设**，把当前人设的内容整段写进它
    //（见 getActivePersonaIdStatus 的路径 A），用户还看不到任何提示。
    const active = await getActivePersonaIdStatus(personas);
    if (active.status === 'corrupt') {
      await backupCorruptValue(ACTIVE_PERSONA_KEY);
      throw new Error(tActive('error.storage.personaActiveIdReadFailed'));
    }
    const now = Date.now();
    const next = personas.map(item => (
      item.id === active.value
        ? {
          ...item,
          userName: String(profile?.userName || ''),
          persona: String(profile?.persona || ''),
          updatedAt: now,
        }
        : item
    ));
    await AsyncStorage.setItem(PERSONAS_KEY, JSON.stringify(next));
    const meta = readGlobalProfileMeta(
      profileStatus.status === 'ok' ? profileStatus.value : DEFAULT_USER_PROFILE
    );
    await AsyncStorage.setItem(
      USER_PROFILE_KEY,
      JSON.stringify({
        userName: String(profile?.userName || ''),
        persona: String(profile?.persona || ''),
        avatarUri: String(profile?.avatarUri ?? meta.avatarUri ?? ''),
      })
    );
  });
}