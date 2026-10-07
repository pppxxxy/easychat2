// 按章阅读进度：页粒度百分比纯函数 + chapterProgress 映射归一化/合并。
// 背景（2026-10-07「已读完」虚报修复）：进度此前只有单一阅读位置，目录里
// 「当前章之前」的所有章被位置反推 clamp 成 100%——滑块跳章即集体虚报。
// 改为按章显式记录：只有真的读到的章才有百分比，其余一律「未读」；
// 不从旧 location 反推任何历史章的进度（那正是虚报源头）。

// 与 blocks.MAX_CHAPTERS 同量级：防脏数据把存储撑爆。
const MAX_PROGRESS_ENTRIES = 2000;

// 章内页粒度百分比：
//   已完成块数 = 当前块在章内的偏移（blockIndex − 章起始块）
//   当前块内进度 = (pageIndex + 1) / pageCount（站在第 3 页即 3/4）
//   percent = round(100 × (已完成块数 + 块内进度) / 该章总块数)
// 单块章即精确页百分比（共 4 面读到第 3 面 = 75%）；多块章是块均匀假设下的
// 近似（与旧位置反推同精度，但不再虚报未读的章）。读不到章返回 null。
export function computeChapterPercent({ chapterEntries, blockCount, blockIndex, pageIndex = 0, pageCount = 1 }) {
  const entries = Array.isArray(chapterEntries) ? chapterEntries : [];
  if (entries.length === 0) return null;
  const block = Math.max(0, Math.floor(Number(blockIndex)) || 0);
  // 当前所在章：最后一个「起始块 ≤ 当前块」的章节（与目录高亮同一口径）。
  // entry.blockIndex 在 normalizeChapters 里已是 clamp 过的非负整数。
  let chapter = null;
  let next = null;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry && entry.blockIndex <= block) {
      chapter = entry;
      next = entries[i + 1] || null;
    }
  }
  if (!chapter) return null;
  const start = Math.max(0, Math.floor(Number(chapter.blockIndex)) || 0);
  const lastBlock = Math.max(0, Math.floor(Number(blockCount)) || 0);
  const end = next
    ? Math.max(start + 1, Math.floor(Number(next.blockIndex)) || 0)
    : Math.max(start + 1, lastBlock);
  const total = Math.max(1, end - start);
  const completed = Math.min(total, Math.max(0, block - start));
  const pages = Math.max(1, Math.floor(Number(pageCount)) || 1);
  const page = Math.max(0, Math.floor(Number(pageIndex)) || 0);
  const inBlock = Math.min(1, Math.max(0, (page + 1) / pages));
  return Math.round(100 * Math.min(1, (completed + inBlock) / total));
}

// 归一化：键必须是十进制整数的规范字符串（'3' 收，'03'/'3.5' 丢），
// 值取整并 clamp 到 [0, 100]，非法丢弃；旧数据无该字段迁移为 {}。
export function normalizeChapterProgress(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  let count = 0;
  Object.entries(source).forEach(([key, value]) => {
    if (count >= MAX_PROGRESS_ENTRIES) return;
    const index = Math.floor(Number(key));
    if (!Number.isFinite(index) || index < 0) return;
    if (String(index) !== String(key).trim()) return;
    const percent = Math.round(Number(value));
    if (!Number.isFinite(percent)) return;
    result[String(index)] = Math.min(100, Math.max(0, percent));
    count += 1;
  });
  return result;
}

// 合并语义：同章取历史最大值——回翻旧页、跳章回读都不降进度。
// 只增不降是存储层不变量，写入方无须各自防回退。
export function mergeChapterProgress(existing, patch) {
  const merged = normalizeChapterProgress(existing);
  Object.entries(normalizeChapterProgress(patch)).forEach(([key, value]) => {
    const prev = Number(merged[key]);
    merged[key] = Number.isFinite(prev) ? Math.max(prev, value) : value;
  });
  return merged;
}
