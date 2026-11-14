// 书籍分章阅读（桌面）：把整本正文按共享层的 blocks 切成章，按章阅读并记录进度。
//
// 为什么这是真缺口而不是「平台差异」：
//   手机 BookReaderView 那层「隐藏 Text 测量 + 逐行分页 + 左右点按翻页」确实依赖 RN
//   的文本测量，桌面不复刻；但**分章本身**是共享层纯函数：
//     · books/blocks.js 的 splitBookIntoBlocks —— 按「第X章」/Markdown 标题切块；
//     · buildChapterList —— 从块里抽出目录（连续同名标题合并）；
//     · chapterProgress.js 的 computeChapterPercent / normalizeChapterProgress。
//   桌面复用这些就能得到「同一本书、同样的章节、同样的进度口径」，
//   只是呈现为「按章滚动」而不是「按页翻」。
//
// 进度写回走共享 saveBookProgress：chapterProgress 按章记 {percent}，跨设备一致。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import { buildChapterList, splitBookIntoBlocks } from '../../../../src/books/blocks.js';
import {
  computeChapterPercent,
  normalizeChapterProgress,
} from '../../../../src/books/chapterProgress.js';
import { saveBookProgress } from '../../../../src/books/library.js';
import {
  canGrowFont,
  canShrinkFont,
  changeFontSize,
  FONT_DEFAULT,
} from '../../../../src/books/readerFont.js';
import { Button, Row, Select } from '../../settings/ui.jsx';

// 块上限：与手机 readerSettings 的默认一致（太大则「章」里塞进多章，太小则碎）。
const MAX_BLOCK_CHARS = 12000;

