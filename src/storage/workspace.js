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
import { createMutationQueue, readJsonStatus } from './io.js';
import { tActive } from '../i18n/index.js';

export const WORKSPACE_KEY = '@easychat2_workspace';
export const WORKSPACE_CHANGES_KEY = '@easychat2_workspace_changes';
export const WORKSPACE_CHATS_KEY = '@easychat2_workspace_chats';
// 每个仓库的「本地副本清单快照」：最近一次拉取/推送成功时的文件路径列表，
// 供 GitHub 工作台算「待同步」的增删（见 workspace/screen/repoDiff.js）。
export const WORKSPACE_REPO_SNAPSHOTS_KEY = '@easychat2_workspace_repo_snapshots';
const REPO_SNAPSHOT_CHARACTER_LIMIT = 20;
const REPO_SNAPSHOT_PATH_LIMIT = 2000;
export const WORKSPACE_CHAT_LIMIT_SIZE = WORKSPACE_CHAT_LIMIT;
export const WORKSPACE_CHAT_MESSAGE_LIMIT_SIZE = WORKSPACE_CHAT_MESSAGE_LIMIT;
export const WORKSPACE_CHANGE_LIMIT = 200;
const WORKSPACE_CHANGE_CHARACTER_LIMIT = 50;
const WORKSPACE_CHAT_CHARACTER_LIMIT = 50;

const workspaceChangesMutation = createMutationQueue();
const workspaceChatsMutation = createMutationQueue();
// 工作区设置键（模式/根位置/命令开关）由多个界面分别修改：入队串行化，避免并发丢更新。
const workspaceSettingsMutation = createMutationQueue();

// 读状态口径（本模块 7 处读取共用）。
//
// readJson(key, null) 把「键不存在」与「读失败 / 结构损坏」压成同一个 null，写路径据此把
// 默认值当现值做读-改-写，于是**读失败一次就把整键用户数据抹掉**。这里改用 readJsonStatus
// （io.js:160）保留三态，把 status === 'corrupt' 一路传到写路径：
//   · missing：键本就不在，按默认值建键是正确行为，写路径照常；
//   · corrupt：读不出（getItem 抛错或 JSON 坏了），写路径一律拒绝覆盖——
//     同 worldMap.js:37「读失败就抛错中止：绝不用空列表覆盖已有地图」的口径。
// 读路径仍按默认值返回（列表给空、设置给默认），用户看不到读失败弹框：本批只改「写不写」
// 的判定，不改读的用户体验。
//
// 注：readJsonStatus 自己不会备份损坏值（io.js:160-178 只做三态判定），而本批是「拒绝写回」
// 而非「用默认值重建」，不产生不可逆覆盖，故这里不调 backupCorruptValue，避免给读路径
// 平白加一次写盘副作用。

// 读工作区设置 + 状态。归一化只丢非法字段，不把「结构合法但字段非法」当读失败：
// 那种情况写回的仍是同一份归一结果，抹不掉任何东西。
async function readWorkspaceSettingsStatus() {
  const stored = await readJsonStatus(WORKSPACE_KEY);
  return {
    status: stored.status,
    settings: normalizeWorkspaceSettings(stored.status === 'corrupt' ? null : stored.value),
  };
}

