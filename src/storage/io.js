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

// 本仓库用的 expo-sqlite 是 v16：**没有** `openDatabase` / `execAsync([{sql,args}], true)`
// 那套 v13 时代的旧 API。v16 的入口是 `openDatabaseSync` / `openDatabaseAsync`，
// 查询走 `getFirstAsync(sql, params)`。
//
// 这一处曾经写错，后果不是「兜底失败」而是「兜底从未存在」：真机日志里反复出现
// 「大值兜底读取不可用（缺少 SQLite 模块）」——模块明明装着，只是判据查了一个不存在的
// 函数名。于是一旦某个键超过 CursorWindow 的 ~2MB 单值上限，readJsonStatus 只能判
// corrupt，用户的会话/草稿/角色卡就被判成「读不出」。判据必须对着**真实的导出名**，
// 而不是记忆里的旧名字（同型病灶见 storage/diagnostics.js 的 maskSecrets 惰性 require）。
//
// 返回一个统一的窄接口 { open(), close(db) }，把「同步打开还是异步打开」的差异收在这里，
// 调用方（readLargeAsyncStorageValue）只面对一种形态。
const SQLITE_OPEN_SYNC = 'openDatabaseSync';
const SQLITE_OPEN_ASYNC = 'openDatabaseAsync';

export function resolveSqliteOpener(module) {
  const SQLite = module && typeof module === 'object' ? module : null;
  if (!SQLite) return null;
  if (typeof SQLite[SQLITE_OPEN_SYNC] === 'function') return SQLITE_OPEN_SYNC;
  if (typeof SQLite[SQLITE_OPEN_ASYNC] === 'function') return SQLITE_OPEN_ASYNC;
  return null;
}

