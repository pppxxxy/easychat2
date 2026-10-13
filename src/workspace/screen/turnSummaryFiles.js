// W2 回合小结的**渲染计划**（纯函数，Node 直测）。
//
// 为什么需要它：TurnSummaryPanel 原来 `files.map()` 裸渲染全部条目，且面板挂在
// 消息 ScrollView **外面**（ChatPanel 的列布局：滚动消息区 → 侧栏面板 → 输入区）。
// 一次快照拉取会产生「整仓」级别的提交（实测 1066 个文件 ≈ 2.1 万像素高），
// 于是消息滚动区被挤到 0 高、面板自己又不带滚动容器——两头都动不了（Q1 卡死）。
//
// 这里只做「渲染多少、折叠多少」的判定（纯数据），面板负责把它画成
// 有界滚动区 + 「查看全部」Sheet。上限与折叠阈值是产品口径，导出常量便于测试引用。

export const TURN_SUMMARY_ROW_LIMIT = 40;
// 超过这个条数就不再内联明细：批量提交（快照拉取/整目录导入）本来就不是「看清单」的场景，
// 明细走 Sheet 的 FlatList（虚拟化），面板本体保持一行。
export const TURN_SUMMARY_BULK_THRESHOLD = 100;

// 纯函数：{ files } → { shown, hidden, total, bulk }。
//  - 普通回合（≤ limit）：全部内联；
//  - 略多（limit+1 .. bulkThreshold）：内联前 limit 条 + 「还有 N 个」；
//  - 批量（> bulkThreshold）：内联 0 条（明细全在 Sheet 里），面板只报总数。
export function summarizeTurnFiles({ files, limit = TURN_SUMMARY_ROW_LIMIT, bulkThreshold = TURN_SUMMARY_BULK_THRESHOLD } = {}) {
  const list = Array.isArray(files) ? files : [];
  const total = list.length;
  const bulk = total > Math.max(0, Math.floor(Number(bulkThreshold)) || 0);
  const rowLimit = bulk ? 0 : Math.max(0, Math.floor(Number(limit)) || 0);
  const shown = list.slice(0, rowLimit);
  return { shown, hidden: total - shown.length, total, bulk };
}