export async function getWorkspaceSettings() {
  const { settings } = await readWorkspaceSettingsStatus();
  return settings;
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
  // 串行化读-改-写：模式、根位置与命令开关由不同界面修改，并发时各自读同一份现值再
  // 整表覆盖会互相打回默认（表现为「改模式把已选文件夹清掉」）。入队后每次合并基于最新值。
  return workspaceSettingsMutation.enqueue(async () => {
    const { status, settings: current } = await readWorkspaceSettingsStatus();
    // ① 拒绝写回（同 worldMap.js:37）：读失败就抛错中止，绝不用「默认设置」当现值合并补丁后
    // 整键写回——那会把模式 / 已选文件夹 / 两个执行开关 / 本地 git 一次性重置。
    // 调用方（useWorkspaceSettings、ChatPanel、WorkspaceScreen）都已 catch 并提示，
    // 用户看到的是「保存失败」，而不是设置被悄悄重置。
    if (status === 'corrupt') {
      throw new Error(tActive('workspace.panel.err.read'));
    }
    const merged = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
    const normalized = normalizeWorkspaceSettings(merged);
    await AsyncStorage.setItem(WORKSPACE_KEY, JSON.stringify(normalized));
    return normalized;
  });
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
    // import = 批量导入的汇总条目（一次导入一条，count 为写入文件数）。
    op: ['write', 'edit', 'delete', 'import'].includes(source.op) ? source.op : 'write',
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

// 读改动历史 + 状态。corrupt 只影响写路径：读路径照旧返回空列表（用户体验不变）。
async function readChangesStoreStatus() {
  const stored = await readJsonStatus(WORKSPACE_CHANGES_KEY);
  return {
    status: stored.status,
    store: stored.status === 'corrupt' ? {} : normalizeChangesStore(stored.value),
  };
}

export async function getWorkspaceChanges(characterId) {
  const { store } = await readChangesStoreStatus();
  return store[String(characterId || '').trim()] || [];
}

// 追加一条改动（新的在前）。历史写失败绝不能影响文件操作本身——调用方
// （history.js 装饰器）会吞掉这里的异常，这里保持「要么写成功要么抛」的直白语义。
export function appendWorkspaceChange(characterId, entry) {
  const key = String(characterId || '').trim();
  if (!key) return Promise.resolve(null);
  return workspaceChangesMutation.enqueue(async () => {
    const { status, store } = await readChangesStoreStatus();
    // ① 拒绝写回（同 worldMap.js:37）：这个键是**单键整表**（所有角色分区都挤在一个键里），
    // 追加也必须读-改-写整表——AsyncStorage 没有 append 原语，做不到「只追加不整表覆盖」，
    // 所以读失败时用空表写回等于把所有角色的历史一次抹掉，只能拒绝。
    // 调用方（history.js 装饰器）会吞掉这里的异常，文件操作本身不受影响。
    if (status === 'corrupt') {
      throw new Error(tActive('workspace.panel.err.read'));
    }
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
    const { status, store } = await readChangesStoreStatus();
    // ① 拒绝写回（同 worldMap.js:37）：清空一个角色也要整表重写，读失败时写回的是
    // 「只剩空表」——会把**其它角色**的历史一并清掉。调用方 FilesPanel 已 catch。
    if (status === 'corrupt') {
      throw new Error(tActive('workspace.panel.err.read'));
    }
    const removed = (store[key] || []).length;
    delete store[key];
    await AsyncStorage.setItem(WORKSPACE_CHANGES_KEY, JSON.stringify(store));
    return removed;
  });
}

// ---- 仓库本地副本清单快照（GitHub 工作台的「待同步」依据） ----

function normalizeRepoSnapshotsStore(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  Object.entries(source).forEach(([characterId, repos]) => {
    const key = String(characterId || '').trim();
    if (!key || !repos || typeof repos !== 'object' || Array.isArray(repos)) return;
    const bucket = {};
    Object.entries(repos).forEach(([repoId, snapshot]) => {
      const id = String(repoId || '').trim();
      if (!id || !snapshot || typeof snapshot !== 'object') return;
      const paths = Array.isArray(snapshot.paths)
        ? snapshot.paths.map(item => String(item || '')).filter(Boolean).slice(0, REPO_SNAPSHOT_PATH_LIMIT)
        : [];
      bucket[id] = { at: Math.max(0, Math.floor(Number(snapshot.at)) || 0), paths };
    });
    if (Object.keys(bucket).length) out[key] = bucket;
  });
  return out;
}

// 读快照表 + 状态。corrupt 只影响写路径：读路径照旧返回 null（用户体验不变）。
async function readRepoSnapshotsStatus() {
  const stored = await readJsonStatus(WORKSPACE_REPO_SNAPSHOTS_KEY);
  return {
    status: stored.status,
    store: stored.status === 'corrupt' ? {} : normalizeRepoSnapshotsStore(stored.value),
  };
}

export async function getRepoSnapshot(characterId, repoId) {
  const key = String(characterId || '').trim();
  const id = String(repoId || '').trim();
  if (!key || !id) return null;
  const { store } = await readRepoSnapshotsStatus();
  return (store[key] && store[key][id]) || null;
}

// 写入某仓库的清单快照（拉取/推送成功后调用）。写失败由调用方吞掉——快照是辅助信息。
export function setRepoSnapshot(characterId, repoId, { paths, at = Date.now() } = {}) {
  const key = String(characterId || '').trim();
  const id = String(repoId || '').trim();
  if (!key || !id) return Promise.resolve(null);
  return workspaceChangesMutation.enqueue(async () => {
    const { status, store } = await readRepoSnapshotsStatus();
    // ① 拒绝写回（同 worldMap.js:37）：快照表也是单键整表，读失败时写回会把其它角色 /
    // 其它仓库的基线一次抹掉——基线没了，下次推送会把「待同步」判成「全新文件」。
    // 写失败由调用方吞掉（GithubPanel 四处都 catch），快照是辅助信息。
    if (status === 'corrupt') {
      throw new Error(tActive('workspace.panel.err.read'));
    }
    const bucket = store[key] || {};
    bucket[id] = { at, paths: Array.isArray(paths) ? paths.slice(0, REPO_SNAPSHOT_PATH_LIMIT) : [] };
    // 每个角色最多保留 N 个仓库快照，按时间淘汰最旧的。
    const ids = Object.keys(bucket);
    if (ids.length > REPO_SNAPSHOT_CHARACTER_LIMIT) {
      ids.sort((a, b) => (bucket[b].at || 0) - (bucket[a].at || 0))
        .slice(REPO_SNAPSHOT_CHARACTER_LIMIT)
        .forEach(extra => { delete bucket[extra]; });
    }
    store[key] = bucket;
    await AsyncStorage.setItem(WORKSPACE_REPO_SNAPSHOTS_KEY, JSON.stringify(store));
    return bucket[id];
  });
}

// ---- 工作区会话（对话持久化） ----
//
// 与聊天页会话分开存（键不同），按角色分区：工作区对话直连 agent 工具循环、
// 不参与角色扮演流水线，混进聊天页列表会把角色聊天淹没。
// 全部写入走同一队列：追加消息与删会话可能由界面并发触发，读-改-写交错会互相覆盖。

// 读会话表 + 状态。corrupt 只影响写路径：getWorkspaceChats 照旧返回空清单（用户体验不变）。
async function readChatsStoreStatus() {
  const stored = await readJsonStatus(WORKSPACE_CHATS_KEY);
  return {
    status: stored.status,
    store: stored.status === 'corrupt' ? {} : normalizeWorkspaceChatsStore(stored.value),
  };
}

// ① 拒绝写回（同 worldMap.js:37）：工作区会话是用户与 agent 的一手对话，丢了不可重建——
// 比地图更不可替代，所以这里不取⑥「部分写入」（那会留下「消息写进去了、会话列表却是空的」
// 半截状态），直接抛错中止。
//
// 为什么读取处也要断言一次（见下方各写入口）：corrupt 时表被归一成空表，各写入口的
// 「找不到目标会话就 return null/false」会先命中——写确实没发生（数据没丢），但调用方
// 会把「读失败」误当成「这条会话不存在」，用户的这条消息就被静默丢弃、界面上什么都没有。
// 对一手数据，宁可显式报错。
function assertChatsStoreWritable(status) {
  if (status === 'corrupt') {
    throw new Error(tActive('error.storage.chatLogReadFailed'));
  }
}

// status 由读路径透传进来，绝不在这里重新读一次（重读会把「刚才那次读失败」抹掉，
// 等于没守卫）。写入口再挡一次：即便将来有人加了新写路径忘了断言，也绝不用空表覆盖。
async function writeChatsStore(status, store) {
  assertChatsStoreWritable(status);
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
  const { store } = await readChatsStoreStatus();
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
    const { status, store } = await readChatsStoreStatus();
    assertChatsStoreWritable(status);
    const bucket = store[key] || emptyWorkspaceChats();
    store[key] = { activeId: chat.id, chats: upsertWorkspaceChat(bucket.chats, chat) };
    await writeChatsStore(status, store);
    return chat;
  });
}

