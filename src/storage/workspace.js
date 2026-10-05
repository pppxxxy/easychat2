// 工作区设置存储域：模式（ask/read/write）、根位置、命令执行开关与工作区角色
// 持久化在单一键下。从 storage 门面转发；归一化在 src/workspace/settings.js（纯函数）。
//
// 另设一个独立键存「工作区改动历史」：每次经后端写入/编辑/删除文件追加一条
// （写入点唯一——native.js 给 createWorkspaceStore 包记录装饰器，面板与聊天工具
// 共用同一路径）。按角色分区，每角色上限 200 条（新的在前），分区上限 50 个角色。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizeWorkspaceSettings } from '../workspace/settings.js';
import { createMutationQueue, readJson } from './io.js';

export const WORKSPACE_KEY = '@easychat2_workspace';
export const WORKSPACE_CHANGES_KEY = '@easychat2_workspace_changes';
export const WORKSPACE_CHANGE_LIMIT = 200;
const WORKSPACE_CHANGE_CHARACTER_LIMIT = 50;

const workspaceChangesMutation = createMutationQueue();

export async function getWorkspaceSettings() {
  const raw = await readJson(WORKSPACE_KEY, null);
  return normalizeWorkspaceSettings(raw);
}

export async function saveWorkspaceSettings(settings) {
  const normalized = normalizeWorkspaceSettings(settings);
  await AsyncStorage.setItem(WORKSPACE_KEY, JSON.stringify(normalized));
  return normalized;
}

// 局部更新：读现值 → 合并补丁 → 归一化写回。
//
// 存在的理由与 patchAppearanceSettings 相同：本键现在同时承载模式、根位置
// 与命令执行开关，而它们由不同界面分别修改。若各自调用 saveWorkspaceSettings
// 且只带自己的字段，归一化会把其余字段打回默认——表现为「改模式把已选文件夹
// 和 bash 开关静默清掉了」。所有写入方都应走这个函数。
export async function patchWorkspaceSettings(patch) {
  const current = await getWorkspaceSettings();
  const merged = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
  const normalized = normalizeWorkspaceSettings(merged);
  await AsyncStorage.setItem(WORKSPACE_KEY, JSON.stringify(normalized));
  return normalized;
}

// ---- 工作区改动历史 ----

function truncate(value, max) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function normalizeWorkspaceChange(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: String(source.id || `chg-${Math.random().toString(36).slice(2, 10)}`),
    at: Math.max(0, Math.floor(Number(source.at)) || 0),
    op: ['write', 'edit', 'delete'].includes(source.op) ? source.op : 'write',
    path: truncate(source.path, 200),
    created: source.created === true,
    length: Math.max(0, Math.floor(Number(source.length)) || 0),
    base64Length: Math.max(0, Math.floor(Number(source.base64Length)) || 0),
    count: Math.max(0, Math.floor(Number(source.count)) || 0),
    all: source.all === true,
    find: truncate(source.find, 160),
    replace: truncate(source.replace, 160),
  };
}

function normalizeChangesStore(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  Object.entries(source).forEach(([characterId, list]) => {
    const key = String(characterId || '').trim();
    if (!key || !Array.isArray(list)) return;
    out[key] = list.map(normalizeWorkspaceChange).slice(0, WORKSPACE_CHANGE_LIMIT);
  });
  return out;
}

export async function getWorkspaceChanges(characterId) {
  const raw = await readJson(WORKSPACE_CHANGES_KEY, null);
  const store = normalizeChangesStore(raw);
  return store[String(characterId || '').trim()] || [];
}

// 追加一条改动（新的在前）。历史写失败绝不能影响文件操作本身——调用方
// （history.js 装饰器）会吞掉这里的异常，这里保持「要么写成功要么抛」的直白语义。
export function appendWorkspaceChange(characterId, entry) {
  const key = String(characterId || '').trim();
  if (!key) return Promise.resolve(null);
  return workspaceChangesMutation.enqueue(async () => {
    const raw = await readJson(WORKSPACE_CHANGES_KEY, null);
    const store = normalizeChangesStore(raw);
    const record = normalizeWorkspaceChange(entry);
    store[key] = [record, ...(store[key] || [])].slice(0, WORKSPACE_CHANGE_LIMIT);
    const keys = Object.keys(store);
    if (keys.length > WORKSPACE_CHANGE_CHARACTER_LIMIT) {
      keys
        .sort((a, b) => (store[b][0]?.at || 0) - (store[a][0]?.at || 0))
        .slice(WORKSPACE_CHANGE_CHARACTER_LIMIT)
        .forEach(extra => { delete store[extra]; });
    }
    await AsyncStorage.setItem(WORKSPACE_CHANGES_KEY, JSON.stringify(store));
    return record;
  });
}

export function clearWorkspaceChanges(characterId) {
  const key = String(characterId || '').trim();
  if (!key) return Promise.resolve(0);
  return workspaceChangesMutation.enqueue(async () => {
    const raw = await readJson(WORKSPACE_CHANGES_KEY, null);
    const store = normalizeChangesStore(raw);
    const removed = (store[key] || []).length;
    delete store[key];
    await AsyncStorage.setItem(WORKSPACE_CHANGES_KEY, JSON.stringify(store));
    return removed;
  });
}
