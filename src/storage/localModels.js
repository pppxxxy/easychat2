// 本地模型存储领域：设置（兼容旧单模型键）+ 多模型按 id 分键存储。
// 模型条目按 id 拆到 LOCAL_MODEL_ITEM_PREFIX 键，轻量索引最后写作为提交点，
// 避免整表 JSON 突破 Android SQLite 单值读取上限（CursorWindow 约 2MB）。
// 旧键 @easychat2_local_model 中的单模型会被迁移成一条条目，并回填 activeModelId。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { backupCorruptValue, readJson, readJsonStatus, readJsonStatusWithSecrets, readJsonWithSecrets, setJsonWithSecrets } from './io.js';
import { recordDiagnostic } from './diagnostics.js';
import {
  LOCAL_MODEL_INDEX_KEY,
  LOCAL_MODEL_ITEM_PREFIX,
  LOCAL_MODEL_SETTINGS_KEY,
  LOCAL_MODEL_SETTINGS_SCHEMA,
  localModelIndexEntry,
  normalizeLocalModelIndexEntry,
  normalizeLocalModelItem,
  normalizeLocalModelSettings,
  migrateLegacyLocalModelSettings,
} from '../localModel/modelState.js';
import { tActive } from '../i18n/index.js';

export function localModelItemKey(id) {
  return `${LOCAL_MODEL_ITEM_PREFIX}::${String(id || '')}`;
}

export async function getLocalModelSettings() {
  // 设置键的 apiServer.apiKey 是密钥：与其他配置一致走保险箱读写，避免明文落盘。
  const raw = await readJsonWithSecrets(LOCAL_MODEL_SETTINGS_KEY, null);
  const normalized = normalizeLocalModelSettings(raw);
  if (normalized.schema >= LOCAL_MODEL_SETTINGS_SCHEMA) return normalized;
  // 旧结构（无 schema 或 schema<2）：一次性迁移——写条目/索引 + 清空 legacy 字段 +
  // 记 schema:2。迁移后设置键只剩单一事实源字段，读路径不再见 legacy。
  await migrateLegacyLocalModel();
  return normalizeLocalModelSettings(await readJsonWithSecrets(LOCAL_MODEL_SETTINGS_KEY, null));
}

// ⚠️ 三态设置读：ok / missing / corrupt（B3 的落点）。
//
// 为什么必须有这个入口：getLocalModelSettings 走 readJsonWithSecrets，而 readJson 把
// 「getItem 抛错」吞成 fallback(null) ⇒ 归一化后得到**一份漂亮的默认设置**
// （apiKey:''）。于是「读失败」与「确实没有密钥」在调用方眼里长得一模一样 ——
// 面板据此把「未知」当成「空」，生成新密钥并整键覆盖用户凭据：所有已按旧密钥配置的
// 外部客户端全部 401，且旧密钥不可恢复。需要区分两者时必须走本入口。
// 先例：同面板 usePanelModels.updateSettings 已经 fail-closed（读失败即抛错、不写回）。
export async function getLocalModelSettingsStatus() {
  const stored = await readJsonStatusWithSecrets(LOCAL_MODEL_SETTINGS_KEY);
  if (stored.status === 'ok') {
    const normalized = normalizeLocalModelSettings(stored.value);
    // 旧结构（schema<2）仍走 getLocalModelSettings 的一次性迁移路径，读行为与迁移口径不变。
    if (normalized.schema < LOCAL_MODEL_SETTINGS_SCHEMA) {
      return { status: 'ok', settings: await getLocalModelSettings() };
    }
    return { status: 'ok', settings: normalized };
  }
  // 键不存在 = 首次运行：可以安全地按「没有密钥」处理（生成新密钥不覆盖任何东西）。
  if (stored.status === 'missing') return { status: 'missing', settings: await getLocalModelSettings() };
  // 读不出来（第四态）：settings 为 null，调用方**不得**据此判空。
  return { status: 'corrupt', settings: null };
}

