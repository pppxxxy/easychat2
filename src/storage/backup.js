// 全量备份恢复编排：使用现有 AsyncStorage/FileSystem 与大值读取边界。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';

import {
  BACKUP_MAX_BYTES,
  BACKUP_MEDIA_DIRECTORIES,
  BACKUP_MODE_QUICK,
  QUICK_MEDIA_DIRECTORIES,
  buildBackupPayload,
  collectLockSecretIds,
  isQuickExportKey,
  planBackupImport,
  scanSecretRefs,
} from './dataBackup.js';
import { recordDiagnostic } from './diagnostics.js';
import { tActive } from '../i18n/index.js';
import { readJsonStatus, readLargeAsyncStorageValue } from './io.js';
import { readSecureValue, removeSecureValue, writeSecureValue } from './secretStore.js';
import { createBackupChunkGenerator } from './backupStream.js';

const MANAGED_PREFIX = '@easychat2_';
const CORRUPT_SUFFIX = '__corrupt_backup';

// 媒体目录清单：**唯一权威是 dataBackup.js 的 BACKUP_MEDIA_DIRECTORIES**，这里只
// re-export 同一个对象（不是副本、不是第二份字面量数组）。
// 为什么必须只有一份：打包（buildBackupPayload）与导入校验（validateBackupPayload）都
// 用 dataBackup.js 那份白名单，而本文件历史上另手写了一份；两份漂移后 `music`/`books`
// 被 isAllowedMediaPath 静默过滤——用户的音乐库与书籍不进备份，恢复时才发现，且不可逆。
// 新增/移除媒体目录请**只改 dataBackup.js**：那里逐项注明产出方模块与常量，并写明
// 刻意排除的目录（screen-watch/、local-models/、.transcripts/、workspace/）及各自理由。
// tests/storageBackup.test.mjs 断言两边是同一个对象，并逐条比对产出方常量。
export { BACKUP_MEDIA_DIRECTORIES };

function createAbortError() {
  const error = new Error('导出已取消');
  error.name = 'AbortError';
  error.canceled = true;
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw createAbortError();
}

// 我们自己写的、面向用户的错误（文案走 i18n）：打上 userFacing 标记，UI 才会在**发布构建**里
// 原样透出。其余错误（AsyncStorage / JSON 的内部英文文案）由 BackupPanel 只在 __DEV__ 显示
// ——见 BackupPanel 的 userMessage。
function userFacingError(message) {
  const error = new Error(message);
  error.userFacing = true;
  return error;
}

async function readRawValue(key) {
  // readJsonStatus 在 getItem 抛错或 JSON.parse 失败时已经调用过
  // readLargeAsyncStorageValue 兜底读取；这里再读一次是重复的昂贵 SQLite 全值读取。
  const status = await readJsonStatus(key);
  if (status.status === 'ok') return { value: status.value };
  // 结构损坏但拿到了原始串：交给导出侧以 opaqueRaw 抢救，避免静默丢弃。
  if (status.status === 'corrupt' && typeof status.raw === 'string') {
    return { opaqueRaw: status.raw };
  }
  return {};
}

async function readRawStorageString(key) {
  try {
    return await AsyncStorage.getItem(key);
  } catch (error) {
    const recovered = await readLargeAsyncStorageValue(key);
    if (recovered !== null) return recovered;
    throw userFacingError(tActive('error.backup.restoreReadFailed', { key }));
  }
}

async function snapshotStorageKeys(keys) {
  const snapshot = [];
  for (const key of keys) {
    const raw = await readRawStorageString(key);
    snapshot.push({ key, raw, exists: raw !== null && raw !== undefined });
  }
  return snapshot;
}

async function snapshotMediaFiles(items) {
  const snapshot = [];
  for (const item of items) {
    const uri = `${FileSystem.documentDirectory}${item.path}`;
    const info = await FileSystem.getInfoAsync(uri);
    let base64 = null;
    if (info && info.exists && !info.isDirectory) {
      base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }
    snapshot.push({ path: item.path, uri, exists: Boolean(base64 !== null), base64 });
  }
  return snapshot;
}

