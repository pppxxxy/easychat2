// 自动备份的依赖装配（桌面）：**唯一一份**，供「立即备份」卡片与前台调度器共用。
//
// 为什么单独成模块而不是各自拼：AutoBackupCard 的「立即备份」与调度器的「到点备份」
// 必须用同一份依赖，否则一旦哪边的装配改了（比如补上文件系统能力），另一条路径
// 会静默跑在旧装配上——备份这类「失败也不报错」的后台动作最容易这样漂移。
import { createAutoBackupDeps } from '../../../src/backup/autoBackupRun.js';
import { getAutoBackupSettings, recordAutoBackupAt } from '../../../src/storage/autoBackup.js';
import { exportBackup } from '../../../src/storage/backup.js';
import * as FileSystem from '../platform/fileSystem.js';

export function createDesktopAutoBackupDeps() {
  return createAutoBackupDeps({
    exportBackup,
    getSettings: getAutoBackupSettings,
    recordLastBackupAt: recordAutoBackupAt,
    fileSystem: FileSystem,
    // 桌面没有 nextFs（FileHandle）与 SAF 适配器：autoBackupRun 在非 SAF 模式下
    // 完全不碰它们，传 null 即可（它的各个分支都有 null 守卫）。
    nextFs: null,
    adapter: null,
  });
}

export default createDesktopAutoBackupDeps;