// expo-sqlite 适配：空实现（design.md「别名表」）。
//
// 共享层对 sqlite 的引用是 src/storage/io.js 里的惰性 require（大值读取兜底）。
// 桌面端键值仓没有 2MB 上限，兜底路径不可达；本模块导出为空，使任何
// 「typeof SQLite.xxx === 'function'」的能力探测都落到「不可用」分支，而不是抛错。
export const __desktopUnavailable = true;

const sqliteModule = Object.freeze({ __desktopUnavailable: true });
export default sqliteModule;
