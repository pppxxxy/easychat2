// 动态（朋友圈）与互动（定时主动消息）存储领域。从 src/storage.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';
import { onCharacterDeleted } from './characterLifecycle.js';

import {
  removeMomentsForCharacterDeletion,
  removeMomentsBySessionIds,
} from '../moments/moments.js';
import { backupCorruptValue, createMutationQueue, readJson, readJsonStatus } from './io.js';
import { tActive } from '../i18n/index.js';

// 供 barrel 的媒体清理函数判断损坏备份键时复用。
export const MOMENTS_KEY = '@easychat2_moments';
const MOMENTS_SETTINGS_KEY = '@easychat2_moments_settings';
const PROACTIVE_SETTINGS_KEY = '@easychat2_proactive_settings';

const momentsMutation = createMutationQueue();

function enqueueMomentsMutation(task) {
  return momentsMutation.enqueue(task);
}

function normalizeMomentsSettings(raw) {
  if (raw === null || raw === undefined) return { enabled: true };
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { enabled: source.enabled !== false };
}

export async function getMomentsSettings() {
  const raw = await readJson(MOMENTS_SETTINGS_KEY, null);
  return normalizeMomentsSettings(raw);
}

export async function saveMomentsSettings(settings) {
  const normalized = normalizeMomentsSettings(settings);
  await AsyncStorage.setItem(MOMENTS_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

// 互动（定时主动消息）：每个角色可有多个时间槽，槽的唯一标识是 slotId。
// 这里只负责 JS 侧的展示与编辑数据；原生侧另存一份供后台发送使用。
export const PROACTIVE_MODES = ['WORK', 'EXACT'];

// 主动消息类型：默认 / 关心心情 / 问好（按时段自动选早/中/晚）/ 自定义提示词。
export const PROACTIVE_MESSAGE_TYPES = ['DEFAULT', 'CARE', 'GREETING', 'CUSTOM'];

// 随机时段：0 = 固定时刻（旧行为，在 hour:minute 准点发）；
// >0 = 在起始时刻之后的 N 分钟内随机挑一个时刻发送。上限 12 小时——
// 再长就等于「当天随便什么时候」，反而不好预期。
export const PROACTIVE_WINDOW_MAX_MINUTES = 720;

export function makeProactiveSlotId() {
  return `slot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 权重只接受正数；非法/非正一律当 0（= 不参与抽取）。
function normalizeWeight(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(num, 1000);
}

export function normalizeProactiveWindowMinutes(value) {
  const num = Math.trunc(Number(value));
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.min(num, PROACTIVE_WINDOW_MAX_MINUTES);
}

// 风格权重表 → [{ messageType, customPrompt, weight }]。
// **正权重之和恒为 1**（「加起来的是一」这条约束的唯一事实源就在这里：界面收原始相对
// 权重，存进存储的永远是比例）。0 权重的条目**保留**——用户把某条调到 0 只是暂时停用，
// 不该顺手抹掉他填过的自定义提示词；抽取时（原生与 buildProactiveVariants）只认正权重。
// 同一 messageType 只留第一条；全部为 0 时把第一条提升为权重 1——
// 否则「一条都不发」这种配置会让原生侧无风格可选。
export function normalizeProactiveStyles(raw, fallback = {}) {
  const source = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const entries = [];
  for (const item of source) {
    const src = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const messageType = PROACTIVE_MESSAGE_TYPES.includes(src.messageType) ? src.messageType : 'DEFAULT';
    if (seen.has(messageType)) continue;
    seen.add(messageType);
    entries.push({
      messageType,
      customPrompt: String(src.customPrompt || ''),
      weight: normalizeWeight(src.weight),
    });
  }
  if (entries.length === 0) {
    entries.push({
      messageType: PROACTIVE_MESSAGE_TYPES.includes(fallback.messageType) ? fallback.messageType : 'DEFAULT',
      customPrompt: String(fallback.customPrompt || ''),
      weight: 1,
    });
  }
  const total = entries.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return [{ ...entries[0], weight: 1 }];
  // 保留 6 位小数：够精确保存比例，又不让 JSON 里拖出一长串浮点尾巴。
  return entries.map(item => ({
    ...item,
    weight: item.weight > 0 ? Math.round((item.weight / total) * 1e6) / 1e6 : 0,
  }));
}

function normalizeProactiveSlot(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const hourValue = Math.trunc(Number(source.hour));
  const minuteValue = Math.trunc(Number(source.minute));
  const hour = Number.isFinite(hourValue) && hourValue >= 0 && hourValue <= 23 ? hourValue : 8;
  const minute = Number.isFinite(minuteValue) && minuteValue >= 0 && minuteValue <= 59 ? minuteValue : 0;
  const roleId = String(source.roleId || '');
  // 风格权重表是唯一事实源；旧数据只有 messageType/customPrompt 时按单条权重 1 补上。
  const styles = normalizeProactiveStyles(source.styles, {
    messageType: PROACTIVE_MESSAGE_TYPES.includes(source.messageType) ? source.messageType : 'DEFAULT',
    customPrompt: String(source.customPrompt || ''),
  });
  // 兼容镜像取「第一条**启用**的风格」：原生只在 variants 缺失时用它兜底，
  // 镜像到一个权重 0 的停用风格会让兜底文案与用户实际启用的风格不符。
  const primary = styles.find(item => item.weight > 0) || styles[0];
  return {
    slotId: String(source.slotId || `slot-${index}-${roleId}-${hour}-${minute}`),
    roleId,
    roleName: String(source.roleName || ''),
    persona: String(source.persona || ''),
    hour,
    minute,
    // 随机时段长度（分钟）。0 = 准点发。
    windowMinutes: normalizeProactiveWindowMinutes(source.windowMinutes),
    mode: PROACTIVE_MODES.includes(source.mode) ? source.mode : 'WORK',
    enabled: source.enabled !== false,
    apiConfigId: String(source.apiConfigId || ''),
    model: String(source.model || ''),
    revision: String(source.revision || ''),
    styles,
    // 兼容镜像：保留主风格的两个旧字段。旧读侧与「原生在 variants 缺失时的兜底文案」
    // 仍按这两个字段取值；界面已改为直接读写 styles。
    messageType: primary.messageType,
    customPrompt: primary.customPrompt,
    // 指定衔接的历史对话 id；空串表示「新建对话」。首次触发新建后由落库逻辑回填为新建的会话 id，
    // 之后该槽固定复用这一段；会话被删则视为空串，下次触发再新建并重新绑定。
    sessionTargetId: String(source.sessionTargetId || ''),
  };
}

function normalizeProactiveSettings(raw) {
  if (raw === null || raw === undefined) return { slots: [], apiConfigId: '', model: '' };
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const slots = Array.isArray(source.slots)
    ? source.slots
      .map((item, index) => normalizeProactiveSlot(item, index))
      .filter(item => item.roleId)
    : [];
  return {
    slots,
    // 互动复用一个 API 配置与模型，从设置页已有配置里选，避免二次填写密钥
    apiConfigId: String(source.apiConfigId || ''),
    model: String(source.model || ''),
  };
}

// 读主动消息设置并**保留读取状态**（读路径对外行为不变：损坏时仍给空设置，面板不崩）。
// 参考 src/storage/worldMap.js:19-27（getWorldMapStatus）。
async function readProactiveSettingsStatus() {
  const stored = await readJsonStatus(PROACTIVE_SETTINGS_KEY);
  if (stored.status === 'corrupt') {
    // 与其它集合一致：损坏先备份，不静默覆盖用户的时间设置
    await backupCorruptValue(PROACTIVE_SETTINGS_KEY);
    return { status: 'corrupt', settings: { slots: [], apiConfigId: '', model: '' } };
  }
  return {
    status: stored.status === 'ok' ? 'ok' : 'missing',
    settings: normalizeProactiveSettings(stored.status === 'ok' ? stored.value : null),
  };
}

export async function getProactiveSettings() {
  return (await readProactiveSettingsStatus()).settings;
}

// 写路径守卫（变体①：拒绝写回 / 抛错）。
// 参考 src/storage/worldMap.js:34-40（updateWorldMap）与 src/storage/cardForge.js:182-186。
//
// 为什么必须守卫：被抹掉的是**每个角色的时段、人格、自定义提示词**——用户手填的昂贵配置。
// 读失败时「当前设置」是 `{ slots: [] }`，整键写回即全清。
function requireProactiveSettingsForMutation(current) {
  if (current.status === 'corrupt') {
    throw new Error(tActive('error.storage.proactiveSettingsReadFailed'));
  }
  return current.settings;
}

export function saveProactiveSettings(settings) {
  // **必须入队**：bindProactiveSlotSession 写的是同一个键，且在队列里做读-改-写。
  // 这条写入若绕过队列，就会插到「它读完、还没写」的中间——两边都基于旧快照，
  // 后落盘的那次把对方刚提交的改动整个覆盖掉（后发起的调用不再生效）。
  return enqueueMomentsMutation(async () => {
    // 变体①：读失败就抛错中止，绝不用空时段整键覆盖（参考实现同上）。
    requireProactiveSettingsForMutation(await readProactiveSettingsStatus());
    const normalized = normalizeProactiveSettings(settings);
    await AsyncStorage.setItem(PROACTIVE_SETTINGS_KEY, JSON.stringify(normalized));
    return normalized;
  });
}

// 主动消息落库时把「新建对话」的槽绑定到实际写入的会话 id：重读当前设置后仅改该槽，
// 避免用旧的整表覆盖用户在面板上的其它编辑。返回是否命中该槽。
export function bindProactiveSlotSession(slotId, sessionId) {
  const target = String(slotId || '');
  const bound = String(sessionId || '');
  if (!target || !bound) return Promise.resolve(false);
  return enqueueMomentsMutation(async () => {
    // 同样是读-改-写整键覆盖，同样走守卫（变体①）。此前只是**侥幸**躲过覆盖：
    // 损坏时 slots 为空、匹配不到目标槽 → 提前 return false。但那是巧合而非判据——
    // normalizeProactiveSlot 会按 `slot-<index>-<roleId>-<h>-<m>` 派生 id，
    // 一旦派生出同 id 的槽就会命中，把整表写成「只有这一个槽」。显式拒绝才可靠。
    const stored = requireProactiveSettingsForMutation(await readProactiveSettingsStatus());
    let hit = false;
    const slots = stored.slots.map(slot => {
      if (slot.slotId !== target || slot.sessionTargetId === bound) return slot;
      hit = true;
      return { ...slot, sessionTargetId: bound };
    });
    if (!hit) return false;
    await AsyncStorage.setItem(PROACTIVE_SETTINGS_KEY, JSON.stringify({ ...stored, slots }));
    return true;
  });
}

function normalizeMoment(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const likes = Array.isArray(source.likes) ? source.likes.filter(item => item && typeof item === 'object') : [];
  const comments = Array.isArray(source.comments)
    ? source.comments.filter(item => item && typeof item === 'object')
    : [];
  const characterId = String(source.characterId || '');
  return {
    id: String(source.id || ''),
    // 用户自发布动态（characterId 为空）标记为 user，其余为角色动态；老数据无该字段。
    authorType: source.authorType === 'user' || !characterId ? 'user' : 'character',
    characterId,
    characterName: String(source.characterName || ''),
    avatarUri: String(source.avatarUri || ''),
    // 这条动态是从哪段对话（记忆）里来的：评论回复会依据它对应的记忆来生成。
    // 老数据没有这个字段，按空串处理（回复时退化为只用角色设定 + 动态本身）。
    sessionId: String(source.sessionId || ''),
    trigger: String(source.trigger || ''),
    text: String(source.text || ''),
    createdAt: Number(source.createdAt) || 0,
    likedByUser: source.likedByUser === true,
    likes,
    comments,
  };
}

export async function getMomentsStatus() {
  const stored = await readJsonStatus(MOMENTS_KEY);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    // 动态此前没有任何损坏保护：读失败被当成空列表，写回时就把整表清掉。先备份再拒绝覆盖。
    await backupCorruptValue(MOMENTS_KEY);
    return { status: 'corrupt', moments: [] };
  }
  if (stored.status === 'missing') return { status: 'missing', moments: [] };
  const moments = stored.value
    .map(normalizeMoment)
    .filter(item => item.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  return { status: 'ok', moments };
}

// 变体①：读失败就抛错，不再把「读不出来」伪装成「一条动态都没有」。
// 参考 src/storage/worldMap.js:34-40（updateWorldMap「读失败就抛错中止」）。
//
// 同文件的 readMomentsForMutation 一直是这个纪律，getMomentsStatus 也一直把 status 带出来，
// 只有 getMoments 把 status 丢掉、corrupt 时直接返回 []——于是调用方无从区分
// 「没有动态」与「动态读不出来」（MomentsView.js:114 会 setMoments([])）。
// **要状态请走 getMomentsStatus()（本文件里正确的那道门）**；只想要列表的调用方
// 必须显式处理失败。现有 4 个调用点都已经带 .catch（MomentsView.js:121/374、
// runUserMomentComments.js:43、runHousemateReactions.js:38），所以这不改变任何
// 用户可见行为，只把契约从「静默空列表」改成「显式失败」。
export async function getMoments() {
  const { status, moments } = await getMomentsStatus();
  if (status === 'corrupt') {
    throw new Error(tActive('error.storage.momentsReadFailed'));
  }
  return moments;
}

async function readMomentsForMutation() {
  const { status, moments } = await getMomentsStatus();
  if (status === 'corrupt') {
    throw new Error(tActive('error.storage.momentsReadFailed'));
  }
  return moments;
}

async function saveMomentsInternal(moments) {
  const list = Array.isArray(moments) ? moments.map(normalizeMoment).filter(item => item.id) : [];
  await AsyncStorage.setItem(MOMENTS_KEY, JSON.stringify(list));
  return list;
}

export function saveMoments(moments) {
  return enqueueMomentsMutation(async () => {
    await readMomentsForMutation();
    return saveMomentsInternal(moments);
  });
}

export function updateMoments(updater) {
  return enqueueMomentsMutation(async () => {
    const current = await readMomentsForMutation();
    const next = typeof updater === 'function' ? await updater(current) : current;
    if (next === undefined) return current;
    return saveMomentsInternal(next);
  });
}

// 删除锚定在这些会话（记忆）上的动态。返回被删除的动态 id，便于调用方提示结果。
export async function deleteMomentsBySessionIds(sessionIds) {
  const ids = (Array.isArray(sessionIds) ? sessionIds : [])
    .map(item => String(item || ''))
    .filter(Boolean);
  if (ids.length === 0) return [];
  let removedIds = [];
  await updateMoments(list => {
    removedIds = list
      .filter(item => ids.includes(String(item.sessionId || '')))
      .map(item => item.id);
    return removedIds.length > 0 ? removeMomentsBySessionIds(list, ids) : list;
  });
  return removedIds;
}

export async function deleteMomentsForCharacterDeletion(characterIds, sessionIds = []) {
  let removedIds = [];
  await updateMoments(moments => {
    const next = removeMomentsForCharacterDeletion(moments, characterIds, sessionIds);
    removedIds = moments
      .filter(item => !next.includes(item))
      .map(item => String(item && item.id || ''))
      .filter(Boolean);
    return removedIds.length > 0 ? next : moments;
  });
  return removedIds;
}

// 删除角色时清掉它的动态（原散落在 CharacterScreen 的删除流程里，门面级联不知道它存在）。
// 会话维度的动态由 removeMomentsBySessionIds 覆盖，这里只按角色 id 兜底。
onCharacterDeleted('moments', characterIds => deleteMomentsForCharacterDeletion(characterIds));
