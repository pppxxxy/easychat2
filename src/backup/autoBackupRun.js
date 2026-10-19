// 自动备份的编排：导出全量数据 → 写入目标（应用私有目录或用户所选文件夹）→
// 淘汰旧的自动备份 → 记录本次时间。
//
// 依赖全部可注入（Node 直测）；默认实现惰性 import 原生/存储模块，避免测试环境加载 RN。
// 「选文件夹」的 SAF 写入复用工作区的 expo v19 适配器（createExpoSafAdapter），
// 它内部是 DocumentFile，支持对 content:// 的 list/create/读写/删。

import {
  AUTO_BACKUP_LOCATION_KINDS,
  buildAutoBackupFileName,
  isAutoBackupDue,
  normalizeAutoBackupSettings,
  selectStaleAutoBackups,
} from './autoBackupPolicy.js';
import { copyFileBytes, readBackupText } from '../storage/backupRead.js';
import { recordDiagnostic } from '../storage/diagnostics.js';

// 应用私有目标子目录（相对 documentDirectory）：与手动导出的包分开，
// 淘汰旧备份时只清这里，绝不误删用户手动导出的 easychat2-backup-*.json。
export const AUTO_BACKUP_APP_SUBDIR = 'auto-backups';

export function resolveAutoBackupAppDirectory(fileSystem) {
  const base = String((fileSystem && (fileSystem.documentDirectory || fileSystem.cacheDirectory)) || '');
  return `${base}${AUTO_BACKUP_APP_SUBDIR}/`;
}

async function defaultDeps() {
  const [{ exportBackup }, store, legacyFs, nextFs, saf] = await Promise.all([
    import('../storage/backup.js'),
    import('../storage/autoBackup.js'),
    import('expo-file-system/legacy'),
    import('expo-file-system'),
    import('../workspace/safStore.js'),
  ]);
  return createAutoBackupDeps({
    exportBackup,
    getSettings: store.getAutoBackupSettings,
    recordLastBackupAt: store.recordAutoBackupAt,
    fileSystem: legacyFs,
    nextFs,
    adapter: saf.createExpoSafAdapter(nextFs),
  });
}

// 把「导出 + 应用私有文件操作 + SAF 操作 + 记录时间」装配成一组依赖，供 runAutoBackup 使用。
// 也可在测试里用假实现替换（不传 fileSystem/adapter）。
//
// nextFs（新版 expo-file-system）用于大文件分片读；测试/老构建可不传，
// 此时 readBackupText 会退回 legacy 的尺寸查询 + 小文件直读。
export function createAutoBackupDeps({
  exportBackup,
  getSettings,
  recordLastBackupAt,
  fileSystem = null,
  nextFs = null,
  adapter = null,
}) {
  const appDir = resolveAutoBackupAppDirectory(fileSystem);
  return {
    getSettings,
    recordLastBackupAt,
    exportBackup,
    appDirectory: () => appDir,
    async readTextFile(uri) {
      // SAF 导出要把刚落盘的整包读出来再写进用户选的文件夹，所以这里同样是「整读一个大文件」。
      // 旧实现是无参数 `readAsStringAsync`：83MB 的包会直接 OOM（自动备份在 SAF 模式下自己失败，
      // 而错误同样被 Expo 兼容层吞成通用文案）。改走 backupRead 的尺寸预检 + 分片读。
      const read = await readBackupText({
        uri,
        legacyFs: fileSystem,
        nextFs,
      });
      return read.text;
    },
    async deleteFile(uri) {
      await fileSystem.deleteAsync(uri, { idempotent: true });
    },
    async listAppBackups(directory) {
      let names = [];
      try {
        names = await fileSystem.readDirectoryAsync(directory);
      } catch (error) {
        names = [];
      }
      return names.map(name => ({ name, uri: `${directory}${name}` }));
    },
    async listSafFiles(dirUri) {
      const children = await adapter.listChildren(dirUri);
      return (Array.isArray(children) ? children : [])
        .filter(child => child && !child.isDirectory)
        .map(child => ({ name: child.name, uri: child.uri }));
    },
    createSafFile(dirUri, name) {
      return adapter.createFile(dirUri, name, 'application/json');
    },
    async writeSafText(fileUri, text) {
      await adapter.writeText(fileUri, text);
    },
    // SAF 搬运的**按字节**路径：源（应用私有）→ 目标（用户选的 SAF 目录）。
    // 存在理由见 backupRead.copyFileBytes 的文件头：整串搬运 110MB 在真机上要 14 分钟，
    // 期间主线程被占满，会话读取被拖到 15 秒。按字节搬运峰值只有一片（8MB）。
    //
    // 返回 null = 「本环境不支持按字节搬运」，调用方据此退回老的整串路径。
    //
    // ⚠️ 目标端是 content:// 时**必然用不了 FileHandle**（fef85db 在这里错了，
    // 导致 SAF 自动备份 100% 失败）。一手依据：
    //   node_modules/expo-file-system/android/.../filesystem/FileSystemPath.kt:65
    //     throw Exception("This method cannot be used with content URIs: $uri")
    // 而 SAF 目录必然是 content://（用户通过系统选择器授权），所以：
    //   · 探测不能只查 typeof File === 'function'（API 存在 ≠ 支持 content://）；
    //   · 必须在**目标 URI 形态**上判断，content:// 直接返回 null 走老路径。
    // 老路径是「整串读写」，对 110MB 慢但在功能上是**对的**——比 100% 失败好得多。
    // 真正的按字节方案需要原生层 openOutputStream（见 backupRead 里 TODO 说明）。
    async copyToSaf(sourceUri, targetUri, onProgress = null) {
      const target = String(targetUri || '');
      if (/^content:/i.test(target)) {
        // 如实记一条：这是「能力不可用」而不是「搬运失败」，日志里要能区分。
        recordDiagnostic(
          'storage',
          new Error('[backup] content:// 目标不支持 FileHandle，改用整串搬运'),
          `backup-copy-bytes-skip: ${target.slice(0, 80)}`
        );
        return null;
      }
      const fsModule = nextFs;
      if (!fsModule || typeof fsModule.File !== 'function') return null;
      try {
        return await copyFileBytes({
          sourceUri,
          targetUri: target,
          sourceFs: fsModule,
          targetFs: fsModule,
          onProgress,
        });
      } catch (error) {
        // 兜底：即便 URI 不是 content://，FileHandle 仍可能在别的形态上不可用。
        // 这里**不吞错**——记诊断后返回 null 让调用方走老路径，保证备份能成功；
        // 老路径若也失败，那才是真的失败，由上层报错。
        recordDiagnostic(
          'storage',
          error,
          `backup-copy-bytes-fallback: ${target.slice(0, 80)}`
        );
        return null;
      }
    },
    async deleteSafFile(uri) {
      await adapter.delete(uri);
    },
  };
}

