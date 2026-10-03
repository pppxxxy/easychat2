// 音乐库存储领域：「索引 + 单条分键」（与表情包/本地模型同一惯例）。
// 歌曲文件由导入方复制到文档目录 music/<id>.<扩展名>，记录里只保存 uri 与元数据；
// 时间轴打点随歌曲存放在条目内（打点属于歌曲数据，量小且始终整组读写）。
// 陪伴评论量大且追加频繁，独立分键，见 ./comments.js。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { markMediaWrite } from '../mediaProtection.js';
import { backupCorruptValue, createMutationQueue, readJsonStatus } from '../storage/io.js';

import { normalizeTriggers } from './triggers.js';

export const MUSIC_INDEX_KEY = '@easychat2_music_index';
export const MUSIC_ITEM_PREFIX = '@easychat2_music_item';
export const MUSIC_DIR_NAME = 'music';

const musicMutation = createMutationQueue();

export function musicItemKey(id) {
  return `${MUSIC_ITEM_PREFIX}::${String(id || '')}`;
}

export function normalizeMusicItem(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    id: String(source.id || ''),
    name: String(source.name || '').trim(),
    uri: String(source.uri || ''),
    // size/mime 记录导入时的文件事实，仅供展示与去重参考；缺失不阻断。
    size: Math.max(0, Math.floor(Number(source.size)) || 0),
    mime: String(source.mime || '').trim(),
    // durationMs 首次播放成功后回填；0 表示未知，进度条按未知时长处理。
    durationMs: Math.max(0, Math.floor(Number(source.durationMs)) || 0),
    addedAt: Math.floor(Number(source.addedAt)) || 0,
    triggers: normalizeTriggers(source.triggers),
  };
}

// 保序规范化：校验必填字段并按首次出现去重，不重排（导入顺序即列表顺序，新导入置顶由调用方决定）。
function normalizeMusicItemList(list) {
  const seen = new Set();
  const result = [];
  (Array.isArray(list) ? list : []).forEach(item => {
    const normalized = normalizeMusicItem(item);
    if (!normalized.id || !normalized.name || !normalized.uri) return;
    if (seen.has(normalized.id)) return;
    seen.add(normalized.id);
    result.push(normalized);
  });
  return result;
}

async function readMusicIndexStatus() {
  const stored = await readJsonStatus(MUSIC_INDEX_KEY);
  if (stored.status === 'corrupt' || (stored.status === 'ok' && !Array.isArray(stored.value))) {
    await backupCorruptValue(MUSIC_INDEX_KEY);
    return { status: 'corrupt', ids: [] };
  }
  if (stored.status === 'missing') return { status: 'missing', ids: [] };
  return {
    status: 'ok',
    ids: [...new Set((stored.value || []).map(id => String(id || '')).filter(Boolean))],
  };
}

async function readMusicCollectionStatus() {
  const index = await readMusicIndexStatus();
  if (index.status !== 'ok') return { status: index.status, items: [] };
  const items = [];
  for (const id of index.ids) {
    const stored = await readJsonStatus(musicItemKey(id));
    if (stored.status === 'missing' || stored.status === 'corrupt'
      || !stored.value || typeof stored.value !== 'object' || Array.isArray(stored.value)) {
      // 条目缺失/损坏视为整库受损：与表情包领域一致，备份原值后要求调用方走恢复路径，
      // 避免静默丢歌造成「索引里有、播放时文件还在」的幽灵条目。
      await backupCorruptValue(musicItemKey(id));
      return { status: 'corrupt', items: [] };
    }
    const normalized = normalizeMusicItem(stored.value);
    if (!normalized.id || !normalized.name || !normalized.uri) {
      await backupCorruptValue(musicItemKey(id));
      return { status: 'corrupt', items: [] };
    }
    items.push(normalized);
  }
  return { status: 'ok', items };
}

