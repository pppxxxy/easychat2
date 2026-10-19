// 备份包的**读取**层：尺寸预检 + 策略选择 + 分片流式读。
//
// ── 为什么需要这个模块（真机实锤）──────────────────────────────────────────────
// 旧实现只有一行：`FileSystem.readAsStringAsync(uri)`（无参数 = 单发整读）。
// expo-file-system 的 legacy 实现在 Android 上必须把整个文件读进 Java 堆
// （`IOUtils.toString` → byte[] + String 双份），83MB 的包瞬时要占 250MB 上下，
// 超过应用 Java 堆就抛 OutOfMemoryError。而 Expo 54 bridgeless 的兼容层把它包成
// 通用拒绝文案，真实原因被吃掉 —— 用户只看到「备份文件无法恢复」。
//
// 现场：114MB 完整导出、83MB 快速导出**都**挂在同一句上 ⇒ 与导出模式/media 无关，
// 是纯体积问题。而导出侧是流式分片写（写 2GB 都稳）、BACKUP_MAX_BYTES 放行 2GB
// ⇒ **这个 app 能写出它自己读不回来的备份**。
//
// ── 与任务书的一处重要出入（已实测，见 .monkeycode/specs/FIX5R_核验.md）────────
// 任务书要求「用 legacy readAsStringAsync 的 position/length 选项 8MB 分片读」。
// 实测**本版本不可行**：该选项只在 `encoding: Base64` 时生效
//（FileSystem.types.ts:255-262 的注释 + FileSystemLegacyModule.kt:189-209 的实现），
// UTF-8 分支无条件 `IOUtils.toString(整文件)`，传 position/length 会被完全忽略
// —— 那样每次都把 83MB 再整读一遍，比单发更糟（N 倍内存 + N 倍 IO）。
//
// 改用真正能分片的 API：`new File(uri).open()` → `FileHandle.readBytes(n)` + `offset`
//（ExpoFileSystem.types.ts:353-377；Android 侧是 RandomAccessFile/FileChannel）。
// 分片必须配 **增量解码** `decoder.decode(bytes, { stream: true })`：否则跨片的多字节
// UTF-8 字符会被截断成 U+FFFD（仓库已有先例：src/agent/sdk.js:124 就是这么流的）。
//
// ── 诚实边界（不吹）──────────────────────────────────────────────────────────
// 分片读买到的是：① 不再把整文件额外拷进 Java 堆；② 片间可让出事件循环、可上报进度；
// ③ 失败可归因到具体片。它**不能**让峰值与文件大小无关 —— 最终仍要
// `JSON.parse(整个字符串)`，解析后的对象图通常比原文更占内存。要做到「2GB 级也不炸」，
// 必须换成 NDJSON 逐行流式解析（二期，本模块不做，也不假装做了）。

import { tActive } from '../i18n/index.js';
import { recordDiagnostic } from './diagnostics.js';

// 单发整读的上限：低于它直接读（省一次 open/close 与分片开销）。
// 16MB 的原文在 Java 堆里是 ~48MB 瞬时占用，远低于常见堆限，安全。
export const DIRECT_READ_MAX_BYTES = 16 * 1024 * 1024;

// 分片大小：兼顾 IPC 往返次数与单次阻塞时长。8MB ≈ 几十毫秒/片。
export const CHUNK_BYTES = 8 * 1024 * 1024;

// 导入体积上限（诚实上限）：超过它直接给明确文案，而不是「静默读到一半死」。
//
// ⚠️ 这个数字的含义要读准：它守的是**读取阶段**（本模块能控制的），不是端到端保证。
// 解析阶段的内存随 JSON 结构膨胀（base64 大字符串 + 对象开销），仍可能在低内存设备上
// 失败；那属于二期 NDJSON 流式解析要解决的问题。写 512MB 而不是 2GB（导出侧的上限），
// 正是因为「能写出」不等于「能读回」——上限不一致本身就是当初这个 bug 的成因之一。
export const IMPORT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * 纯决策：给定文件大小，选读取策略。**不碰 IO**，可 Node 直测。
 *
 * 返回 `{ strategy, reason, chunkCount }`：
 *   - `direct`   小文件单发整读；
 *   - `chunked`  大文件分片 + 增量解码；
 *   - `rejected` 超过诚实上限，不尝试（附 reason 供上层给明确文案）。
 */