export async function saveLocalModelSettings(settings) {
  // 写入一律盖 schema:2：调用方传的是已归一化的 v2 设置，此处兜底防止漏盖。
  const normalized = { ...normalizeLocalModelSettings(settings), schema: LOCAL_MODEL_SETTINGS_SCHEMA };
  await setJsonWithSecrets(LOCAL_MODEL_SETTINGS_KEY, normalized);
  return normalized;
}

// 只读索引键，不做迁移；缺失或结构异常返回 []。
async function readStoredIndexEntries() {
  const stored = await readJsonStatus(LOCAL_MODEL_INDEX_KEY);
  if (stored.status !== 'ok' || !Array.isArray(stored.value)) return [];
  return stored.value.map(normalizeLocalModelIndexEntry).filter(entry => entry.id);
}

async function writeIndexEntries(entries) {
  await AsyncStorage.setItem(LOCAL_MODEL_INDEX_KEY, JSON.stringify(entries));
}

export async function getLocalModelIndex() {
  const stored = await readJsonStatus(LOCAL_MODEL_INDEX_KEY);
  if (stored.status === 'ok' && Array.isArray(stored.value)) {
    return stored.value.map(normalizeLocalModelIndexEntry).filter(entry => entry.id);
  }
  if (stored.status === 'missing') {
    return migrateLegacyLocalModel();
  }
  await backupCorruptValue(LOCAL_MODEL_INDEX_KEY);
  return rebuildLocalModelIndex();
}

// 旧单模型设置一次性迁移成多模型（v5 Stage A）：写条目 + 写索引 + 回填
// activeModelId，并把 legacy 字段清零、盖上 schema:2。此后读路径只见单一事实源。
// 无旧模型时也要落一次 schema:2，避免每次都判定为「待迁移」。
export async function migrateLegacyLocalModel() {
  const legacy = await readJson(LOCAL_MODEL_SETTINGS_KEY, null);
  const { settings, item } = migrateLegacyLocalModelSettings(legacy);
  try {
    if (item) {
      await AsyncStorage.setItem(localModelItemKey(item.id), JSON.stringify(item));
      await writeIndexEntries([localModelIndexEntry(item)]);
    }
    await setJsonWithSecrets(LOCAL_MODEL_SETTINGS_KEY, { ...settings, schema: LOCAL_MODEL_SETTINGS_SCHEMA });
    return item ? [localModelIndexEntry(item)] : [];
  } catch (error) {
    return [];
  }
}

// 索引损坏时扫出散落的条目键，尽量把模型列表拼回来。
export async function rebuildLocalModelIndex() {
  let keys = [];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch (error) {
    return [];
  }
  const entries = [];
  const itemKeys = (Array.isArray(keys) ? keys : [])
    .filter(key => typeof key === 'string' && key.startsWith(`${LOCAL_MODEL_ITEM_PREFIX}::`));
  for (const key of itemKeys) {
    const stored = await readJsonStatus(key);
    if (stored.status === 'ok' && stored.value && typeof stored.value === 'object' && !Array.isArray(stored.value)) {
      const entry = localModelIndexEntry(stored.value);
      if (entry.id) entries.push(entry);
    }
  }
  try {
    await writeIndexEntries(entries);
  } catch (error) {}
  return entries;
}

export async function getLocalModelItem(id) {
  const itemId = String(id || '').trim();
  if (!itemId) return null;
  const stored = await readJsonStatus(localModelItemKey(itemId));
  if (stored.status !== 'ok' || !stored.value || typeof stored.value !== 'object' || Array.isArray(stored.value)) {
    return null;
  }
  return normalizeLocalModelItem(stored.value);
}

