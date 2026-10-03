// 阅读器分页状态机：隐藏 Text 测量 → pagination.js 装箱 → 页导航。
// 正确性关键（三处必须一致）：
// 1. 隐藏测量 Text 与可见页 Text 用**同一份排版 props**（本模块 buildPageTextProps
//    统一产出，字号/行高/断行策略任何一项不一致都会切页错位）；
// 2. 行高恒定（fontSize × LINE_HEIGHT_RATIO）：切页按「每页行数 = 页高 ÷ 行高」计算，
//    不依赖各平台 onTextLayout 行对象里参差的 height 字段；
// 3. 可见页只渲染「分到本页的行」——测量漂移最多影响断页位置，绝不造成页面溢出。
// 整书不能一次测量：按块（blocks.js）逐块测，跨块翻页时短暂进入 measuring 态。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { findPageByAnchor, paginateLines } from './pagination.js';

export const LINE_HEIGHT_RATIO = 1.75;

export const MEASURE_BUSY = 'busy';
export const MEASURE_READY = 'ready';

// 排版 props 的唯一来源：测量 Text 与可见页 Text 都从这里取。
export function buildPageTextProps({ fonts, fontSize, colors }) {
  const scaled = fonts.scaled(fontSize);
  return {
    fontSize: scaled,
    lineHeight: Math.round(scaled * LINE_HEIGHT_RATIO),
    color: colors.text,
  };
}

function clampIndex(value, size) {
  const index = Math.floor(Number(value)) || 0;
  return Math.min(Math.max(0, index), Math.max(0, size - 1));
}

// pendingJump：测量完成后要落到的位置。
// - anchor：按锚文本重定位（字号变化/重开书）；
// - first：块首页（向后跨块）；
// - last：块末页（向前跨块）。
export function useBookReader({ blocks, initial = {}, pageWidth, pageHeight, lineHeight }) {
  const [blockIndex, setBlockIndex] = useState(() => clampIndex(initial.blockIndex, blocks.length));
  const [pageIndex, setPageIndex] = useState(0);
  const [status, setStatus] = useState(MEASURE_BUSY);
  const [lines, setLines] = useState([]);
  const [pages, setPages] = useState([]);
  const pendingJumpRef = useRef({ type: 'anchor', anchorText: initial.anchorText || '', pageIndex: initial.pageIndex || 0 });
  const pageHeightRef = useRef(0);

  const block = blocks[blockIndex] || null;
  const measureText = block ? block.text : '';

  // 测量入参变化即重新测量；测量请求带 id，晚到的 onTextLayout 事件按 id 丢弃。
  useEffect(() => {
    if (pageWidth <= 0 || pageHeight <= 0 || !block) return undefined;
    pageHeightRef.current = pageHeight;
    setStatus(MEASURE_BUSY);
    setLines([]);
    setPages([]);
    return undefined;
  }, [block, pageWidth, pageHeight, lineHeight]);

  const handleTextLayout = useCallback(event => {
    if (status !== MEASURE_BUSY) return;
    const nativeLines = (event && event.nativeEvent && event.nativeEvent.lines) || [];
    if (nativeLines.length === 0) return;
    const measured = nativeLines.map(line => ({
      text: String((line && line.text) || ''),
      height: lineHeight,
    }));
    const measuredPages = paginateLines(measured, pageHeightRef.current);
    if (measuredPages.length === 0) {
      setStatus(MEASURE_READY);
      return;
    }
    const jump = pendingJumpRef.current;
    pendingJumpRef.current = { type: 'first' };
    let target = 0;
    if (jump.type === 'anchor') target = findPageByAnchor(measuredPages, jump.anchorText, jump.pageIndex);
    else if (jump.type === 'last') target = measuredPages.length - 1;
    setLines(measured);
    setPages(measuredPages);
    setPageIndex(target);
    setStatus(MEASURE_READY);
  }, [lineHeight, status]);

  const goToBlock = useCallback((index, jump) => {
    const clamped = clampIndex(index, blocks.length);
    if (clamped === blockIndex) return;
    pendingJumpRef.current = jump || { type: 'first' };
    setBlockIndex(clamped);
  }, [blockIndex, blocks.length]);

  const nextPage = useCallback(() => {
    if (status !== MEASURE_READY) return false;
    if (pageIndex < pages.length - 1) {
      setPageIndex(pageIndex + 1);
      return true;
    }
    if (blockIndex < blocks.length - 1) {
      goToBlock(blockIndex + 1, { type: 'first' });
      return true;
    }
    return false;
  }, [blockIndex, blocks.length, goToBlock, pageIndex, pages.length, status]);

  const prevPage = useCallback(() => {
    if (status !== MEASURE_READY) return false;
    if (pageIndex > 0) {
      setPageIndex(pageIndex - 1);
      return true;
    }
    if (blockIndex > 0) {
      goToBlock(blockIndex - 1, { type: 'last' });
      return true;
    }
    return false;
  }, [blockIndex, goToBlock, pageIndex, status]);

  // 字号/排版变化时按当前页锚文本重定位。
  const reanchor = useCallback(() => {
    const page = pages[pageIndex];
    pendingJumpRef.current = {
      type: 'anchor',
      anchorText: page ? page.anchorText : '',
      pageIndex,
    };
  }, [pageIndex, pages]);

  // 跳章：目录给出的块号。
  const jumpToChapter = useCallback(chapterBlockIndex => {
    goToBlock(chapterBlockIndex, { type: 'first' });
  }, [goToBlock]);

  // 当前阅读位置（供进度持久化）：块号 + 页号 + 页首锚文本。测量未就绪时
  // 返回 null——没有可保存的位置，调用方跳过这次写入。
  const location = status === MEASURE_READY && pages[pageIndex]
    ? {
      blockIndex,
      pageIndex,
      anchorText: pages[pageIndex].anchorText || '',
    }
    : null;

  return useMemo(() => ({
    status,
    lines,
    pages,
    page: pages[pageIndex] || null,
    pageIndex,
    pageCount: pages.length,
    block,
    blockIndex,
    blockCount: blocks.length,
    location,
    measureText,
    handleTextLayout,
    nextPage,
    prevPage,
    jumpToChapter,
    reanchor,
    canPrev: status === MEASURE_READY && (pageIndex > 0 || blockIndex > 0),
    canNext: status === MEASURE_READY && (pageIndex < pages.length - 1 || blockIndex < blocks.length - 1),
  }), [
    block, blockIndex, blocks.length, handleTextLayout, lines, location, measureText, nextPage,
    pages, pageIndex, prevPage, reanchor, jumpToChapter, status,
  ]);
}