export function decideReadStrategy(size, options = {}) {
  const directMax = Number(options.directMaxBytes) > 0 ? Number(options.directMaxBytes) : DIRECT_READ_MAX_BYTES;
  const importMax = Number(options.importMaxBytes) > 0 ? Number(options.importMaxBytes) : IMPORT_MAX_BYTES;
  const chunk = Number(options.chunkBytes) > 0 ? Number(options.chunkBytes) : CHUNK_BYTES;

  // 「尺寸未知」必须先于 Number() 判断：Number(null) === 0、Number('') === 0，
  // 直接转换会把「量不出来」静默当成「0 字节」——策略虽然同样是直读，
  // 但 `bytes: 0` 是假数据，会污染诊断日志（用户看到「size=0」会以为文件是空的）。
  const unknown = size === null || size === undefined || size === '';
  const bytes = unknown ? NaN : Number(size);

  // 尺寸未知/非法（老 API 或查询失败）：不能据此拒绝用户，退回单发读。
  // 宁可试一次（可能成功、可能抛错并被上层归因），也不要因为「量不出来」就拒绝恢复。
  if (!Number.isFinite(bytes) || bytes < 0) {
    return { strategy: 'direct', reason: 'size-unknown', chunkCount: 0, bytes: null };
  }
  if (bytes > importMax) {
    return { strategy: 'rejected', reason: 'too-large', chunkCount: 0, bytes };
  }
  if (bytes <= directMax) {
    return { strategy: 'direct', reason: 'small', chunkCount: 0, bytes };
  }
  return {
    strategy: 'chunked',
    reason: 'large',
    chunkCount: Math.ceil(bytes / chunk),
    bytes,
  };
}

// 用户可见的读取前置错误（打 userFacing 标记，发布构建里也透出原文）。
function readError(message) {
  const error = new Error(message);
  error.userFacing = true;
  return error;
}

export function formatMegabytes(bytes) {
  return Math.round(Number(bytes || 0) / 1024 / 1024);
}

/**
 * 读一个备份包的文本内容。**依赖注入**（legacyFs / nextFs / decode）以便 Node 直测：
 * 真实调用方传 expo-file-system 的两个入口，测试传假实现。
 *
 * @returns {{ text, bytes, strategy, chunkCount, elapsedMs }}
 */