// ---- 补偿（回滚）读原语：把「读失败」与「键不存在」严格分成两态 ----
//
// ⭐ 可复用判据（本仓补偿逻辑的通用纪律）：
//   补偿逻辑只能「恢复」不能「删除」；读不回原值时，唯一安全的动作是保留现状并留痕。
//
// 为什么必须分成两态：AsyncStorage.getItem 抛错（Android CursorWindow 单值读取上限、
// IO 故障）是**第四态**，与「键不存在（raw === null）」完全不同。此前用
// `.catch(() => null)` 把读失败折成 null，于是回滚分支把「读不到原值」误判成
// 「原值本来就不存在」⇒ 执行 removeItem —— 安全网自己变成不可逆删除的执行者：
// 刚写入的新值被删掉，被覆盖掉的旧值也永远回不来（回滚本应恢复它，却选择了删除）。
//
// 先例（同一仓库正反两面）：
// - sessionMessages/summaries.js：补偿回滚写得最细的一处——先读原值、回滚失败也留痕，
//   读不出摘要状态（corrupt）时直接抛错，绝不用空列表推进边界；
// - worldMap.js:37：读失败就抛错中止，「绝不用空列表覆盖已有地图」。
async function readPreviousValue(key) {
  try {
    return { ok: true, raw: await AsyncStorage.getItem(key) };
  } catch (error) {
    // 读失败：raw 不可知。ok:false 是唯一诚实的表达，绝不冒充 null。
    return { ok: false, raw: null, error };
  }
}

// 补偿单个键：只有「确认读到过原值」才动手。
// - ok && raw !== null：写回原值（真正的恢复）；
// - ok && raw === null：键此前确实不存在 ⇒ 删除本次写入，回到「没有这个键」的原状；
// - !ok（读不回原值）：既不删除也不猜测 —— 保留盘上现状（本次写入的值）+ 留痕。
//   「保留一个用户看得见的新值」远好于「不可逆地删掉唯一的一份数据」。
async function compensateKey(key, previous, reason) {
  if (!previous.ok) {
    recordDiagnostic('storage', reason || previous.error || new Error(tActive('localModel.error.rollbackUnreadable')), key);
    return;
  }
  if (previous.raw === null) await AsyncStorage.removeItem(key).catch(() => {});
  else await AsyncStorage.setItem(key, previous.raw).catch(() => {});
}

// 写入条目后写索引（提交点）。任一步失败都回滚，避免「条目在、索引没了」。
export async function saveLocalModelItem(item) {
  const normalized = normalizeLocalModelItem(item);
  if (!normalized.id) throw new Error(tActive('error.storage.modelMissingId'));
  const now = Date.now();
  const next = {
    ...normalized,
    createdAt: normalized.createdAt || now,
    updatedAt: now,
  };
  const key = localModelItemKey(next.id);
  const previousItem = await readPreviousValue(key);
  const previousIndex = await readPreviousValue(LOCAL_MODEL_INDEX_KEY);
  try {
    await AsyncStorage.setItem(key, JSON.stringify(next));
    const entries = await readStoredIndexEntries();
    const entry = localModelIndexEntry(next);
    const existing = entries.findIndex(current => current.id === entry.id);
    if (existing >= 0) entries[existing] = entry;
    else entries.push(entry);
    await writeIndexEntries(entries);
  } catch (error) {
    // 读不回原值时 compensateKey 只留痕不删除：宁可保留刚写入的 next（用户看得见、
    // 可以再改再存），也绝不执行不可逆删除。
    await compensateKey(key, previousItem, error);
    await compensateKey(LOCAL_MODEL_INDEX_KEY, previousIndex, error);
    throw error;
  }
  return next;
}