// 追加消息：按 id 去重（流式结束后可能重发同一条终稿），并把首条用户指令提为标题。
export function appendWorkspaceChatMessages(characterId, chatId, messages) {
  const key = String(characterId || '').trim();
  const id = String(chatId || '').trim();
  if (!key || !id) return Promise.resolve(null);
  return workspaceChatsMutation.enqueue(async () => {
    const { status, store } = await readChatsStoreStatus();
    assertChatsStoreWritable(status);
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
    await writeChatsStore(status, store);
    return nextChat;
  });
}

// N2：整表替换某会话的消息（压缩后落库用）——与 append 不同，这是覆盖式写入。
// 归一化 + 尾部上限与 append 同口径；失败返回 null（压缩是增强，不破坏会话）。
export function replaceWorkspaceChatMessages(characterId, chatId, messages) {
  const key = String(characterId || '').trim();
  const id = String(chatId || '').trim();
  if (!key || !id) return Promise.resolve(null);
  return workspaceChatsMutation.enqueue(async () => {
    const { status, store } = await readChatsStoreStatus();
    assertChatsStoreWritable(status);
    const bucket = store[key] || emptyWorkspaceChats();
    const target = bucket.chats.find(item => item.id === id);
    if (!target) return null;
    const nextMessages = (Array.isArray(messages) ? messages : [messages])
      .filter(item => item && item.id)
      .map(normalizeWorkspaceChatMessage)
      .slice(-WORKSPACE_CHAT_MESSAGE_LIMIT);
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
    await writeChatsStore(status, store);
    return nextChat;
  });
}

