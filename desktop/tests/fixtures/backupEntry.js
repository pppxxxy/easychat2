// esbuild 打包入口（桌面备份集成测试用）：把共享层备份编排连同桌面适配层打成 CJS，
// 使 Node 测试能在没有 Metro/Expo 别名的情况下跑真实 export/import。
export { exportBackup, importBackup } from '../../../src/storage/backup.js';
export { readBackupText } from '../../../src/storage/backupRead.js';

// S14：自动备份执行器（桌面只有「应用私有目录」这一支，SAF 分支不触发）。
export { createAutoBackupDeps, runAutoBackup, runAutoBackupIfDue, AUTO_BACKUP_APP_SUBDIR } from '../../../src/backup/autoBackupRun.js';
export { normalizeAutoBackupSettings, isAutoBackupDue } from '../../../src/backup/autoBackupPolicy.js';
export {
  getAutoBackupSettings,
  patchAutoBackupSettings,
  recordAutoBackupAt,
} from '../../../src/storage/autoBackup.js';

