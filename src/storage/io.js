// AsyncStorage I/O 原语与含密钥配置的读写包装。从 src/storage.js 原样外提（无行为变化）。
// 拆出的目的是让各领域存储模块（characters/sessions/...）复用同一套读写与损坏备份逻辑。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { collectSecretRefIdsFromValue, deleteSecretsByIds, hydrateSecrets, protectSecrets } from './secretStore.js';
import { recordDiagnostic } from './diagnostics.js';
import { tActive } from '../i18n/index.js';

export const CORRUPT_BACKUP_SUFFIX = '__corrupt_backup';

// 序列化后的 UTF-8 字节数。角色卡与制卡草稿都按「超过阈值则落文件」处理，共用此纯函数。
// 实现已抽到 utils/byteLength.js（此前在四处各写一份）；这里 import + re-export 保持既有引用面不变。
import { utf8ByteLength } from '../utils/byteLength.js';

export { utf8ByteLength };

// 单值体积预算。Android 的 CursorWindow 单值读取上限约 2MB：超过之后 AsyncStorage.getItem
// 直接抛错，只能靠 readLargeAsyncStorageValue 的 SQLite 分块兜底——那条兜底是「聊天记录
// 永久读不出」的最后防线，不该被当成常规路径。所以任何一次**写入**越过预算都要留痕。
//
// 为什么只报警不抛：历史数据、一次性导入、用户自己写的大角色卡都可能本来就大；
// 在这里抛出去会把「能存进去」变成「存不进去」，比超标本身更糟。
// 这是**系统性防线**：它不修数据、不改行为，只保证「什么时候越过了预算」有据可查。
export const VALUE_BUDGET_BYTES = Math.round(1.5 * 1024 * 1024);

// 返回实际字节数（供调用方复用）；超预算时记一条诊断。
export function assertValueBudget(key, json) {
  const bytes = utf8ByteLength(json);
  if (bytes <= VALUE_BUDGET_BYTES) return bytes;
  recordDiagnostic(
    'storage',
    new Error(tActive('error.storage.valueBudgetExceeded')),
    `${key}：${bytes} 字节 > 预算 ${VALUE_BUDGET_BYTES}`
  );
  return bytes;
}

export async function readJson(key, fallback) {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

// 含密钥的配置统一走这两个入口：写盘前把密钥搬进安全存储并落引用，
// 读盘后把引用回填为明文。命名空间用存储键，保证同一字段位置稳定。
export async function setJsonWithSecrets(key, payload) {
  // 回收孤儿密钥：先把旧值里引用的密钥 id 记下来，写盘后删掉「不再被引用」的那些。
  // 否则删除 API 配置 / 清凭据 / 备份 replace 后，Keystore 里的旧密钥会永久残留。
  const previousRaw = await AsyncStorage.getItem(key).catch(() => null);
  const protectedPayload = await protectSecrets(key, payload);
  const json = JSON.stringify(protectedPayload);
  assertValueBudget(key, json);
  await AsyncStorage.setItem(key, json);
  if (previousRaw) {
    try {
      const before = collectSecretRefIdsFromValue(JSON.parse(previousRaw));
      if (before.size > 0) {
        const after = collectSecretRefIdsFromValue(protectedPayload);
        const orphans = [...before].filter(id => !after.has(id));
        if (orphans.length > 0) await deleteSecretsByIds(orphans);
      }
    } catch (error) {
      // 旧值损坏或解析失败：跳过回收，不影响本次写入。
    }
  }
}

// 明确**不含密钥**的内部数据（如「图片识别」的结果缓存：只有模型产出的描述文本，
// 没有任何凭据）。为什么需要单独一个入口：setJsonWithSecrets 会先跑一遍
// protectSecrets（按字段名白名单找密钥）——对纯派生数据是白跑，而且一旦将来有人
// 往缓存里塞了同名字段，会被悄悄搬进安全存储（那边有 2048 字节单值上限）。
// 体积预算的登记保持一致：派生数据同样不该悄悄把存储键顶到 CursorWindow 上限。
// 判据是「调用方保证无密钥」，所以只允许存储层内部/派生数据使用。
export async function setJsonRaw(key, payload) {
  const json = JSON.stringify(payload);
  assertValueBudget(key, json);
  await AsyncStorage.setItem(key, json);
}

export async function readJsonWithSecrets(key, fallback) {
  const value = await readJson(key, fallback);
  return hydrateSecrets(key, value);
}

export async function readJsonStatusWithSecrets(key) {
  const stored = await readJsonStatus(key);
  if (stored.status !== 'ok') return stored;
  return { status: 'ok', value: await hydrateSecrets(key, stored.value) };
}

let sqliteModule;
export function getSqliteModule() {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = require('expo-sqlite');
  } catch (error) {
    sqliteModule = null;
  }
  return sqliteModule;
}