export async function readBackupText({
  uri,
  legacyFs,
  nextFs = null,
  onProgress = null,
  chunkBytes = CHUNK_BYTES,
  directMaxBytes = DIRECT_READ_MAX_BYTES,
  importMaxBytes = IMPORT_MAX_BYTES,
  yieldToEventLoop = defaultYield,
} = {}) {
  const target = String(uri || '');
  if (!target) throw readError(tActive('error.backup.importFileMissing'));
  const startedAt = Date.now();

  // ── 预检：存在性 + 尺寸 ──
  // 尺寸优先用新 API 的 File.size（同步、直读文件长度，不经过 Java 堆）；
  // 拿不到就退回 legacy 的 getInfoAsync。
  let size = null;
  let handle = null;
  try {
    if (nextFs && typeof nextFs.File === 'function') {
      const file = new nextFs.File(target);
      if (file.exists === false) {
        throw readError(tActive('error.backup.importFileMissing'));
      }
      if (typeof file.size === 'number' && file.size >= 0) size = file.size;
      // 分片句柄在这里开好，避免下面再 new 一次（也保证「存在」与「可读」是同一个对象）。
      handle = file;
    } else if (legacyFs && typeof legacyFs.getInfoAsync === 'function') {
      const info = await legacyFs.getInfoAsync(target);
      if (!info || !info.exists) throw readError(tActive('error.backup.importFileMissing'));
      if (typeof info.size === 'number' && info.size >= 0) size = info.size;
    }
  } catch (error) {
    // 预检阶段我们自己的 userFacing 错误原样抛；其它（原生查询失败）也归成「不可读」，
    // 但把真实原因写进诊断，便于区分「文件真没了」与「查询本身坏了」。
    if (error && error.userFacing) throw error;
    recordDiagnostic('storage', error, `backup-read-precheck: ${target}`);
    throw readError(tActive('error.backup.importFileMissing'));
  }

  const decision = decideReadStrategy(size, { chunkBytes, directMaxBytes, importMaxBytes });
  if (decision.strategy === 'rejected') {
    recordDiagnostic(
      'storage',
      new Error(`backup too large: ${formatMegabytes(size)}MB > ${formatMegabytes(importMaxBytes)}MB`),
      `backup-read-rejected: ${target}`
    );
    throw readError(tActive('error.backup.importTooLarge', {
      mb: formatMegabytes(size),
      limit: formatMegabytes(importMaxBytes),
    }));
  }

  if (decision.strategy === 'direct') {
    const text = String(await legacyFs.readAsStringAsync(target));
    const result = {
      text,
      bytes: size,
      strategy: 'direct',
      chunkCount: 0,
      elapsedMs: Date.now() - startedAt,
    };
    recordReadTrace(target, result);
    return result;
  }

  // ── 分片读 ──
  const read = await readChunkedText({
    handle,
    uri: target,
    size,
    chunkBytes,
    onProgress,
    startedAt,
    yieldToEventLoop,
  });
  recordReadTrace(target, read);
  return read;
}

// 默认的「让出事件循环」：一个宏任务，让 UI 与本进程的其它回调有机会跑。
// 这是分片读相对单发整读的**实际收益之一**（单发时主线程被一次原生调用占满，
// 期间无法响应取消、无法上报进度）。
function defaultYield() {
  return new Promise(resolve => { setTimeout(resolve, 0); });
}