// 删除条目时级联清掉其参数（同一 item 键）；若是当前活动模型则清空指针（需求 4）。
export async function deleteLocalModelItem(id) {
  const itemId = String(id || '').trim();
  if (!itemId) return [];
  const key = localModelItemKey(itemId);
  const previousItem = await readPreviousValue(key);
  // ⚠️ 不可逆删除的前置条件：必须先拿到原值（必要时用它还原）。读不回原值时
  // 「删了就无法还原」，所以这里 fail-closed 直接中止，绝不在未知状态下 removeItem。
  // 这不是过度保守：removeItem 是本仓少数几个不可撤销的动作之一。
  if (!previousItem.ok) {
    const error = new Error(tActive('localModel.error.deleteUnreadable'));
    recordDiagnostic('storage', previousItem.error || error, key);
    throw error;
  }
  const previousIndex = await readPreviousValue(LOCAL_MODEL_INDEX_KEY);
  let entries = [];
  try {
    await AsyncStorage.removeItem(key);
    entries = (await readStoredIndexEntries()).filter(entry => entry.id !== itemId);
    await writeIndexEntries(entries);
  } catch (error) {
    // 已确认读到过原值，恢复是安全的（previousItem.raw === null 表示本来就没有这个键）。
    await compensateKey(key, previousItem, error);
    await compensateKey(LOCAL_MODEL_INDEX_KEY, previousIndex, error);
    throw error;
  }
  const settings = await getLocalModelSettings();
  if (settings.activeModelId === itemId) {
    await saveLocalModelSettings({ ...settings, activeModelId: '' }).catch(() => {});
  }
  return entries;
}

export async function getActiveLocalModel() {
  const settings = await getLocalModelSettings();
  if (!settings.activeModelId) return null;
  return getLocalModelItem(settings.activeModelId);
}

// ---- 下载队列持久化（v5 Stage B）----
//
// 队列是「任务」而非「表单动作」：任务的进度/取消/重试与任何 UI 生命周期解耦，
// 且活过 app 重启。这里只做键的读写原语，队列语义在 localModel/downloadQueue.js。
export const LOCAL_MODEL_QUEUE_KEY = '@easychat2_download_queue';

// ⚠️ 三态读取：ok / missing / corrupt，**绝不把失败压成空数组**。
// 为什么必须三态（这正是本函数存在的原因）：调用方 downloadQueue.hydrate 要据此决定
// 「是否允许写回」。若这里把 corrupt/读失败一律压成 []，hydrate 就会把空数组 persist
// 回去，覆盖掉真正存着待下载任务的队列 —— 用户的 3 个任务永久消失、零提示零诊断。
// 更隐蔽的是「下游加了 .catch(() => []) 兜底」会给虚假安全感：上游已把失败抹平成
// 一个**正常值**，下游的 catch 连触发都不会触发，兜底等于没写。
// 同一文件的索引路径早已是这个口径：getLocalModelIndex 见到 corrupt 会
// backupCorruptValue + rebuildLocalModelIndex，而不是直接当空表用。
export async function readDownloadQueueStatus() {
  const stored = await readJsonStatus(LOCAL_MODEL_QUEUE_KEY);
  if (stored.status === 'ok' && Array.isArray(stored.value)) {
    return { status: 'ok', value: stored.value };
  }
  if (stored.status === 'ok') {
    // 第四态：键在、JSON 也解析成功，但形状不是数组。与 corrupt 同等对待 ——
    // 「结构坏了」和「读不出来」对调用方是同一件事：都不许当成空队列写回。
    await backupCorruptValue(LOCAL_MODEL_QUEUE_KEY);
    return { status: 'corrupt', value: [] };
  }
  if (stored.status === 'corrupt') {
    // 损坏时先备份原始串再按空队列处理（与 getLocalModelIndex 的做法一致）：
    // 直接覆盖是不可逆的，留一份副本至少给人工恢复留出机会。
    await backupCorruptValue(LOCAL_MODEL_QUEUE_KEY);
    return { status: 'corrupt', value: [] };
  }
  return { status: 'missing', value: [] };
}

// 兼容入口：只关心数组、不区分状态的调用方用。⚠️ 新代码请用
// readDownloadQueueStatus —— 拿不到「读失败」的信号就没法阻止 fail-open 写回。
export async function readDownloadQueue() {
  const stored = await readDownloadQueueStatus();
  return stored.value;
}

export async function writeDownloadQueue(tasks) {
  await AsyncStorage.setItem(LOCAL_MODEL_QUEUE_KEY, JSON.stringify(Array.isArray(tasks) ? tasks : []));
}
