// 通用集合存储工厂：歌单 / 书架分组等同构领域共用。
// 形态：[{ id, name, <itemField>: [string], createdAt, updatedAt }]，单键存全部
// （集合数量与条目引用都很小，不值得分键）。领域模块只给出 key / id 前缀 /
// 条目字段名，再把返回的函数转出即可：
//
//   const store = createCollectionStore({ key, idPrefix: 'playlist', itemField: 'songIds', errorCodePrefix: 'playlist' });
//   export const getMusicPlaylists = store.getAll;
//
// 错误一律用**错误码**而非文案（i18n 防复发规则：存储层不持有用户可见文本）。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, createMutationQueue, readJsonStatus } from './io.js';

export function createCollectionStore({
  key,
  idPrefix,
  nameMax = 40,
  itemField = 'itemIds',
  errorCodePrefix = 'collection',
}) {
  const collectionKey = String(key || '');
  const mutation = createMutationQueue();

  const ERROR = {
    NAME_REQUIRED: `${errorCodePrefix}-name-required`,
    NOT_FOUND: `${errorCodePrefix}-not-found`,
    READ_FAILED: `${errorCodePrefix}-read-failed`,
    TARGET_INVALID: `${errorCodePrefix}-target-invalid`,
  };

  function fail(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function makeId(now = Date.now()) {
    return `${idPrefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalize(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const itemIds = [];
    const seen = new Set();
    (Array.isArray(source[itemField]) ? source[itemField] : []).forEach(id => {
      const value = String(id || '').trim();
      if (!value || seen.has(value)) return;
      seen.add(value);
      itemIds.push(value);
    });
    return {
      id: String(source.id || '').trim(),
      name: String(source.name || '').trim().slice(0, nameMax),
      [itemField]: itemIds,
      createdAt: Math.floor(Number(source.createdAt)) || 0,
      updatedAt: Math.floor(Number(source.updatedAt)) || 0,
    };
  }

  // 保序规范化：校验必填字段并按 id 去重，不重排（新建追加在尾部，顺序即用户看到的分组顺序）。
  function normalizeList(list) {
    const seen = new Set();
    const result = [];
    (Array.isArray(list) ? list : []).forEach(item => {
      const normalized = normalize(item);
      if (!normalized.id || !normalized.name) return;
      if (seen.has(normalized.id)) return;
      seen.add(normalized.id);
      result.push(normalized);
    });
    return result;
  }

  async function readStatus() {
    const stored = await readJsonStatus(collectionKey);
    if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
      await backupCorruptValue(collectionKey);
      return { status: 'corrupt', list: [] };
    }
    // 首次使用没有键：空列表，不是损坏。
    if (stored.status === 'missing') return { status: 'ok', list: [] };
    return { status: 'ok', list: normalizeList(stored.value) };
  }

  async function write(list) {
    const normalized = normalizeList(list);
    await AsyncStorage.setItem(collectionKey, JSON.stringify(normalized));
    return normalized;
  }

  function getAll() {
    return mutation.enqueue(async () => {
      const result = await readStatus();
      if (result.status === 'corrupt') throw fail(ERROR.READ_FAILED);
      return result.list;
    });
  }

  function create(name) {
    return mutation.enqueue(async () => {
      const trimmed = String(name || '').trim().slice(0, nameMax);
      if (!trimmed) throw fail(ERROR.NAME_REQUIRED);
      const result = await readStatus();
      if (result.status === 'corrupt') throw fail(ERROR.READ_FAILED);
      const now = Date.now();
      const created = normalize({
        id: makeId(now),
        name: trimmed,
        [itemField]: [],
        createdAt: now,
        updatedAt: now,
      });
      await write([...result.list, created]);
      return created;
    });
  }

  function rename(id, name) {
    return mutation.enqueue(async () => {
      const targetId = String(id || '');
      const trimmed = String(name || '').trim().slice(0, nameMax);
      if (!targetId) throw fail(ERROR.NOT_FOUND);
      if (!trimmed) throw fail(ERROR.NAME_REQUIRED);
      const result = await readStatus();
      if (result.status === 'corrupt') throw fail(ERROR.READ_FAILED);
      const target = result.list.find(item => item.id === targetId);
      if (!target) throw fail(ERROR.NOT_FOUND);
      const updated = normalize({ ...target, name: trimmed, updatedAt: Date.now() });
      const list = await write(
        result.list.map(item => (item.id === targetId ? updated : item))
      );
      return list.find(item => item.id === targetId) || updated;
    });
  }

  function remove(id) {
    return mutation.enqueue(async () => {
      const targetId = String(id || '');
      const result = await readStatus();
      if (result.status === 'corrupt') throw fail(ERROR.READ_FAILED);
      if (!targetId) return { removed: null, list: result.list };
      const removed = result.list.find(item => item.id === targetId) || null;
      if (!removed) return { removed: null, list: result.list };
      const list = await write(result.list.filter(item => item.id !== targetId));
      return { removed, list };
    });
  }

  // 加入/移出：included=true 加入（已存在则保持原样），false 移出。只动目标集合。
  function setIncluded(collectionId, itemId, included) {
    return mutation.enqueue(async () => {
      const targetId = String(collectionId || '');
      const targetItemId = String(itemId || '');
      if (!targetId || !targetItemId) throw fail(ERROR.TARGET_INVALID);
      const result = await readStatus();
      if (result.status === 'corrupt') throw fail(ERROR.READ_FAILED);
      const target = result.list.find(item => item.id === targetId);
      if (!target) throw fail(ERROR.NOT_FOUND);
      const has = target[itemField].includes(targetItemId);
      const want = included === true;
      if (has === want) return target;
      const next = want
        ? [...target[itemField], targetItemId]
        : target[itemField].filter(id => id !== targetItemId);
      const updated = normalize({ ...target, [itemField]: next, updatedAt: Date.now() });
      const list = await write(
        result.list.map(item => (item.id === targetId ? updated : item))
      );
      return list.find(item => item.id === targetId) || updated;
    });
  }

  // 条目被删除后的级联清理：从所有集合移除这些条目 id，返回是否有改动。
  // 读取失败一律吞掉返回 false——清理失败绝不能阻断条目删除本身。
  function purgeItems(itemIds) {
    const targets = new Set(
      (Array.isArray(itemIds) ? itemIds : [itemIds])
        .map(id => String(id || ''))
        .filter(Boolean)
    );
    if (targets.size === 0) return Promise.resolve(false);
    return mutation.enqueue(async () => {
      const result = await readStatus();
      if (result.status === 'corrupt') return false;
      let changed = false;
      const next = result.list.map(item => {
        const kept = item[itemField].filter(id => !targets.has(id));
        if (kept.length === item[itemField].length) return item;
        changed = true;
        return { ...item, [itemField]: kept, updatedAt: Date.now() };
      });
      if (changed) await write(next);
      return changed;
    });
  }

  return {
    KEY: collectionKey,
    NAME_MAX: nameMax,
    ITEM_FIELD: itemField,
    ERROR,
    normalize,
    getAll,
    create,
    rename,
    remove,
    setIncluded,
    purgeItems,
  };
}