// ── 按字节搬运（不经 JS 字符串）────────────────────────────────────────────
//
// 为什么这条路径必须存在：分片读把「读」拆开了，但 `parts.join('')` 仍然要在 JS 里
// 拼出一个**完整字符串**。真机实测（110MB 自动备份包，见下方注释）这条路径要走
// 14 分钟——瓶颈不是读文件，是 110MB 字符串落进 Hermes 的堆：分配、扩容、GC 全程
// 占着主线程，期间任何一次会话读取都可能被拖到 15 秒。
//
// 而 SAF 搬运根本不需要「文本」这个中间态：源文件是 UTF-8 字节，目标也是同样的
// UTF-8 字节。逐片 readBytes → writeBytes 即可，峰值内存 = 一片（默认 8MB），
// 与文件大小无关。
//
// 失败方向：任一片读/写抛错就整包失败并让调用方报错——**不做部分成功**。
// 半个备份包比没有备份包更糟（恢复时会读出一个结构不完整的 JSON）。
export async function copyFileBytes({
  sourceUri,
  targetUri,
  sourceFs = null,
  targetFs = null,
  chunkBytes = CHUNK_BYTES,
  onProgress = null,
  yieldToEventLoop = defaultYield,
} = {}) {
  const from = String(sourceUri || '');
  const to = String(targetUri || '');
  if (!from || !to) throw readError(tActive('error.backup.importFileMissing'));
  const src = sourceFs || targetFs;
  const dst = targetFs || sourceFs;
  if (!src || !dst
    || typeof src.File !== 'function' || typeof dst.File !== 'function') {
    throw readError(tActive('error.backup.importReadFailed', { reason: 'FileHandle unavailable' }));
  }
  const sourceFile = new src.File(from);
  const targetFile = new dst.File(to);
  if (typeof sourceFile.open !== 'function') {
    throw readError(tActive('error.backup.importReadFailed', { reason: 'FileHandle unavailable' }));
  }
  const size = typeof sourceFile.size === 'number' && sourceFile.size >= 0 ? sourceFile.size : null;
  const chunk = Number(chunkBytes) > 0 ? Math.floor(Number(chunkBytes)) : CHUNK_BYTES;
  let readHandle = null;
  let writeHandle = null;
  let written = 0;
  const startedAt = Date.now();
  try {
    readHandle = sourceFile.open();
    writeHandle = targetFile.open();
    while (size == null || written < size) {
      const remaining = size == null ? chunk : Math.min(chunk, size - written);
      if (remaining <= 0) break;
      const bytes = readHandle.readBytes(remaining);
      const length = bytes && typeof bytes.length === 'number' ? bytes.length : 0;
      if (length === 0) break;
      writeHandle.writeBytes(bytes);
      written += length;
      if (typeof onProgress === 'function') {
        try {
          onProgress({ bytes: written, total: size, chunks: Math.ceil(written / chunk) });
        } catch (error) {}
      }
      await yieldToEventLoop();
    }
    return {
      bytes: written,
      total: size,
      elapsedMs: Date.now() - startedAt,
      chunks: Math.ceil(written / chunk) || 0,
    };
  } catch (error) {
    if (error && error.userFacing) throw error;
    recordDiagnostic('storage', error, `backup-copy-bytes: ${from} -> ${to} @${written}`);
    throw readError(tActive('error.backup.importReadFailed', {
      reason: String((error && error.message) || 'copy error').split('\n')[0],
    }));
  } finally {
    try {
      if (readHandle && typeof readHandle.close === 'function') readHandle.close();
    } catch (error) {}
    try {
      if (writeHandle && typeof writeHandle.close === 'function') writeHandle.close();
    } catch (error) {}
  }
}

