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
  const legacy = await readJson(USER_PROFILE_KEY, DEFAULT_USER_PROFILE);
  const now = Date.now();
  const migrated = {
    id: DEFAULT_PERSONA_ID,
    userName: String(legacy?.userName || ''),
    persona: String(legacy?.persona || ''),
    createdAt: now,
    updatedAt: now,
  };
  await AsyncStorage.setItem(PERSONAS_KEY, JSON.stringify([migrated]));
  const activeId = await getActivePersonaId([migrated]);
  if (!activeId) await AsyncStorage.setItem(ACTIVE_PERSONA_KEY, JSON.stringify(DEFAULT_PERSONA_ID));
  else if (activeId !== DEFAULT_PERSONA_ID) {
    await AsyncStorage.setItem(ACTIVE_PERSONA_KEY, JSON.stringify(migrated.id));
  }
  return [migrated];
}

export async function getActivePersonaId(list) {
  const personas = Array.isArray(list) ? list : await getPersonas();
  if (personas.length === 0) return '';
  let stored = '';
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_PERSONA_KEY);
    stored = raw ? String(JSON.parse(raw)) : '';
  } catch (error) {
    stored = '';
  }
  if (stored && personas.some(item => item.id === stored)) return stored;
  return personas[0].id;
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
    await AsyncStorage.setItem(PERSONAS_KEY, JSON.stringify(remaining));
    const activeId = await getActivePersonaId(personas);
    const resolved = activeId === id ? remaining[0].id : activeId;
    await AsyncStorage.setItem(ACTIVE_PERSONA_KEY, JSON.stringify(resolved));
    return { personas: remaining, activeId: resolved };
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
    if (profileStatus.status === 'corrupt') {
      await backupCorruptValue(USER_PROFILE_KEY);
      throw new Error(tActive('error.storage.personasReadFailed'));
    }
    const activeId = await getActivePersonaId(personas);
    const now = Date.now();
    const next = personas.map(item => (
      item.id === activeId
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