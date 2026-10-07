// 分页纯函数：把测量得到的行（text + height）按页高贪心装箱。
// 测量组件负责产出行数组（onTextLayout），这里只做几何计算，供 Node 穷举；
// 行高与页高必须同一单位（测量组件统一用像素）。

const ANCHOR_MAX = 40;

// 贪心装箱：行依次填入当前页，累计高度超过 pageHeight 即开新页；
// 单行高度超过整页时独占一页（不拆行——拆行是渲染器的事）。
// 返回页数组：{ firstLine, lineCount, anchorText }；anchorText 是页首行截断文本，
// 用于字号/主题变化重测后重新定位（见 findPageByAnchor）。
export function paginateLines(measuredLines, pageHeight) {
  const lines = Array.isArray(measuredLines) ? measuredLines : [];
  const height = Math.max(1, Number(pageHeight) || 0);
  if (lines.length === 0) return [];

  const pages = [];
  let firstLine = 0;
  let acc = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const lineHeight = Math.max(0, Number(lines[index] && lines[index].height) || 0);
    if (acc > 0 && acc + lineHeight > height) {
      pages.push(buildPage(lines, firstLine, index - firstLine));
      firstLine = index;
      acc = 0;
    }
    acc += lineHeight;
  }
  pages.push(buildPage(lines, firstLine, lines.length - firstLine));
  return pages;
}

function buildPage(lines, firstLine, lineCount) {
  const anchorLine = lines[firstLine] || {};
  return {
    firstLine,
    lineCount,
    anchorText: String(anchorLine.text || '').trim().slice(0, ANCHOR_MAX),
  };
}

// 页正文（阅读页可见文本）：页内行文本以换行连接，**不截断**——可见页必须
// 完整渲染分到本页的全部行，静默丢字比溢出更不可接受（2026-10-07 末行修复）。
export function pageBodyText(measuredLines, page) {
  const lines = Array.isArray(measuredLines) ? measuredLines : [];
  if (!page) return '';
  const start = Math.max(0, Math.floor(page.firstLine) || 0);
  const end = Math.min(lines.length, start + Math.max(0, Math.floor(page.lineCount) || 0));
  return lines.slice(start, end).map(line => String((line && line.text) || '')).join('\n');
}

// 页正文摘录（供评论 prompt）：在上面的基础上截断到 maxChars。
// 只有评论摘录路径允许截断；阅读页正文必须走 pageBodyText。
export function pageText(measuredLines, page, { maxChars = 600 } = {}) {
  return pageBodyText(measuredLines, page).slice(0, Math.max(1, Math.floor(maxChars) || 600));
}

// 重测后定位：优先找行文本包含 anchor 的第一页；找不到（锚行被重排跨页）退回
// 原页号并夹取到合法范围。progress 持久化的是 { blockIndex, pageIndex, anchorText }。
export function findPageByAnchor(pages, anchorText, fallbackIndex) {
  const list = Array.isArray(pages) ? pages : [];
  const anchor = String(anchorText || '').trim();
  if (list.length === 0) return 0;
  if (anchor) {
    for (let index = 0; index < list.length; index += 1) {
      const page = list[index];
      if (page && page.anchorText && page.anchorText.includes(anchor)) return index;
      if (page && page.anchorText && anchor.includes(page.anchorText)) return index;
    }
  }
  const fallback = Math.floor(Number(fallbackIndex));
  if (!Number.isFinite(fallback)) return 0;
  return Math.min(list.length - 1, Math.max(0, fallback));
}