export default function BookReader({
  book,
  text,
  palette,
  fonts,
  onBack,
  onProgressSaved = null,
  // 当前章上报：评论面板要按「读者正在读的那一章」生成短评并锚定到该章。
  // 手机 BookCommentsModal 的「按章生成」就是这个语义（chapterTitle + anchor）。
  onChapterChange = null,
}) {
  const { t } = useTranslation();
  const [chapterIndex, setChapterIndex] = useState(0);
  // 正文字号：与手机阅读器同一套边界与步进（共享 books/readerFont.js）。
  // 手机那层还有「分页/翻页手势」，那是 RN 文本测量专属；字号是纯数值，两端应一致。
  const [fontSize, setFontSize] = useState(FONT_DEFAULT);
  // 阅读方式：滚动 / 翻页。手机有四种翻页手势（点击/滑动/仿真/淡入），
  // 桌面用 CSS 多列把同一章切成整页，左右点击或方向键翻页——语义等价，
  // 手势形态按平台（触摸 → 鼠标点击/键盘）。
  const [pageMode, setPageMode] = useState('scroll');
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const scrollRef = useRef(null);
  const pagedRef = useRef(null);

  // 切章：markdown 书按 ATX 标题优先（与手机同一开关）。
  const markdown = String(book && book.sourceFormat || '').includes('md')
    || String(book && book.name || '').toLowerCase().endsWith('.md');
  const blocks = useMemo(
    () => splitBookIntoBlocks(text || '', { maxBlockChars: MAX_BLOCK_CHARS, markdown }),
    [text, markdown]
  );
  const chapters = useMemo(() => buildChapterList(blocks), [blocks]);

  // 没有可识别标题的书：退化成「整本一章」——比不显示内容好，也如实（目录为空）。
  const hasChapters = chapters.length > 0;
  const current = hasChapters ? chapters[Math.min(chapterIndex, chapters.length - 1)] : null;
  const bodyText = hasChapters && current
    ? blocks[current.blockIndex] && blocks[current.blockIndex].text || ''
    : String(text || '');

  // 把「当前章」上报给宿主：评论生成与锚定都用它，否则评论会锚到第 0 章。
  const chapterTitle = hasChapters && current ? String(current.title || '') : '';
  const chapterBlockIndex = hasChapters && current ? Number(current.blockIndex) || 0 : 0;
  useEffect(() => {
    if (typeof onChapterChange !== 'function') return;
    onChapterChange({ title: chapterTitle, blockIndex: chapterBlockIndex });
  }, [chapterBlockIndex, chapterTitle, onChapterChange]);

  // 恢复上次进度：chapterProgress 是 { [blockIndex]: { percent } }，取第一个有记录的章。
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !hasChapters) return;
    restoredRef.current = true;
    const stored = normalizeChapterProgress(book && book.chapterProgress);
    const keys = Object.keys(stored || {})
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (keys.length === 0) return;
    const blockIndex = keys[0];
    const position = chapters.findIndex(item => item.blockIndex >= blockIndex);
    if (position >= 0) setChapterIndex(position);
  }, [book, chapters, hasChapters]);

  // 滚动节流：每帧写盘会打爆存储队列（booksMutation 是串行队列）。
  const lastSaveRef = useRef(0);
  const onScroll = () => {
    const now = Date.now();
    if (now - lastSaveRef.current < 2000) return;
    lastSaveRef.current = now;
    saveProgress();
  };

  const scrollTop = () => {
    const node = scrollRef.current;
    if (node) node.scrollTop = 0;
    const paged = pagedRef.current;
    if (paged) paged.scrollLeft = 0;
    setPageIndex(0);
  };

  // 翻页模式下量一次页数：CSS 多列把内容排成横向多页，scrollWidth/clientWidth 即页数。
  const measurePages = useCallback(() => {
    const node = pagedRef.current;
    if (!node) return;
    const width = node.clientWidth || 1;
    const count = Math.max(1, Math.round(node.scrollWidth / width));
    setPageCount(count);
    setPageIndex(Math.min(count - 1, Math.round(node.scrollLeft / width)));
  }, []);

  useEffect(() => {
    if (pageMode !== 'paged') return undefined;
    // 字号/章节变化都会改变分页：等一帧让浏览器完成布局再量。
    const timer = setTimeout(measurePages, 50);
    return () => clearTimeout(timer);
  }, [pageMode, fontSize, bodyText, measurePages]);

  const turnPage = useCallback(delta => {
    const node = pagedRef.current;
    if (!node) return;
    const width = node.clientWidth || 1;
    const next = Math.min(Math.max(0, pageIndex + delta), Math.max(0, pageCount - 1));
    node.scrollTo({ left: next * width, behavior: 'auto' });
    setPageIndex(next);
  }, [pageCount, pageIndex]);

  // 记录本章进度：滚到底记 100%。百分比口径与手机同一函数。
  const saveProgress = useCallback(async () => {
    if (!hasChapters || !current || !book || !book.id) return;
    const node = scrollRef.current;
    let ratio = 0;
    if (pageMode === 'paged') {
      // 翻页模式：按「已读页 / 总页数」记（与手机按页记进度同口径）。
      ratio = pageCount > 0 ? Math.min(1, pageIndex / pageCount) : 0;
    } else {
      const total = node ? node.scrollHeight - node.clientHeight : 0;
      ratio = total > 0 ? Math.min(1, Math.max(0, node.scrollTop / total)) : 0;
    }
    // chapterEntries 是**章节数组**（computeChapterPercent 遍历它的 blockIndex），
    // 不是块数量——传数字会让它直接返回 null，进度就永远不落盘。
    const percent = computeChapterPercent({
      chapterEntries: chapters,
      blockCount: blocks.length,
      blockIndex: current.blockIndex,
      pageIndex: Math.round(ratio * 100),
      pageCount: 100,
    });
    if (percent === null) return;
    try {
      const saved = await saveBookProgress(book.id, null, {
        [current.blockIndex]: { percent },
      });
      if (saved && typeof onProgressSaved === 'function') onProgressSaved(saved);
    } catch (error) {
      // 进度是锦上添花：写失败不打断阅读，下次滚动再试。
    }
  }, [blocks.length, book, current, hasChapters, onProgressSaved, pageCount, pageIndex, pageMode]);

  const chapterOptions = hasChapters
    ? chapters.map((item, index) => ({
      value: String(index),
      label: item.title || t('books.reader.chapterTitle'),
    }))
    : [];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 16px',
        borderBottom: `1px solid ${palette.divider}`,
        flex: 'none',
        flexWrap: 'wrap',
      }}
      >
        <Button label={t('common.back')} onClick={onBack} palette={palette} fonts={fonts} />
        <strong style={{ fontSize: fonts.scaled(14) }}>{book ? book.name : ''}</strong>
        {hasChapters ? (
          <>
            <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
              {t('books.reader.chapter.position', { index: chapterIndex + 1, total: chapters.length })}
            </span>
            <div style={{ minWidth: 160, flex: 1 }}>
              <Select
                value={String(chapterIndex)}
                options={chapterOptions}
                onChange={value => {
                  setChapterIndex(Number(value) || 0);
                  scrollTop();
                }}
                palette={palette}
                fonts={fonts}
              />
            </div>
          </>
        ) : (
          <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
            {t('books.list.chars', { count: (book && book.chars) || 0 })}
          </span>
        )}
        {/* 阅读方式：滚动 / 翻页（手机是按页翻，桌面两种都提供）。 */}
        <Button
          label={pageMode === 'paged'
            ? t('desktop.reader.mode.scroll')
            : t('desktop.reader.mode.paged')}
          onClick={() => {
            setPageMode(current => (current === 'paged' ? 'scroll' : 'paged'));
            setPageIndex(0);
          }}
          palette={palette}
          fonts={fonts}
        />
        {/* 字号增减：手机阅读器工具栏有 A- / A+，桌面此前固定 14px。 */}
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', flex: 'none' }}>
          <Button
            label="A-"
            onClick={() => setFontSize(current => changeFontSize(current, -1))}
            palette={palette}
            fonts={fonts}
            disabled={!canShrinkFont(fontSize)}
          />
          <Button
            label="A+"
            onClick={() => setFontSize(current => changeFontSize(current, 1))}
            palette={palette}
            fonts={fonts}
            disabled={!canGrowFont(fontSize)}
          />
        </div>
      </div>

      {pageMode === 'paged' ? (
        // 翻页模式：CSS 多列把本章排成横向多页，容器只显示一页宽；
        // 左右 1/3 点击与方向键翻页（手机是点击/滑动，语义一致）。
        <div
          ref={pagedRef}
          onScroll={() => {
            const node = pagedRef.current;
            if (!node) return;
            const width = node.clientWidth || 1;
            setPageIndex(Math.round(node.scrollLeft / width));
          }}
          onClick={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
            if (ratio < 1 / 3) turnPage(-1);
            else if (ratio > 2 / 3) turnPage(1);
          }}
          onKeyDown={event => {
            if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); turnPage(-1); }
            if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') { event.preventDefault(); turnPage(1); }
          }}
          tabIndex={0}
          role="group"
          aria-label={t('desktop.reader.mode.paged')}
          style={{
            flex: 1,
            overflowX: 'auto',
            overflowY: 'hidden',
            columnWidth: '100%',
            columnGap: 0,
            columnFill: 'auto',
            padding: '16px 24px',
            boxSizing: 'border-box',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: fonts.scaled(fontSize),
            lineHeight: 1.9,
            color: palette.text,
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          {bodyText || t('ext.home.books.desc')}
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '16px 24px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            // 字号走共享档位（13–26，默认 17），与手机阅读器同一套数值。
            fontSize: fonts.scaled(fontSize),
            lineHeight: 1.9,
            color: palette.text,
          }}
        >
          {bodyText || t('ext.home.books.desc')}
        </div>
      )}

      {pageMode === 'paged' ? (
        <div style={{ padding: '0 16px 8px', fontSize: fonts.scaled(10), color: palette.textFaint, flex: 'none' }}>
          {t('desktop.reader.page', { index: pageIndex + 1, total: pageCount })}
        </div>
      ) : null}

      {hasChapters ? (
        <Row>
          <div style={{ padding: '0 16px 12px', display: 'flex', gap: 8, flex: 'none' }}>
            <Button
              label={t('books.reader.chapter.prev')}
              onClick={() => {
                setChapterIndex(index => Math.max(0, index - 1));
                scrollTop();
              }}
              palette={palette}
              fonts={fonts}
              disabled={chapterIndex <= 0}
            />
            <Button
              label={t('books.reader.chapter.next')}
              onClick={() => {
                setChapterIndex(index => Math.min(chapters.length - 1, index + 1));
                scrollTop();
              }}
              palette={palette}
              fonts={fonts}
              disabled={chapterIndex >= chapters.length - 1}
            />
          </div>
        </Row>
      ) : (
        <div style={{ padding: '0 16px 12px', fontSize: fonts.scaled(10), color: palette.textFaint, flex: 'none' }}>
          {t('books.reader.noChapters.body')}
        </div>
      )}
    </div>
  );
}