// 回滚也并发：失败时用户已经很不爽了，没必要再串行等上百次往返。
// 每个 key / path 独立，setItem / removeItem / 写文件都是单目标操作，无顺序依赖。
async function rollbackStorage(snapshot) {
  await runWithConcurrency(snapshot, IMPORT_WRITE_CONCURRENCY, async item => {
    if (item.exists) await AsyncStorage.setItem(item.key, item.raw);
    else await AsyncStorage.removeItem(item.key);
  });
}

// 导入写盘的**受限并发**执行器。
//
// 为什么需要（用户实测 2026-10-19）：115MB 备份「导入成功，但好慢好慢」。
// 实测把慢拆开看（Node 基准，V8）：
//   · JSON.parse 整个 115MB 包        ≈ 86ms
//   · 47 个媒体 base64 解码           ≈ 38ms
//   合计 ≈ 124ms —— 解析根本不是瓶颈。
// 真正慢的是**逐条串行 await**：每个媒体文件一次 makeDirectoryAsync + 一次
// writeAsStringAsync，每个存储键一次 setItem，全部一条一条排队。115MB 的包意味着
// 上百次原生往返，每次都要等上一次完成。
//
// 并发化是安全的，因为这三类写**互不依赖**：
//   · 存储键：每个 key 独立，setItem 是覆盖语义；
//   · 媒体文件：每个 path 独立，且目录创建幂等（intermediates: true）；
//   · 回滚：同样是独立键/独立文件。
// 顺序语义也没有变：同一个 key/path 在包里只出现一次（planBackupImport 已按 key 去重）。
//
// 并发度取 4 而不是无限：Android 的 AsyncStorage 与文件系统对**单个进程**的并发
// 写入并没有收益（底层是同一批 IO 线程），开太大只会让失败时的错误更难归因。
// 4 已足够把「上百次串行往返」压成「几十批」。
export const IMPORT_WRITE_CONCURRENCY = 4;

// 媒体**读取**并发度（导出侧）。
//
// 与写入的 4 不同，读的并发可以更高一些：每次只是「列目录 / 取 stat / 读文件」，
// 没有写冲突，底层 AsyncStorage 与文件系统都能同时处理多个读请求。
// 但也不能无限开——每个在飞的文件都会占一份 base64 内存（角色卡单张可达数 MB），
// 并发太高会让「峰值内存」重新变成问题（那正是上一批刚修掉的）。
// 6 是在「明显减少排队」与「峰值内存可控」之间的取值：实测读取往返占比高，
// 6 路已能把几千个文件的等待时间压掉约 5/6。
export const MEDIA_READ_CONCURRENCY = 6;