// 大值兜底读取：AsyncStorage 的 getItem 在 Android 上受 CursorWindow 单值读取上限（约 2MB）
// 限制，超限会抛错。这里直接读底下的 SQLite（RKStorage）分块取回原始串，是「聊天记录
// 永久读不出」的最后一道防线。
//
// 失败**必须留痕**：本函数返回 null 时，调用方（readJsonStatus）只能把键判成「真读不出」，
// 用户看到的是「聊天记录读取失败」，而此前这里一路静默 return null——诊断里什么都没有，
// 用户与开发者都无从判断是数据没了、还是兜底路径坏了。所以每个「不是没有这条数据，
// 而是读失败了」的分支都记一条诊断。
export async function readLargeAsyncStorageValue(key) {
  const SQLite = getSqliteModule();
  if (!SQLite || typeof SQLite.openDatabase !== 'function') {
    recordDiagnostic('storage', new Error(tActive('error.storage.largeValueFallbackUnavailable')), key);
    return null;
  }
  const source = `${FileSystem.documentDirectory || ''}../databases/RKStorage`;
  try {
    const info = await FileSystem.getInfoAsync(source);
    // 文件不存在 = 这条键本就不在（AsyncStorage 在 Android 上就是这张表）：不算失败，不记诊断。
    if (!info || !info.exists) return null;
  } catch (error) {
    recordDiagnostic('storage', error, `大值兜底读取：无法访问 ${source}（${key}）`);
    return null;
  }
  let database = null;
  try {
    database = SQLite.openDatabase('../../databases/RKStorage');
    const lengthResult = await database.execAsync([{
      sql: 'SELECT length(value) AS total FROM catalystLocalStorage WHERE key = ?',
      args: [key],
    }], true);
    const total = Number(lengthResult?.[0]?.rows?.[0]?.total);
    // 没有这一行 = 键不存在（正常），不记诊断。
    if (!Number.isFinite(total) || total <= 0) return null;
    const chunkSize = 256 * 1024;
    let value = '';
    for (let offset = 0; offset < total; offset += chunkSize) {
      const result = await database.execAsync([{
        sql: 'SELECT substr(value, ?, ?) AS chunk FROM catalystLocalStorage WHERE key = ?',
        args: [offset + 1, chunkSize, key],
      }], true);
      const chunk = result?.[0]?.rows?.[0]?.chunk;
      if (chunk == null) {
        // length 说有数据、substr 却拿不到：读**截断**了。静默返回 null 会让这条会话
        // 看起来「数据没了」，而其实只是这一次读坏了——必须留痕。
        recordDiagnostic('storage', new Error(tActive('error.storage.largeValueReadTruncated')), `${key} @${offset}/${total}`);
        return null;
      }
      value += String(chunk);
    }
    return value;
  } catch (error) {
    recordDiagnostic('storage', error, `大值兜底读取失败：${key}`);
    return null;
  } finally {
    if (database && typeof database.closeAsync === 'function') {
      try {
        await database.closeAsync();
      } catch (error) {}
    }
  }
}

// 读取键并区分三种结果：
// - ok：读到且 JSON 结构完好（value 为解析结果）；
// - missing：键不存在；
// - corrupt：getItem 抛错或 JSON.parse 失败，且大值兜底也救不回。
// corrupt 分支附带 raw（能拿到的原始字符串，拿不到为 undefined）：备份导出据此
// 把「读到了原始串但结构坏了」的键以原始形态抢救进备份，而不是静默丢弃。
export async function readJsonStatus(key) {
  let raw;
  try {
    raw = await AsyncStorage.getItem(key);
    if (raw === null || raw === undefined) return { status: 'missing' };
    return { status: 'ok', value: JSON.parse(raw) };
  } catch (error) {
    const recovered = await readLargeAsyncStorageValue(key);
    if (recovered !== null) {
      try {
        return { status: 'ok', value: JSON.parse(recovered) };
      } catch (parseError) {}
      return { status: 'corrupt', raw: recovered };
    }
    // getItem 抛错（如 CursorWindow 2MB 读取上限）且分块兜底也读不回：
    // 连原始串都拿不到，返回 undefined 让调用方归入「真读不出」。
    return { status: 'corrupt', raw: typeof raw === 'string' ? raw : undefined };
  }
}

// 存储损坏时先把原始内容另存一份再重建：直接用默认值覆盖是不可逆的，
// 留一份副本至少给用户（或后续版本）留下人工恢复的机会。
export async function backupCorruptValue(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return false;
    await AsyncStorage.setItem(`${key}${CORRUPT_BACKUP_SUFFIX}`, raw);
    recordDiagnostic('storage', new Error(tActive('error.storage.readCorruptBackedUp')), key);
    // __DEV__ 是 Metro 全局，纯 Node 测试环境不存在：直接引用会抛 ReferenceError
    // 落进下方 catch，把已成功的备份误记成「备份失败」。
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(`[storage] ${key} 读取失败或结构异常，已备份到 ${key}${CORRUPT_BACKUP_SUFFIX}`);
    }
    return true;
  } catch (error) {
    recordDiagnostic('storage', error, `损坏数据备份失败：${key}`);
    if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn(`[storage] ${key} 损坏数据备份失败`, error);
    return false;
  }
}

// 存储写入串行化工厂：把同一逻辑域的写操作排进一条 promise 链，前一个无论
// 成功失败都继续执行下一个（`.then(task, task)`）。返回的 enqueue 与各域原本
// 手写的 enqueueXxxMutation 行为一致，便于统一收编，且零行为变化。
//
// - enqueue(task)：单队列（sessionCore/moments/diary/worldMap/cardForge/stickers 等）。
// - enqueue(task, key)：按 key 分桶，每个 key 独立一条队列（如 vector 按角色分）。
// - settle()：返回当前挂起写入全部落定的 promise，供外部读取前排空（迁移/刷新协调）。
export function createMutationQueue() {
  let single = Promise.resolve();
  const buckets = new Map();
  return {
    enqueue(task, key = '') {
      const bucket = String(key || '');
      const tail = bucket ? (buckets.get(bucket) || Promise.resolve()) : single;
      const next = tail.then(task, task);
      if (bucket) buckets.set(bucket, next.catch(() => {}));
      else single = next.catch(() => {});
      return next;
    },
    settle() {
      const tails = [single, ...buckets.values()];
      return Promise.all(tails.map(tail => tail.catch(() => {}))).then(() => undefined);
    },
  };
}
