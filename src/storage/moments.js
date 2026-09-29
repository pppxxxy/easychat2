// 动态（朋友圈）与互动（定时主动消息）存储领域。从 src/storage.js 原样外提（无行为变化）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  removeMomentsForCharacterDeletion,
  removeMomentsBySessionIds,
} from '../moments/moments.js';
import { backupCorruptValue, readJson, readJsonStatus } from './io.js';

// 供 barrel 的媒体清理函数判断损坏备份键时复用。
export const MOMENTS_KEY = '@easychat2_moments';
const MOMENTS_SETTINGS_KEY = '@easychat2_moments_settings';
const PROACTIVE_SETTINGS_KEY = '@easychat2_proactive_settings';

let momentsMutationQueue = Promise.resolve();

function enqueueMomentsMutation(task) {
  const next = momentsMutationQueue.then(task, task);
  momentsMutationQueue = next.catch(() => {});
  return next;
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

export function makeProactiveSlotId() {
  return `slot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeProactiveSlot(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const hourValue = Math.trunc(Number(source.hour));
  const minuteValue = Math.trunc(Number(source.minute));
  const hour = Number.isFinite(hourValue) && hourValue >= 0 && hourValue <= 23 ? hourValue : 8;
  const minute = Number.isFinite(minuteValue) && minuteValue >= 0 && minuteValue <= 59 ? minuteValue : 0;
  const roleId = String(source.roleId || '');
  return {
    slotId: String(source.slotId || `slot-${index}-${roleId}-${hour}-${minute}`),
    roleId,
    roleName: String(source.roleName || ''),
    persona: String(source.persona || ''),
    hour,
    minute,
    mode: PROACTIVE_MODES.includes(source.mode) ? source.mode : 'WORK',
    enabled: source.enabled !== false,
    apiConfigId: String(source.apiConfigId || ''),
    model: String(source.model || ''),
    revision: String(source.revision || ''),
    messageType: PROACTIVE_MESSAGE_TYPES.includes(source.messageType)
      ? source.messageType
      : 'DEFAULT',
    customPrompt: String(source.customPrompt || ''),
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

export async function getProactiveSettings() {
  const stored = await readJsonStatus(PROACTIVE_SETTINGS_KEY);
  if (stored.status === 'corrupt') {
    // 与其它集合一致：损坏先备份，不静默覆盖用户的时间设置
    await backupCorruptValue(PROACTIVE_SETTINGS_KEY);
    return { slots: [], apiConfigId: '', model: '' };
  }
  return normalizeProactiveSettings(stored.status === 'ok' ? stored.value : null);
}

export async function saveProactiveSettings(settings) {
  const normalized = normalizeProactiveSettings(settings);
  await AsyncStorage.setItem(PROACTIVE_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
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

export async function getMoments() {
  const { moments } = await getMomentsStatus();
  return moments;
}

async function readMomentsForMutation() {
  const { status, moments } = await getMomentsStatus();
  if (status === 'corrupt') {
    throw new Error('动态记录读取失败，请稍后重试');
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