// I5：归档/恢复某条会话。归档的会话不进主列表默认视图（可筛出），也不参与
// D3 压缩扫描等后台任务——它是「收进抽屉」，不是删除。
export function setWorkspaceChatArchived(characterId, chatId, archived) {
  const key = String(characterId || '').trim();
  const id = String(chatId || '').trim();
  if (!key || !id) return Promise.resolve(false);
  const flag = archived === true;
  return workspaceChatsMutation.enqueue(async () => {
    const { status, store } = await readChatsStoreStatus();
    assertChatsStoreWritable(status);
    const bucket = store[key] || emptyWorkspaceChats();
    const target = bucket.chats.find(item => item.id === id);
    if (!target) return false;
    if ((target.archived === true) === flag) return true; // 幂等
    const nextChat = normalizeWorkspaceChat({ ...target, archived: flag });
    store[key] = {
      activeId: bucket.activeId,
      chats: upsertWorkspaceChat(bucket.chats.filter(item => item.id !== id), nextChat),
    };
    await writeChatsStore(status, store);
    return true;
  });
}

// 保存某条会话的输入草稿（未发送的输入框内容）。
// 只动 draft 字段、**不碰 updatedAt**：草稿不是「会话活动」，否则打字会把
// 历史列表的排序带乱（刚打的草稿把一条旧会话顶到最前，用户会以为消息写错了）。
// 用 map 原位替换而不是 upsert：这里没有任何「置顶/裁剪」语义要办。
export function saveWorkspaceChatDraft(characterId, chatId, draft) {
  const key = String(characterId || '').trim();
  const id = String(chatId || '').trim();
  if (!key || !id) return Promise.resolve(false);
  const text = String(draft === undefined || draft === null ? '' : draft);
  return workspaceChatsMutation.enqueue(async () => {
    const { status, store } = await readChatsStoreStatus();
    assertChatsStoreWritable(status);
    const bucket = store[key] || emptyWorkspaceChats();
    const target = bucket.chats.find(item => item.id === id);
    if (!target) return false;
    const nextChat = normalizeWorkspaceChat({ ...target, draft: text, updatedAt: target.updatedAt });
    store[key] = {
      activeId: bucket.activeId || id,
      chats: bucket.chats.map(item => (item.id === id ? nextChat : item)),
    };
    await writeChatsStore(status, store);
    return true;
  });
}

export function setActiveWorkspaceChat(characterId, chatId) {
  const key = String(characterId || '').trim();
  const id = String(chatId || '').trim();
  if (!key || !id) return Promise.resolve(false);
  return workspaceChatsMutation.enqueue(async () => {
    const { status, store } = await readChatsStoreStatus();
    assertChatsStoreWritable(status);
    const bucket = store[key] || emptyWorkspaceChats();
    if (!bucket.chats.some(item => item.id === id)) return false;
    store[key] = { activeId: id, chats: bucket.chats };
    await writeChatsStore(status, store);
    return true;
  });
}

export function deleteWorkspaceChat(characterId, chatId) {
  const key = String(characterId || '').trim();
  const id = String(chatId || '').trim();
  if (!key || !id) return Promise.resolve(emptyWorkspaceChats());
  return workspaceChatsMutation.enqueue(async () => {
    const { status, store } = await readChatsStoreStatus();
    assertChatsStoreWritable(status);
    const bucket = store[key] || emptyWorkspaceChats();
    const chats = bucket.chats.filter(item => item.id !== id);
    store[key] = {
      activeId: bucket.activeId === id ? (chats[0] ? chats[0].id : '') : bucket.activeId,
      chats,
    };
    await writeChatsStore(status, store);
    return store[key];
  });
}

export function clearWorkspaceChats(characterId) {
  const key = String(characterId || '').trim();
  if (!key) return Promise.resolve(0);
  return workspaceChatsMutation.enqueue(async () => {
    const { status, store } = await readChatsStoreStatus();
    assertChatsStoreWritable(status);
    const removed = (store[key] || emptyWorkspaceChats()).chats.length;
    delete store[key];
    await writeChatsStore(status, store);
    return removed;
  });
}
