// 工作区设置存储域：模式（ask/read/write）、根位置、命令执行开关与工作区角色
// 持久化在单一键下。从 storage 门面转发；归一化在 src/workspace/settings.js（纯函数）。
//
// 另设一个独立键存「工作区改动历史」：每次经后端写入/编辑/删除文件追加一条
// （写入点唯一——native.js 给 createWorkspaceStore 包记录装饰器，面板与聊天工具
// 共用同一路径）。按角色分区，每角色上限 200 条（新的在前），分区上限 50 个角色。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { normalizeWorkspaceSettings } from '../workspace/settings.js';
import {
  WORKSPACE_CHAT_LIMIT,
  WORKSPACE_CHAT_MESSAGE_LIMIT,
  deriveWorkspaceChatTitle,
  emptyWorkspaceChats,
  makeWorkspaceChatId,
  normalizeWorkspaceChat,
  normalizeWorkspaceChatMessage,
  normalizeWorkspaceChatsStore,
  upsertWorkspaceChat,
} from '../workspace/chats.js';
import { createMutationQueue, readJson } from './io.js';

export const WORKSPACE_KEY = '@easychat2_workspace';
export const WORKSPACE_CHANGES_KEY = '@easychat2_workspace_changes';
export const WORKSPACE_CHATS_KEY = '@easychat2_workspace_chats';
export const WORKSPACE_CHAT_LIMIT_SIZE = WORKSPACE_CHAT_LIMIT;
export const WORKSPACE_CHAT_MESSAGE_LIMIT_SIZE = WORKSPACE_CHAT_MESSAGE_LIMIT;
export const WORKSPACE_CHANGE_LIMIT = 200;
const WORKSPACE_CHANGE_CHARACTER_LIMIT = 50;
const WORKSPACE_CHAT_CHARACTER_LIMIT = 50;

const workspaceChangesMutation = createMutationQueue();
const workspaceChatsMutation = createMutationQueue();

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

// ---- 工作区会话（对话持久化） ----
//
// 与聊天页会话分开存（键不同），按角色分区：工作区对话直连 agent 工具循环、
// 不参与角色扮演流水线，混进聊天页列表会把角色聊天淹没。
// 全部写入走同一队列：追加消息与删会话可能由界面并发触发，读-改-写交错会互相覆盖。

async function readChatsStore() {
  const raw = await readJson(WORKSPACE_CHATS_KEY, null);
  return normalizeWorkspaceChatsStore(raw);
}

async function writeChatsStore(store) {
  const keys = Object.keys(store);
  if (keys.length > WORKSPACE_CHAT_CHARACTER_LIMIT) {
    keys
      .sort((a, b) => {
        const left = store[a] && store[a].chats[0] ? store[a].chats[0].updatedAt : 0;
        const right = store[b] && store[b].chats[0] ? store[b].chats[0].updatedAt : 0;
        return right - left;
      })
      .slice(WORKSPACE_CHAT_CHARACTER_LIMIT)
      .forEach(extra => { delete store[extra]; });
  }
  await AsyncStorage.setItem(WORKSPACE_CHATS_KEY, JSON.stringify(store));
  return store;
}

export async function getWorkspaceChats(characterId) {
  const key = String(characterId || '').trim();
  if (!key) return emptyWorkspaceChats();
  const store = await readChatsStore();
  return store[key] || emptyWorkspaceChats();
}

export function createWorkspaceChat(characterId) {
  const key = String(characterId || '').trim();
  const now = Date.now();
  const chat = normalizeWorkspaceChat({
    id: makeWorkspaceChatId(),
    title: '',
    createdAt: now,
    updatedAt: now,
    messages: [],
  });
  if (!key) return Promise.resolve(chat);
  return workspaceChatsMutation.enqueue(async () => {
    const store = await readChatsStore();
    const bucket = store[key] || emptyWorkspaceChats();
    store[key] = { activeId: chat.id, chats: upsertWorkspaceChat(bucket.chats, chat) };
    await writeChatsStore(store);
    return chat;
  });
}

// 追加消息：按 id 去重（流式结束后可能重发同一条终稿），并把首条用户指令提为标题。
export function appendWorkspaceChatMessages(characterId, chatId, messages) {
  const key = String(characterId || '').trim();
  const id = String(chatId || '').trim();
  if (!key || !id) return Promise.resolve(null);
  return workspaceChatsMutation.enqueue(async () => {
    const store = await readChatsStore();
    const bucket = store[key] || emptyWorkspaceChats();
    const target = bucket.chats.find(item => item.id === id);
    if (!target) return null;
    const incoming = (Array.isArray(messages) ? messages : [messages])
      .filter(item => item && item.id)
      .map(normalizeWorkspaceChatMessage);
    const seen = new Set(target.messages.map(item => item.id));
    const fresh = incoming.filter(item => !seen.has(item.id));
    if (!fresh.length) return target;
    const nextMessages = [...target.messages, ...fresh].slice(-WORKSPACE_CHAT_MESSAGE_LIMIT);
    const nextChat = normalizeWorkspaceChat({
      ...target,
      messages: nextMessages,
      title: target.title || deriveWorkspaceChatTitle(nextMessages),
      updatedAt: Date.now(),
    });
    store[key] = {
      activeId: bucket.activeId || id,
      chats: upsertWorkspaceChat(bucket.chats.filter(item => item.id !== id), nextChat),
    };
    await writeChatsStore(store);
    return nextChat;
  });
}

export function setActiveWorkspaceChat(characterId, chatId) {
  const key = String(characterId || '').trim();
  const id = String(chatId || '').trim();
  if (!key || !id) return Promise.resolve(false);
  return workspaceChatsMutation.enqueue(async () => {
    const store = await readChatsStore();
    const bucket = store[key] || emptyWorkspaceChats();
    if (!bucket.chats.some(item => item.id === id)) return false;
    store[key] = { activeId: id, chats: bucket.chats };
    await writeChatsStore(store);
    return true;
  });
}

export function deleteWorkspaceChat(characterId, chatId) {
  const key = String(characterId || '').trim();
  const id = String(chatId || '').trim();
  if (!key || !id) return Promise.resolve(emptyWorkspaceChats());
  return workspaceChatsMutation.enqueue(async () => {
    const store = await readChatsStore();
    const bucket = store[key] || emptyWorkspaceChats();
    const chats = bucket.chats.filter(item => item.id !== id);
    store[key] = {
      activeId: bucket.activeId === id ? (chats[0] ? chats[0].id : '') : bucket.activeId,
      chats,
    };
    await writeChatsStore(store);
    return store[key];
  });
}

export function clearWorkspaceChats(characterId) {
  const key = String(characterId || '').trim();
  if (!key) return Promise.resolve(0);
  return workspaceChatsMutation.enqueue(async () => {
    const store = await readChatsStore();
    const removed = (store[key] || emptyWorkspaceChats()).chats.length;
    delete store[key];
    await writeChatsStore(store);
    return removed;
  });
}
