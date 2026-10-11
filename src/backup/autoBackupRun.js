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
    adapter: saf.createExpoSafAdapter(nextFs),
  });
}

// 把「导出 + 应用私有文件操作 + SAF 操作 + 记录时间」装配成一组依赖，供 runAutoBackup 使用。
// 也可在测试里用假实现替换（不传 fileSystem/adapter）。
export function createAutoBackupDeps({
  exportBackup,
  getSettings,
  recordLastBackupAt,
  fileSystem = null,
  adapter = null,
}) {
  const appDir = resolveAutoBackupAppDirectory(fileSystem);
  return {
    getSettings,
    recordLastBackupAt,
    exportBackup,
    appDirectory: () => appDir,
    async readTextFile(uri) {
      return String(await fileSystem.readAsStringAsync(uri));
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
      const text = await d.readTextFile(exported.uri);
      safUri = await d.createSafFile(normalized.location.uri, fileName);
      await d.writeSafText(safUri, text);
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