// SAF（content://）目标的搬运：**按字节读、整块单次写**，全程不构造字符串。
//
// 为什么需要单独一条（真机实测 + 一手源码依据）：
//   1. content:// 目标**不支持 FileHandle**：expo-file-system 的
//      FileSystemPath.kt:65 直接抛 "This method cannot be used with content URIs"，
//      所以 copyFileBytes（走 handle.writeBytes）在 SAF 上必然失败。
//   2. content:// 也**不支持 append**：FileWriteOptions 只有 encoding，没有 append；
//      SAFDocumentFile.outputStream() = contentResolver.openOutputStream(uri)，每次都截断。
//      ⇒ 无法分片追加，只能一次性写完整文件。
//   3. 但 `File.write(Uint8Array)` **是支持的**：FileSystemFile.kt 的 ByteArray 重载在
//      uri.isContentUri 时走 file.outputStream()，而 file 是 SAFDocumentFile
//      （= contentResolver.openOutputStream）——这条路是通的。
//
// 为什么不用「读成字符串再写」（旧路径，实测 115MB 要 14 分钟）：
//   readBackupText 会把整包 UTF-8 解码成一个 JS 字符串，write(text) 再 toByteArray()
//   编码回去——先是 115MB 的字符串（Hermes 里可能是 UTF-16，即 ~230MB），再叠一份
//   115MB 字节数组，GC 压力极大；而按字节读只要一个 Uint8Array（预分配），
//   每片是 memcpy，没有解码/编码。
//
// 峰值内存 = 文件大小（单块）+ 一片。这是 content:// 无 append 的**硬下限**，
// 不是这里偷懒：要更低只能改原生层（openOutputStream 逐片写），属独立立项。
export async function copyFileBytesToContentUri({
  sourceUri,
  targetUri,
  sourceFs = null,
  targetFs = null,
  chunkBytes = CHUNK_BYTES,
  onProgress = null,
  yieldToEventLoop = defaultYield,
} = {}) {
  const from = String(sourceUri || '');
  const to = String(targetUri || '');
  if (!from || !to) throw readError(tActive('error.backup.importFileMissing'));
  const src = sourceFs || targetFs;
  const dst = targetFs || sourceFs;
  if (!src || !dst || typeof src.File !== 'function' || typeof dst.File !== 'function') {
    throw readError(tActive('error.backup.importReadFailed', { reason: 'FileHandle unavailable' }));
  }
  const sourceFile = new src.File(from);
  if (typeof sourceFile.open !== 'function') {
    throw readError(tActive('error.backup.importReadFailed', { reason: 'FileHandle unavailable' }));
  }
  const size = typeof sourceFile.size === 'number' && sourceFile.size >= 0 ? sourceFile.size : null;
  if (size == null) {
    // 不知道大小就没法预分配单块缓冲；这种情况下让调用方走别的路径，
    // 而不是先读一遍再猜（那会把文件读两次）。
    throw readError(tActive('error.backup.importReadFailed', { reason: 'unknown size' }));
  }
  if (size === 0) return { bytes: 0, total: 0, elapsedMs: 0 };

  const chunk = Number(chunkBytes) > 0 ? Math.floor(Number(chunkBytes)) : CHUNK_BYTES;
  const buffer = new Uint8Array(size);
  let filled = 0;
  let readHandle = null;
  const startedAt = Date.now();
  try {
    readHandle = sourceFile.open();
    while (filled < size) {
      const want = Math.min(chunk, size - filled);
      const bytes = readHandle.readBytes(want);
      const length = bytes && typeof bytes.length === 'number' ? bytes.length : 0;
      if (length === 0) break; // EOF：下面按 filled !== size 判为截断
      buffer.set(length === bytes.length ? bytes : bytes.subarray(0, length), filled);
      filled += length;
      if (typeof onProgress === 'function') {
        try {
          onProgress({ bytes: filled, total: size, chunks: Math.ceil(filled / chunk) });
        } catch (error) {}
      }
      await yieldToEventLoop();
    }
  } catch (error) {
    if (error && error.userFacing) throw error;
    recordDiagnostic('storage', error, `backup-copy-content: ${from} -> ${to} @${filled}`);
    throw readError(tActive('error.backup.importReadFailed', {
      reason: String((error && error.message) || 'read error').split('\n')[0],
    }));
  } finally {
    try {
      if (readHandle && typeof readHandle.close === 'function') readHandle.close();
    } catch (error) {}
  }
  if (filled !== size) {
    // 读到的比文件声明的小 = 源被截断/读失败。**不做部分成功**：半个备份包比没有更糟
    // （恢复时会读出不完整 JSON，而且用户会以为备份是好的）。
    recordDiagnostic('storage', new Error('backup source truncated'), `backup-copy-content: ${from} @${filled}/${size}`);
    throw readError(tActive('error.backup.importReadFailed', { reason: `truncated ${filled}/${size}` }));
  }
  try {
    // 单次整块写：content:// 无 append（见上方注释）。
    new dst.File(to).write(buffer);
  } catch (error) {
    recordDiagnostic('storage', error, `backup-write-content: ${to} @${size}`);
    throw readError(tActive('error.backup.importReadFailed', {
      reason: String((error && error.message) || 'write error').split('\n')[0],
    }));
  }
  return { bytes: size, total: size, elapsedMs: Date.now() - startedAt, chunks: Math.ceil(size / chunk) || 1 };
}