async function pruneStale(listFn, deleteFn, keepName) {
  const entries = await listFn();
  const stale = selectStaleAutoBackups(entries, keepName);
  for (const entry of stale) {
    await deleteFn(entry);
  }
  return stale.length;
}

// 跑一次自动备份。settings 必须已加载（调用方负责）；enabled=false 直接跳过。
// 返回 { ok, fileName, target, uri, bytes, storageCount, mediaCount, incomplete, pruned }。
export async function runAutoBackup({ settings, deps = null, now = Date.now(), appVersion = '', onProgress } = {}) {
  const d = deps || await defaultDeps();
  const normalized = normalizeAutoBackupSettings(settings);
  if (!normalized.enabled) return { ok: false, skipped: 'disabled' };

  const fileName = buildAutoBackupFileName(now);
  const saf = normalized.location.kind === AUTO_BACKUP_LOCATION_KINDS.SAF;

  // 1) 导出全量数据。应用私有模式直接写进 auto-backups/；SAF 模式先写应用内临时文件再搬运。
  const exported = await d.exportBackup({
    directory: d.appDirectory(),
    fileName,
    appVersion,
    onProgress,
  });

  let pruned = 0;
  let targetUri = exported.uri;
  if (saf) {
    let safUri = '';
    try {
      safUri = await d.createSafFile(normalized.location.uri, fileName);
      // 优先按字节搬运：不构造中间字符串，峰值内存 = 一片，与包大小无关。
      // 老构建（没有 FileHandle）才退回「整串读出再整串写入」——那条路径在 110MB
      // 包上实测要 14 分钟，期间主线程被占满（真机日志：refreshSessions 15 秒）。
      const copied = typeof d.copyToSaf === 'function'
        ? await d.copyToSaf(exported.uri, safUri, onProgress)
        : null;
      if (!copied) {
        const text = await d.readTextFile(exported.uri);
        await d.writeSafText(safUri, text);
      }
    } catch (error) {
      // 写入所选文件夹失败：清掉可能已创建的半个 SAF 文件，再抛给调度层。
      if (safUri) {
        try { await d.deleteSafFile(safUri); } catch (cleanupError) {}
      }
      throw error;
    }
    // 搬运完成，删掉应用内临时文件；失败不影响本次备份（文件已落到目标文件夹）。
    try { await d.deleteFile(exported.uri); } catch (cleanupError) {}
    targetUri = safUri;
    try {
      pruned = await pruneStale(
        () => d.listSafFiles(normalized.location.uri),
        entry => d.deleteSafFile(entry.uri),
        fileName
      );
    } catch (error) {
      // 淘汰旧备份失败不算备份失败：新包已就位，旧包留着下次再清。
      pruned = 0;
    }
  } else {
    try {
      pruned = await pruneStale(
        () => d.listAppBackups(d.appDirectory()),
        entry => d.deleteFile(entry.uri),
        fileName
      );
    } catch (error) {
      pruned = 0;
    }
  }

  await d.recordLastBackupAt(now);
  return {
    ok: true,
    fileName,
    target: saf ? 'saf' : 'app',
    uri: targetUri,
    bytes: exported.bytes,
    storageCount: exported.storageCount,
    mediaCount: exported.mediaCount,
    incomplete: exported.incomplete === true,
    pruned,
  };
}

// 到期则跑一次（调度层入口）。force=true 时忽略到期判定（手动「立即备份」也可复用）。
export async function runAutoBackupIfDue({ deps = null, now = Date.now(), appVersion = '', onProgress, force = false } = {}) {
  const d = deps || await defaultDeps();
  const settings = await d.getSettings();
  if (!force && !isAutoBackupDue(settings, now)) return { ok: false, skipped: 'not-due' };
  return runAutoBackup({ settings, deps: d, now, appVersion, onProgress });
}

// 「切到后台/离开前台」时跑一次（调度层入口）：只在总开关 + 退出开关都开时执行。
export async function runAutoBackupOnExit({ deps = null, now = Date.now(), appVersion = '', onProgress } = {}) {
  const d = deps || await defaultDeps();
  const settings = await d.getSettings();
  if (!settings.enabled || !settings.onExit) return { ok: false, skipped: 'exit-off' };
  return runAutoBackup({ settings, deps: d, now, appVersion, onProgress });
}