// AsyncStorage 的库目录（`<pkg>/databases/`），**不含 '..'**。
//
// documentDirectory 在 Android 上是 `<pkg>/files/`，去掉最后一段（files）即得包目录，
// 再拼 `databases/`。这样得到的串与 expo-sqlite 的 createDatabasePath 拼出来的完全同构，
// 存在性检查与打开指向**同一个文件**（见 readLargeAsyncStorageValue 里的 P1 注释）。
//
// 推导不出来（documentDirectory 为空/形状意外）时返回 ''，由调用方如实记诊断并放弃——
// 不猜路径：猜错会去开一个空库，那正是 fef85db 的问题。
export function databasesDirectoryFromDocument() {
  const doc = String(FileSystem.documentDirectory || '');
  if (!doc) return '';
  // 去掉末尾最后一段（如 'files/'）：`[^/]+\/*$`
  const parent = doc.replace(/[^/]+\/*$/, '');
  if (!parent || parent === doc) return '';
  // parent 一定以 '/' 结尾（正则保留了它前面的斜杠）；保险起见补一个。
  return parent.endsWith('/') ? `${parent}databases/` : `${parent}/databases/`;
}

// 关掉并删除「我们刚刚误建的空库」。
//
// 背景：expo-sqlite 的 openDatabase 对不存在的库会**新建**（原生 ensureDatabasePathExists
// 会建目录并创建文件），而原生不支持 readonly（SQLiteOptions.kt 核实过），
// 所以「打开一个不存在的库」这个动作本身就会留下一个空壳文件。
// 归纳成不变量：**只有当打开前判定库不存在、且打开后确认没有目标表时**，才删除它。
// 判定为存在时绝不删（那可能是真数据损坏，删了等于销毁证据）。
//
// 删除用 expo-sqlite 自己的 deleteDatabase*（它按同样的 directory 规则定位文件），
// 失败只记诊断、绝不影响主流程——清理是尽力而为。
async function dropEmptyDatabaseQuietly(SQLite, database, databaseName, databaseDirectory, key) {
  try {
    if (database && typeof database.closeAsync === 'function') {
      await database.closeAsync();
    }
  } catch (error) {}
  try {
    if (typeof SQLite.deleteDatabaseSync === 'function') {
      SQLite.deleteDatabaseSync(databaseName, databaseDirectory);
    } else if (typeof SQLite.deleteDatabaseAsync === 'function') {
      await SQLite.deleteDatabaseAsync(databaseName, databaseDirectory);
    }
  } catch (error) {
    recordDiagnostic(
      'storage',
      error,
      `大值兜底：清理误建的空库失败（${databaseDirectory}${databaseName}｜${key}）`
    );
  }
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
  const opener = resolveSqliteOpener(SQLite);
  if (!opener) {
    recordDiagnostic('storage', new Error(tActive('error.storage.largeValueFallbackUnavailable')), key);
    return null;
  }
  // AsyncStorage（v2.2.0，未启用 useNextStorage）的库是
  // /data/user/0/<pkg>/databases/RKStorage，表 catalystLocalStorage。
  //
  // ⚠️ 打开方式（fef85db 在这里错了，导致大值兜底第二次失效）：
  // expo-sqlite v16 的 openDatabase*(databaseName, options, directory) 是**两段拼**：
  //     createDatabasePath(name, dir) = `${dir 去尾斜杠}/${name 去前导斜杠}`
  // （node_modules/expo-sqlite/build/pathUtils.js，逐行核实）；
  // 而 defaultDatabaseDirectory = `filesDir/SQLite`
  // （SQLiteModule.kt: Constant("defaultDatabaseDirectory") { filesDir.canonicalPath + "/SQLite" }）。
  //
  // 所以此前传 '../databases/RKStorage' 会被拼成
  //     filesDir/SQLite/../databases/RKStorage  =  filesDir/databases/RKStorage
  // ——那是**另一个库**：不存在时 SQLite 会按默认 flags **新建空库**，于是查询报
  // 「no such table: catalystLocalStorage」（正是用户日志里每次启动都出现的那条）。
  //
  // 正解：用第三参 **directory 指向真库所在目录**，name 只给纯文件名，
  // 路径里不再有 '..' 参与拼接：
  //     createDatabasePath('RKStorage', '<pkg>/databases/') = '<pkg>/databases/RKStorage'
  //
  // ⚠️ 存在性检查与打开必须用**同一个、都不含 '..' 的路径**（P1 修正）：
  // 两条路对 '..' 的处理方式**不一致**——
  //   · getInfoAsync 落到 File(path).exists()，由内核解析 '..'（能解析）；
  //   · createDatabasePath 只是字符串拼接，**不解析** '..'。
  // 所以「检查用带 .. 的串、打开用去 .. 的串」是靠碰巧对上的；任一端行为一变就会
  // 「检查以为不存在 → return null → 兜底静默失效，新写法根本没机会执行」。
  // 现在两者由同一个 databaseDirectory 派生，结构上必然一致。
  const databaseDirectory = databasesDirectoryFromDocument();
  const databaseName = 'RKStorage';
  const source = databaseDirectory ? `${databaseDirectory}${databaseName}` : '';
  if (!source) {
    recordDiagnostic('storage', new Error(tActive('error.storage.largeValueFallbackUnavailable')), key);
    return null;
  }
  // 存在性检查：**只用于留痕与「库确实不存在」的判定，不再用它决定是否继续**。
  //
  // 为什么改（真机 2026-10-20：用户角色卡 11.79MB 却读不出，且日志里一条兜底记录都没有）：
  // 旧写法 `if (!info.exists) return null;` 把两种完全不同的情况合并成同一个静默分支：
  //   ① 库真的不存在（AsyncStorage 还没建过库）——正常，可以不记；
  //   ② **库访问不到**（权限判定拒绝 / getInfoAsync 抛错）——异常，必须记。
  // 结果 ② 被当作 ① 静默吞掉，大值兜底就这样失效了，而且日志里毫无痕迹。
  //
  // 一手依据（expo-modules-core 的 FilePermissionModule.kt，逐行读过）：
  //   getInternalPaths(context) = listOf(context.filesDir, context.cacheDir)
  // ——**只有 files/ 与 cache/**。AsyncStorage 的真库在 `<pkg>/databases/RKStorage`，
  // 不在这个白名单里；它会回退到 getExternalPathPermissions（看 File.canRead()），
  // 能否通过取决于机型与系统版本。也就是说这条存在性检查**本身就不可靠**。
  //
  // 现在：检查结果只写进诊断（便于下次定位），**不再作为「跳过」的理由**——
  // 真正的判定交给 SQLite 自己（它直接按路径开文件，没有这层白名单）。
  let libraryExists = null;
  try {
    const info = await FileSystem.getInfoAsync(source);
    libraryExists = !!(info && info.exists);
    if (!libraryExists) {
      // 可能是「真的没有库」，也可能是「权限判定拒绝」。两种都记一条（含路径），
      // 但**继续往下试**——让 SQLite 给出权威答案。
      recordDiagnostic(
        'storage',
        new Error(tActive('error.storage.largeValueLibraryUnreadable')),
        `${key}（getInfoAsync 报告不存在：${source}）`
      );
    }
  } catch (error) {
    recordDiagnostic(
      'storage',
      error,
      `大值兜底：存在性检查抛错，仍将尝试直接打开（${source}｜${key}）`
    );
  }

  let database = null;
  try {
    // ⚠️ 打开时**必须传 directory**（见上方注释）：只给 name 会落到 filesDir/SQLite 下。
    //
    // 不传 readonly：**原生端根本不支持**（SQLiteOptions.kt 的 OpenDatabaseOptions 只有
    // enableChangeListener / useNewConnection / finalizeUnusedStatementsBeforeClosing /
    // libSQL* 六项，逐一核实过）。传了会被静默忽略——那比不传更糟，因为代码读起来
    // 像是有保护。
    database = opener === SQLITE_OPEN_SYNC
      ? SQLite.openDatabaseSync(databaseName, undefined, databaseDirectory)
      : await SQLite.openDatabaseAsync(databaseName, undefined, databaseDirectory);
    // 先验表：表不存在说明「AsyncStorage 后端已换」（例如启用了 useNextStorage），
    // 或者刚才那次 open 把**不存在的库新建成了空库**（原生 ensureDirExists + open 的副作用）。
    // PRAGMA 无行 ⇒ 如实记诊断、关库；若是我们刚建出来的空库，顺手删掉。
    const tableInfo = await database.getAllAsync('PRAGMA table_info(catalystLocalStorage)');
    if (!Array.isArray(tableInfo) || tableInfo.length === 0) {
      recordDiagnostic(
        'storage',
        new Error(tActive('error.storage.largeValueTableMissing')),
        `${key}（${databaseDirectory}${databaseName}｜检查报告存在=${String(libraryExists)}）`
      );
      // 只在「打开前判定不存在」时才删：那种情况下这个文件**是我们刚建出来的空壳**，
      // 留着既污染存储目录，又会让下次的存在性检查误以为库真有内容。
      // 判定为存在时绝不删——那可能是真的数据被损坏，删了等于销毁证据。
      if (libraryExists === false) {
        await dropEmptyDatabaseQuietly(SQLite, database, databaseName, databaseDirectory, key);
        database = null; // 已被 close，finally 不再重复关
      }
      return null;
    }
    // v16：getFirstAsync(sql, params) 直接返回首行对象（v13 的 execAsync([...], true) 已不存在）。
    const lengthRow = await database.getFirstAsync(
      'SELECT length(value) AS total FROM catalystLocalStorage WHERE key = ?',
      [key]
    );
    const total = Number(lengthRow && lengthRow.total);
    // 没有这一行 = 键不存在（正常），不记诊断。
    if (!Number.isFinite(total) || total <= 0) return null;
    const chunkSize = 256 * 1024;
    let value = '';
    for (let offset = 0; offset < total; offset += chunkSize) {
      const chunkRow = await database.getFirstAsync(
        'SELECT substr(value, ?, ?) AS chunk FROM catalystLocalStorage WHERE key = ?',
        [offset + 1, chunkSize, key]
      );
      const chunk = chunkRow && chunkRow.chunk;
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