// 分片 + 增量解码。抽出来是为了让「多字节字符跨片」这类边界能被单独测。
export async function readChunkedText({
  handle,
  uri,
  size,
  chunkBytes = CHUNK_BYTES,
  onProgress = null,
  startedAt = Date.now(),
  yieldToEventLoop = defaultYield,
}) {
  if (!handle || typeof handle.open !== 'function') {
    // 新 API 不可用（异常构建/未来版本改名）：明确报错并说明原因，
    // 不静默退回单发整读——那正是本模块要消灭的路径。
    throw readError(tActive('error.backup.importReadFailed', { reason: 'FileHandle unavailable' }));
  }
  // TextDecoder 在 Expo 里由 winter runtime 安装；缺失时无法增量解码，
  // 这时**不静默降级成单发整读**（那正是要修的 bug），而是明确报错——见下方 catch 的注释。
  const Decoder = typeof TextDecoder === 'function' ? TextDecoder : null;
  if (!Decoder) {
    throw readError(tActive('error.backup.importReadFailed', { reason: 'TextDecoder unavailable' }));
  }

  let fileHandle = null;
  const parts = [];
  let readBytesTotal = 0;
  let chunks = 0;
  try {
    fileHandle = handle.open();
    const decoder = new Decoder('utf-8');
    while (size == null || readBytesTotal < size) {
      const remaining = size == null ? chunkBytes : Math.min(chunkBytes, size - readBytesTotal);
      if (remaining <= 0) break;
      const bytes = fileHandle.readBytes(remaining);
      const length = bytes && typeof bytes.length === 'number' ? bytes.length : 0;
      // 空片 = 已到 EOF（或文件被截断）：不能空转，直接收尾。
      if (length === 0) break;
      // `stream: true` 是**必须**的：它让解码器把片尾不完整的多字节序列留在内部缓冲，
      // 跨片拼回。少了它，一个汉字被切开就会变成 U+FFFD（数据静默损坏）。
      parts.push(decoder.decode(bytes, { stream: true }));
      readBytesTotal += length;
      chunks += 1;
      if (typeof onProgress === 'function') {
        try {
          onProgress({ bytes: readBytesTotal, total: size, chunks });
        } catch (error) {}
      }
      // 片间让出事件循环：让 UI 喘息、也让取消/其它任务有机会跑（对齐导出侧节奏）。
      await yieldToEventLoop();
    }
    // 收尾：把解码器内部缓冲里剩下的字节吐出来（没有这一步会丢文件末尾几个字节）。
    parts.push(decoder.decode());
  } catch (error) {
    if (error && error.userFacing) throw error;
    recordDiagnostic('storage', error, `backup-read-chunked: ${uri} @${readBytesTotal}`);
    throw readError(tActive('error.backup.importReadFailed', { reason: String((error && error.message) || 'read error').split('\n')[0] }));
  } finally {
    // close() 失败不该盖掉真正的读取结果/错误。
    try {
      if (fileHandle && typeof fileHandle.close === 'function') fileHandle.close();
    } catch (error) {}
  }

  return {
    text: parts.join(''),
    bytes: readBytesTotal,
    strategy: 'chunked',
    chunkCount: chunks,
    elapsedMs: Date.now() - startedAt,
  };
}

// 读取阶段的诊断留痕（任务书第 4 条）：URI、size、方式、分片数、耗时。
// 下次「一直等」或「导入失败」时，日志能直接指出卡在读取的哪一步、用了哪条路径。
//
// FEAT-AC5 P0-C：改传 { message } 对象（无堆栈）——这是**成功的读取留痕**，不是错误。
// 原先 new Error 只为借 message 字段，代价是每条都写成「Error: [backup-read] ...」+
// 一段无信息量的堆栈（用户日志被 Error 前缀灌满的同型病灶）。
function recordReadTrace(uri, result) {
  recordDiagnostic(
    'storage',
    { message: `[backup-read] ${result.strategy} ${result.chunkCount} chunk(s)` },
    `${uri} size=${result.bytes == null ? '?' : result.bytes} elapsed=${result.elapsedMs}ms`
  );
}