async function writeMusicCollection(items) {
  const list = normalizeMusicItemList(items);
  const ids = list.map(item => item.id);
  if (list.length > 0) {
    await AsyncStorage.multiSet(list.map(item => [musicItemKey(item.id), JSON.stringify(item)]));
  }
  await AsyncStorage.setItem(MUSIC_INDEX_KEY, JSON.stringify(ids));
  // 分键惯例的陈键清扫：索引里已不存在的条目键一并移除，防止反复导入导出后残留幽灵数据。
  try {
    const keys = await AsyncStorage.getAllKeys();
    const activeIds = new Set(ids);
    const staleKeys = keys.filter(key => (
      String(key).startsWith(`${MUSIC_ITEM_PREFIX}::`)
      && !activeIds.has(String(key).slice(`${MUSIC_ITEM_PREFIX}::`.length))
    ));
    if (staleKeys.length > 0) await AsyncStorage.multiRemove(staleKeys);
  } catch (error) {}
}

export function getMusicItems() {
  return musicMutation.enqueue(async () => {
    const result = await readMusicCollectionStatus();
    if (result.status === 'corrupt') throw new Error('音乐库记录读取失败，请稍后重试');
    return result.items;
  });
}

// 新增或整条更新。文件复制成功后由导入方调用；uri 落库前登记媒体保护，孤儿回收不误删。
export function saveMusicItem(item) {
  return musicMutation.enqueue(async () => {
    const normalized = normalizeMusicItem(item);
    if (!normalized.id || !normalized.name || !normalized.uri) {
      throw new Error('歌曲信息不完整');
    }
    markMediaWrite(normalized.uri);
    const result = await readMusicCollectionStatus();
    if (result.status === 'corrupt') throw new Error('音乐库记录读取失败，请稍后重试');
    const exists = result.items.some(entry => entry.id === normalized.id);
    // 新歌置顶，已有条目原位替换（保持用户看到的顺序稳定）。
    await writeMusicCollection(
      exists
        ? result.items.map(entry => (entry.id === normalized.id ? normalized : entry))
        : [normalized, ...result.items]
    );
    return normalized;
  });
}

// 只更新时长（首次播放成功后回填），其余字段原样保留。
export function saveMusicDuration(id, durationMs) {
  return musicMutation.enqueue(async () => {
    const targetId = String(id || '');
    if (!targetId) throw new Error('歌曲信息不完整');
    const result = await readMusicCollectionStatus();
    if (result.status === 'corrupt') throw new Error('音乐库记录读取失败，请稍后重试');
    const target = result.items.find(entry => entry.id === targetId);
    if (!target) return null;
    const duration = Math.max(0, Math.floor(Number(durationMs)) || 0);
    if (target.durationMs === duration) return target;
    const updated = normalizeMusicItem({ ...target, durationMs: duration });
    await writeMusicCollection(result.items.map(entry => (entry.id === targetId ? updated : entry)));
    return updated;
  });
}

// 覆盖保存某首歌的全部打点（界面在内存里增删后整组写回）。
export function saveMusicTriggers(songId, triggers) {
  return musicMutation.enqueue(async () => {
    const targetId = String(songId || '');
    if (!targetId) throw new Error('歌曲信息不完整');
    const result = await readMusicCollectionStatus();
    if (result.status === 'corrupt') throw new Error('音乐库记录读取失败，请稍后重试');
    const target = result.items.find(entry => entry.id === targetId);
    if (!target) throw new Error('歌曲不存在或已被删除');
    const updated = normalizeMusicItem({ ...target, triggers });
    await writeMusicCollection(result.items.map(entry => (entry.id === targetId ? updated : entry)));
    return updated;
  });
}

// 批量删除记录，返回被删条目（含 uri）；音频文件由调用方删除，这里只管记录。
export async function deleteMusicItems(ids) {
  const targetIds = new Set((Array.isArray(ids) ? ids : [ids]).map(id => String(id || '')).filter(Boolean));
  return musicMutation.enqueue(async () => {
    const result = await readMusicCollectionStatus();
    if (result.status === 'corrupt') throw new Error('音乐库记录读取失败，请稍后重试');
    if (targetIds.size === 0) return { remaining: result.items, removed: [] };
    const removed = result.items.filter(item => targetIds.has(item.id));
    const remaining = result.items.filter(item => !targetIds.has(item.id));
    await writeMusicCollection(remaining);
    return { remaining, removed };
  });
}