// 按 items 顺序分批并发执行 task。**任一失败即整体失败**（与串行语义一致：
// 串行时第一个失败就会抛出，后面的不再执行）——但已在飞行的任务会跑完，
// 调用方随后回滚，回滚覆盖的是全部快照，不依赖"哪些已经写成功"。
async function runWithConcurrency(items, limit, task) {
  const list = Array.isArray(items) ? items : [];
  const size = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 1;
  let index = 0;
  let failure = null;
  const worker = async () => {
    while (true) {
      if (failure) return; // 已有人失败：不再领取新任务
      const current = index;
      index += 1;
      if (current >= list.length) return;
      try {
        await task(list[current], current);
      } catch (error) {
        if (!failure) failure = error;
        return;
      }
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(size, list.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  if (failure) throw failure;
}

async function rollbackMedia(snapshot) {
  await runWithConcurrency(snapshot, IMPORT_WRITE_CONCURRENCY, async item => {
    if (item.exists) {
      const parent = item.uri.slice(0, item.uri.lastIndexOf('/'));
      await FileSystem.makeDirectoryAsync(`${parent}/`, { intermediates: true });
      await FileSystem.writeAsStringAsync(item.uri, item.base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    } else {
      await FileSystem.deleteAsync(item.uri, { idempotent: true });
    }
  });
}

// 密钥快照/回滚：保险箱也必须进回滚集合。
// 读取失败（原生安全存储不可用）记 unreadable——回滚时跳过并留诊断，而不是让
// 「回滚失败」把原始错误盖掉。
async function snapshotSecrets(items) {
  const snapshot = [];
  for (const item of items) {
    try {
      const value = await readSecureValue(item.id);
      const exists = typeof value === 'string' && value.length > 0;
      snapshot.push({ id: item.id, value: exists ? value : null, exists, unreadable: false });
    } catch (error) {
      snapshot.push({ id: item.id, value: null, exists: false, unreadable: true });
    }
  }
  return snapshot;
}

async function rollbackSecrets(snapshot, writtenIds) {
  const written = new Set(writtenIds);
  for (const item of snapshot) {
    if (!written.has(item.id)) continue;
    if (item.unreadable) {
      recordDiagnostic('secrets', new Error('secrets rollback skipped'), `importBackup 密钥回滚跳过（旧值不可读）：${item.id}`);
      continue;
    }
    if (item.exists) await writeSecureValue(item.id, item.value);
    else await removeSecureValue(item.id);
  }
}

// 媒体目录递归收集：**同层并发读**，但结果顺序与串行版本**完全一致**。
//
// 为什么并发（真机反馈 2026-10-19「备份导致发烫」的第三个成因）：
// 旧实现是 `for (name of entries) { await getInfoAsync; await readAsStringAsync }`
// —— 每个文件两次原生往返，且**严格串行**：N 个文件 = 2N 次「等上一次完成」。
// 角色卡多的用户有几千张图，这些往返排成一条队，CPU 大部分时间在等 IO
// （表现为耗时长、机身发热），而不是在算。
//
// 为什么保序（不能只图快）：dataBackup.test.mjs 明确断言
// `payload.media.map(path)` 与输入顺序一致；备份包内容也应可复现（同一份数据
// 两次导出得到同样的字节序，便于比对排错）。所以**按索引写回**：并发只影响
// 「谁先读完」，不影响「结果放在第几位」。
//
// 语义保持：取消在每任务开始前检查 signal；读不出的文件进 failed（不中断整体，
// 与串行版一致）；onFile 每成功读出一个文件回调一次。
async function collectMedia(directory, prefix = '', hooks = {}) {
  const root = `${FileSystem.documentDirectory || ''}${directory}/`;
  let entries = [];
  try {
    entries = await FileSystem.readDirectoryAsync(`${root}${prefix}`);
  } catch (error) {
    return { items: [], failed: [] };
  }
  const list = Array.isArray(entries) ? entries : [];
  const slots = new Array(list.length);
  await runWithConcurrency(list, MEDIA_READ_CONCURRENCY, async (name, index) => {
    if (hooks.signal && hooks.signal.aborted) throw createAbortError();
    const relative = `${prefix}${name}`;
    const uri = `${root}${relative}`;
    let info;
    try {
      info = await FileSystem.getInfoAsync(uri);
    } catch (error) {
      // 与串行版一致：getInfoAsync 抛错时该条目算「读不出」，不影响其它文件。
      slots[index] = { items: [], failed: [`${directory}/${relative}`] };
      return;
    }
    if (info && info.isDirectory) {
      slots[index] = await collectMedia(directory, `${relative}/`, hooks);
      return;
    }
    try {
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      slots[index] = { items: [{ path: `${directory}/${relative}`, base64 }], failed: [] };
    } catch (error) {
      slots[index] = { items: [], failed: [`${directory}/${relative}`] };
    }
    if (typeof hooks.onFile === 'function') hooks.onFile();
  });
  // 按槽位顺序展开：并发不改变结果顺序。
  const items = [];
  const failed = [];
  for (const slot of slots) {
    if (!slot) continue;
    items.push(...slot.items);
    failed.push(...slot.failed);
  }
  return { items, failed };
}

// 合并（取长补短）：directory/fileName 来自「自动备份」（写专用子目录、固定文件名），
// mode/includeSecrets 来自「导出范围」（完整/快速 + 可选包含密钥）。四者互不相干、
// 都是可选参数，缺省时行为与原来的手动导出完全一致。
export async function exportBackup({
  appVersion = '',
  onProgress,
  signal,
  directory = '',
  fileName = '',
  mode = 'full',
  includeSecrets = false,
} = {}) {
  const report = (phase, done, total) => {
    if (typeof onProgress === 'function') {
      try {
        onProgress({ phase, done, total });
      } catch (error) {}
    }
  };
  const quick = mode === BACKUP_MODE_QUICK;
  throwIfAborted(signal);
  const keys = await AsyncStorage.getAllKeys();
  const managedKeys = keys.filter(item => item.startsWith(MANAGED_PREFIX) && !item.endsWith(CORRUPT_SUFFIX));
  const baseKeys = quick ? managedKeys.filter(isQuickExportKey) : managedKeys;
  // 需要密钥时按全部键读取：引用可能藏在未导出的键里（如接口配置），只有读到才能
  // 判定「哪些键引用了密钥」，进而把它们一并导出，避免恢复后密钥成为孤儿。
  const readKeys = includeSecrets ? managedKeys : baseKeys;
  const storage = [];
  // 记录读不出的键：数据恰好损坏时最需要备份，静默跳过会让用户拿到一份
  // “看起来成功、实则残缺”的备份。这里统计并回传给 UI 明确提示。
  //
  // 三态口径（P1）：
  // - storage：JSON 结构完好，正常入包；
  // - partialKeys：结构损坏但原始串拿得到，以 opaqueRaw 原样入包（数据不丢，
  //   应用内可能读不出，但恢复时逐字节还原）；
  // - unreadableKeys：真读不出（getItem 抛错 + 大值兜底也 null），只能跳过。
  const unreadableKeys = [];
  const partialKeys = [];
  const valuesByKey = new Map();
  report('storage', 0, readKeys.length);
  for (let index = 0; index < readKeys.length; index += 1) {
    throwIfAborted(signal);
    const key = readKeys[index];
    const read = await readRawValue(key);
    if (read.value !== undefined) {
      valuesByKey.set(key, { value: read.value });
    } else if (read.opaqueRaw !== undefined) {
      valuesByKey.set(key, { opaqueRaw: read.opaqueRaw });
    }
    report('storage', index + 1, readKeys.length);
  }
  // 决定最终导出键集合：基础集合 + （含密钥时）引用密钥的键与安全设置键。
  const exportKeys = new Set(baseKeys);
  let secrets = [];
  if (includeSecrets) {
    const scanEntries = [...valuesByKey.entries()].map(([key, entry]) => ({ key, ...entry }));
    const refs = scanSecretRefs(scanEntries);
    refs.keys.forEach(key => exportKeys.add(key));
    // 角色锁密码/提示直接落安全存储：导出安全设置键，锁的「上锁名单」才能一并恢复。
    exportKeys.add('@easychat2_security');
    const securityEntry = valuesByKey.get('@easychat2_security');
    const lockIds = collectLockSecretIds(securityEntry && securityEntry.value);
    const ids = [...new Set([...refs.ids, ...lockIds])];
    for (const id of ids) {
      throwIfAborted(signal);
      const value = await readSecureValue(id);
      if (value) secrets.push({ id, value });
    }
  }
  for (const key of exportKeys) {
    const entry = valuesByKey.get(key);
    if (!entry) continue;
    if (entry.value !== undefined) storage.push({ key, value: entry.value });
    else if (entry.opaqueRaw !== undefined) {
      storage.push({ key, opaqueRaw: entry.opaqueRaw });
      partialKeys.push(key);
    }
  }
  for (const key of baseKeys) {
    if (!valuesByKey.has(key)) unreadableKeys.push(key);
  }
  // 失败键名必须留痕：弹窗只显示数量、诊断日志此前完全没记录，用户无从排查
  // 是哪个键失败。这里把键名（去前缀前）写进诊断日志，供「诊断日志」回看。
  if (unreadableKeys.length > 0) {
    recordDiagnostic('storage', new Error(tActive('error.backup.exportUnreadable', {
      keys: unreadableKeys.join(', '),
    })), 'backup-export');
  } else if (partialKeys.length === 0) {
    // **成功也要留一条**（真机反馈 2026-10-20：用户手动备份成功、弹窗显示
    // 「已生成备份 191.99 MB」，但诊断日志里一条记录都没有，于是无法确认
    // 「是 0 个失败」还是「根本没跑」）。
    // 只在「零失败且零抢救」时记，避免与上面的失败诊断重复。
    // 记键数与「大值兜底」是否真的用上了（下面 media 收集完会补总量，这里先给存储侧）。
    recordDiagnostic(
      'log',
      { message: `[backup] 导出成功：${storage.length}/${baseKeys.length} 个数据键` },
      'backup-export'
    );
  }
  const media = [];
  const unreadableMedia = [];
  report('media', 0, 0);
  let mediaSeen = 0;
  // 目录清单见 dataBackup.js 的 BACKUP_MEDIA_DIRECTORIES（全仓唯一一份，新增目录只改那里）；
  // 快速模式另有一份更窄的 QUICK_MEDIA_DIRECTORIES，同样在 dataBackup.js。
  // screen-watch/ 刻意不登记：截图是临时运行文件（滚动保留 20 张自动清扫），不是用户创作
  // 内容；备份带上应用界面截图只有隐私暴露没有价值。评论文本在 AsyncStorage 键里随备份走，
  // 恢复后 imageUri 悬空不影响阅读。
  for (const directory of (quick ? QUICK_MEDIA_DIRECTORIES : BACKUP_MEDIA_DIRECTORIES)) {
    throwIfAborted(signal);
    const collected = await collectMedia(directory, '', {
      signal,
      onFile: () => {
        mediaSeen += 1;
        report('media', mediaSeen, 0);
      },
    });
    media.push(...collected.items);
    unreadableMedia.push(...collected.failed);
  }
  throwIfAborted(signal);
  report('packing', 0, 0);
  const payload = buildBackupPayload({ storage, media, appVersion, mode, secrets });
  // 打包层用 dataBackup.js 的 BACKUP_MEDIA_DIRECTORIES（isAllowedMediaPath）过滤内容，恢复侧
  // 校验也用同一份：两边现在是**同一个对象**（上面的 re-export），口径已不可能再漂移。
  // 这道「收集数 vs 入包数」的核对仍然保留，作为兜底——将来若有人把清单又拆成两份，被丢掉的
  // 文件会并进 unreadableMedia，让「备份不完整」在导出那一刻就可见，而不是等恢复时才发现
  // 「备份里没有我的书/音乐」（文案说的是「读取失败」，原因措辞略粗，但"文件没进备份"是真的）。
  const packedPaths = new Set(payload.media.map(item => item.path));
  for (const item of media) {
    if (!packedPaths.has(item.path)) unreadableMedia.push(item.path);
  }
  // 媒体侧的**成功**也要留痕（与上面存储侧同一条理由：零失败时日志空白，
  // 用户无法区分「0 个失败」与「根本没跑」）。
  if (unreadableMedia.length === 0) {
    recordDiagnostic(
      'log',
      { message: `[backup] 媒体收集完成：${media.length} 个文件，无读取失败` },
      'backup-export'
    );
  }
  // directory 缺省写 documentDirectory 根（手动导出）；自动备份传入专用子目录，
  // 与手动导出分开，避免「淘汰旧备份」误删用户手动导出的包。fileName 缺省用时间戳名。
  const baseDir = String(directory || FileSystem.documentDirectory || '');
  const dir = baseDir && !baseDir.endsWith('/') ? `${baseDir}/` : baseDir;
  const name = fileName || `easychat2-backup-${Date.now()}.json`;
  const uri = `${dir}${name}`;
  // 流式写盘：按片序列化 + 逐片写入，避免一次性构造巨型 JSON 串。
  // 打包/写盘阶段保持可取消，并持续上报 writing 进度（已写字节/总字节）。
  const bytes = await writeBackupStream(uri, payload, { signal, report });
  report('done', 1, 1);
  return {
    uri,
    payload,
    storageCount: storage.length,
    mediaCount: media.length,
    bytes,
    unreadableKeys,
    partialKeys,
    unreadableMedia,
    secretsCount: secrets.length,
    mode: quick ? BACKUP_MODE_QUICK : 'full',
    incomplete: unreadableKeys.length > 0 || unreadableMedia.length > 0 || partialKeys.length > 0,
  };
}

// 把 payload 流式写入 uri：分片序列化 → 逐片 writeBytes → 片间检查取消。
// 返回写入的总字节数（与一次性 JSON.stringify 的 UTF-8 字节数一致）。
async function writeBackupStream(uri, payload, { signal, report }) {
  const file = new File(uri);
  if (file.exists) file.delete();
  file.create({ intermediates: true, overwrite: true });
  const handle = file.open();
  let bytes = 0;
  let pieceCount = 0;
  const encoder = new TextEncoder();
  try {
    for (const chunk of createBackupChunkGenerator(payload)) {
      throwIfAborted(signal);
      const encoded = encoder.encode(chunk);
      handle.writeBytes(encoded);
      bytes += encoded.length;
      pieceCount += 1;
      if (bytes > BACKUP_MAX_BYTES) {
        throw userFacingError(tActive('error.backup.tooLarge', { mb: Math.round(BACKUP_MAX_BYTES / 1024 / 1024) }));
      }
      // 每片之后让出一次事件循环：写盘阶段不再独占主线程，取消能及时生效。
      if (pieceCount % 4 === 0) {
        report('writing', bytes, 0);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    report('writing', bytes, bytes);
    throwIfAborted(signal);
  } catch (error) {
    try {
      handle.close();
    } catch (closeError) {}
    try {
      if (file.exists) file.delete();
    } catch (deleteError) {}
    throw error;
  }
  handle.close();
  return bytes;
}

export async function importBackup(payload, mode = 'merge') {
  const plan = planBackupImport(payload, mode);
// plan.error 来自 validateBackupPayload（走 tActive 的用户文案）⇒ 标成 userFacing，
  // 发布构建里也要原样透出，而不是被换成笼统的「备份文件无法恢复」。
  if (!plan.valid) throw userFacingError(plan.error);
  // ── 纪律：**先读完所有快照，再开始任何写入** ────────────────────────────────
  // 三个快照（密钥/存储/媒体）全是只读操作，必须全部发生在第一次写之前。
  //
  // 为什么：此前 storage/media 快照在**密钥写回之后**、且在下面 try 之外取。于是
  // snapshotStorageKeys / snapshotMediaFiles 一旦抛错（实测：getInfoAsync 在媒体文件
  // 不可访问时抛 "[expo-file-system] getInfoAsync failed"），就会出现
  // **密钥已写进保险箱、数据一个字节没恢复、而且 catch 根本没进去 ⇒ 密钥不回滚**。
  // 那正是本函数下面注释里点名的错配：界面看着没变，请求却开始 401。
  // 顺序改成「读全 → 写全」后，快照失败 = 零副作用，不存在需要回滚的中间态。
  const secretsSnapshot = await snapshotSecrets(plan.secrets || []);
  const storageKeys = plan.storage
    .map(item => item.key)
    .filter(key => key.startsWith(MANAGED_PREFIX) && !key.endsWith(CORRUPT_SUFFIX));
  const storageSnapshot = await snapshotStorageKeys(storageKeys);
  const mediaSnapshot = await snapshotMediaFiles(plan.media);
  // 先写回密钥：数据里的 secure 引用随后即可解析到明文。单条失败不阻断数据恢复
  // （例如原生安全存储不可用），只记录数量回传。
  //
  // 但**密钥必须能回滚**：数据写入失败时 storage/media 会还原，密钥若不还原，就留下
  // 「数据回滚成原样、保险箱里却是备份包的 key」的错配——用户的 API Key 被悄悄顶掉，
  // 界面看起来没变，请求却开始 401（凭据问题，不是纯可用性问题）。所以写回前先快照旧值。
  const writtenSecretIds = [];
  let secretsCount = 0;
  let secretsFailed = 0;
  for (const item of plan.secrets || []) {
    try {
      await writeSecureValue(item.id, item.value);
      writtenSecretIds.push(item.id);
      secretsCount += 1;
    } catch (error) {
      secretsFailed += 1;
      recordDiagnostic('secrets', error, `importBackup 密钥写回失败：${item.id}`);
    }
  }
  let opaqueCount = 0;
  try {
    // 覆盖恢复**不做「先删后写」**（原实现在这里 multiRemove(storageKeys)）。
    // 为什么删掉整个破坏性阶段：storageKeys 就是下面逐键 setItem 的键集（validateBackupPayload
    // 已保证每个键都以 @easychat2_ 开头、不以 __corrupt_backup 结尾，:278-280 的过滤是恒等
    // 变换）⇒ 每个被 remove 的键随后都会被写回，multiRemove 对最终状态**零影响**，只制造
    // 「全部键消失、尚未写回」的窗口。该窗口内进程被杀（进入本函数前已 JSON.parse 整个包，
    // snapshotMediaFiles 又拷一份 base64，双份常驻 JS 堆，而 BACKUP_MAX_BYTES 允许 2GB）
    // ⇒ 这些键**永久为空**，而 :307-317 的回滚只覆盖抛错、不覆盖进程死亡。
    // setItem 本身就是覆盖语义：覆盖恢复的「替换备份管理范围内的数据」（需求 2.4）由
    // 「包内每个键都以备份内容为准」实现，包外的本机键（读取失败的、新版本新增的）保留
    // ——这正是原注释的口径，也是**不能**改成「删掉本地多出的键」的原因（那会删掉新版
    // 本新增键并让 App 不可用）。
    // 存储键与媒体文件都**并发写**（见 IMPORT_WRITE_CONCURRENCY 的实测理由）。
    // 语义不变：每个 key / path 在包里唯一，setItem 是覆盖语义，目录创建幂等。
    await runWithConcurrency(plan.storage, IMPORT_WRITE_CONCURRENCY, async item => {
      // opaqueRaw 条目是结构损坏时抢救下来的原始串：原样写回，不做 parse——
      // 它的价值恰恰在于「应用读不出但字节不丢」，重新序列化会再次损坏。
      if (typeof item.opaqueRaw === 'string') {
        await AsyncStorage.setItem(item.key, item.opaqueRaw);
        opaqueCount += 1;
      } else {
        await AsyncStorage.setItem(item.key, JSON.stringify(item.value));
      }
    });
    // 目录只需建一次（原先每个文件都调一次 makeDirectoryAsync——同一目录被重复创建
    // 上百次，纯属浪费原生往返）。按父目录去重后统一建，再并发写文件。
    const mediaDirectories = new Set();
    for (const item of plan.media) {
      const uri = `${FileSystem.documentDirectory}${item.path}`;
      mediaDirectories.add(`${uri.slice(0, uri.lastIndexOf('/'))}/`);
    }
    await runWithConcurrency([...mediaDirectories], IMPORT_WRITE_CONCURRENCY, async directory => {
      await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    });
    await runWithConcurrency(plan.media, IMPORT_WRITE_CONCURRENCY, async item => {
      const uri = `${FileSystem.documentDirectory}${item.path}`;
      await FileSystem.writeAsStringAsync(uri, item.base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    });
  } catch (error) {
    try {
      await rollbackStorage(storageSnapshot);
      await rollbackMedia(mediaSnapshot);
      await rollbackSecrets(secretsSnapshot, writtenSecretIds);
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    // 写入失败保留诊断记录，便于在「诊断日志」里回看失败现场（需求 3.5）。
    recordDiagnostic('storage', error, 'importBackup');
    throw error;
  }
  return {
    storageCount: plan.storage.length,
    mediaCount: plan.media.length,
    mode: plan.mode,
    opaqueCount,
    secretsCount,
    secretsFailed,
  };
}
