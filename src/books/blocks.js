// 书籍分块纯函数：整本小说不能一次性交给隐藏 Text 测量（数百万字会卡死渲染线程），
// 必须按「章节边界 → 段落边界 → 硬切」三级切块，逐块分页。
// 全部为纯字符串处理，供 Node 测试穷举；注意与 backupStream 相同的代理对切割坑。

// 章节标题判定：行首「第X章/节/回/卷/部/篇/幕/集」、Chapter N、以及楔子/序章/尾声等
// 特殊篇目。行首匹配 + 行长 ≤30，避免把「第二年春天……」这类叙述行误判成章节
// （「年/天」不在单位集里，天然排除）。
// 中文小说的叙述行也常以「第三章」开头（「第三章的内容让他想起…」），因此单位后
// 还有两条排除：以「的/里/中」这类助词/方位词开头（标题分隔几乎总带空格或标点），
// 或以句读标点收尾（叙述行特征）。
const CHAPTER_UNIT = '[章节回卷部篇幕集]';
const CHAPTER_NUM = '[0-9〇零一二两三四五六七八九十百千万]+';
const CHAPTER_PATTERN = new RegExp(
  `^第\\s*${CHAPTER_NUM}\\s*${CHAPTER_UNIT}`
  + `|^${CHAPTER_NUM}\\s*${CHAPTER_UNIT}`
  + `|^[Cc]hapter\\s+\\d+`
  + `|^(楔子|序章|序幕|引子|尾声|终章|后记|番外(篇|之)?)`
);
const CHAPTER_UNIT_PATTERN = new RegExp(`^第?\\s*${CHAPTER_NUM}?\\s*${CHAPTER_UNIT}`);
const SPECIAL_PATTERN = /^(楔子|序章|序幕|引子|尾声|终章|后记|番外(篇|之)?)/;
const CHAPTER_LINE_MAX = 30;
const NARRATIVE_CONTINUATIONS = /^[的里中上下前后]/;
const NARRATIVE_ENDINGS = /[。，？！；]$/;

export function detectChapterTitle(line) {
  const text = String(line || '').trim();
  if (!text || text.length > CHAPTER_LINE_MAX) return '';
  if (!CHAPTER_PATTERN.test(text)) return '';
  // 单位字符之后的剩余部分：空格/标点分隔或直接接标题文字都算章节行；
  // 但「的/里/中…」开头或以句读标点收尾的是叙述行，排除。特殊篇目同理。
  const unitMatch = CHAPTER_UNIT_PATTERN.exec(text) || SPECIAL_PATTERN.exec(text);
  if (unitMatch) {
    const rest = text.slice(unitMatch[0].length);
    if (rest && NARRATIVE_CONTINUATIONS.test(rest)) return '';
    if (NARRATIVE_ENDINGS.test(text)) return '';
  }
  return text;
}

// 代理对安全切点：切点前若是高位代理则回退一位，避免把 emoji 生劈成 U+FFFD。
export function safeCharCut(text, end) {
  const source = String(text || '');
  const limit = Math.max(0, Math.min(Math.floor(end) || 0, source.length));
  if (limit > 0 && limit < source.length
    && source.charCodeAt(limit - 1) >= 0xd800 && source.charCodeAt(limit - 1) <= 0xdbff
    && source.charCodeAt(limit) >= 0xdc00 && source.charCodeAt(limit) <= 0xdfff) {
    return limit - 1;
  }
  return limit;
}

function splitLongLine(line, maxChars) {
  const pieces = [];
  let start = 0;
  while (start < line.length) {
    const end = safeCharCut(line, start + maxChars);
    if (end <= start) break;
    pieces.push(line.slice(start, end));
    start = end;
  }
  return pieces;
}

// 把整本书切成测量块：
// - 章节行必然开新块；同章后续超限切块沿用章题（评论上下文与目录都用它）；
// - 缓冲达到 maxBlockChars 且落在段落空行处时收块；
// - 单行（无换行的巨段）超限时按字符硬切，代理对安全。
// 返回块数组：{ index, text, charStart, title }；charStart 是块首在全文的偏移，
// 全文不变时分块结果确定不变，进度按块号持久化是稳定的。
export function splitBookIntoBlocks(rawText, { maxBlockChars = 12000 } = {}) {
  const text = String(rawText || '');
  const limit = Math.max(2000, Math.floor(maxBlockChars) || 12000);
  if (!text) return [];

  const lines = text.split('\n');
  const lineOffsets = [];
  let cursor = 0;
  for (const line of lines) {
    lineOffsets.push(cursor);
    cursor += line.length + 1;
  }
  const lineEnd = index => lineOffsets[index] + lines[index].length;

  const blocks = [];
  const pushSlice = (startOffset, endOffset, title) => {
    const blockText = text.slice(startOffset, endOffset);
    if (!blockText.trim()) return;
    blocks.push({ index: blocks.length, text: blockText, charStart: startOffset, title: title || '' });
  };

  // 行级切分：[startLine, endLine) 内按 ≤limit 收块；行边界优先，单行超限硬切。
  const emitLines = (startLine, endLine, title) => {
    let start = startLine;
    while (start < endLine) {
      let acc = 0;
      let cut = start;
      while (cut < endLine) {
        const lineLen = lines[cut].length + 1;
        if (acc + lineLen > limit && acc > 0) break;
        acc += lineLen;
        cut += 1;
      }
      if (cut === start) cut = start + 1; // 单行超限：至少收一行
      const startOffset = lineOffsets[start];
      const endOffset = lineEnd(cut - 1);
      if (cut === start + 1 && endOffset - startOffset > limit) {
        let offset = startOffset;
        splitLongLine(text.slice(startOffset, endOffset), limit).forEach(piece => {
          pushSlice(offset, offset + piece.length, title);
          offset += piece.length;
        });
      } else {
        pushSlice(startOffset, endOffset, title);
      }
      start = cut;
    }
  };

  // 主流程：章节行开新块；缓冲 ≥ limit 且落在空行（段落边界）时收块。
  let blockStartLine = 0;
  let currentTitle = detectChapterTitle(lines[0] || '');
  let buffered = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const chapterTitle = index > 0 ? detectChapterTitle(lines[index]) : '';
    if (chapterTitle) {
      emitLines(blockStartLine, index, currentTitle);
      blockStartLine = index;
      currentTitle = chapterTitle;
      buffered = lines[index].length + 1;
      continue;
    }
    buffered += lines[index].length + 1;
    if (lines[index].length === 0 && buffered >= limit) {
      emitLines(blockStartLine, index + 1, currentTitle);
      blockStartLine = index + 1;
      // 续块必须沿用章题：章跨多块时后续页的底部栏、评论上下文都读 block.title，
      // 清空会让这些块的 chapterTitle 变空（monkey 审查发现的缺陷 2）。
      buffered = 0;
    }
  }
  if (blockStartLine < lines.length) emitLines(blockStartLine, lines.length, currentTitle);
  return blocks;
}

// 目录：同一章节标题的连续块合并，返回 [{ title, blockIndex }]。
export function buildChapterList(blocks) {
  const chapters = [];
  (Array.isArray(blocks) ? blocks : []).forEach(block => {
    const title = String((block && block.title) || '').trim();
    if (!title) return;
    if (chapters.length > 0 && chapters[chapters.length - 1].title === title) return;
    chapters.push({ title, blockIndex: block.index });
  });
  return chapters;
}
