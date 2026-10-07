// 翻页阅读器：隐藏 Text 测量 + 分页 hook + 沉浸式页面。
// 可见页只渲染分到本页的行（页首行锚文本用于字号变化后的重新定位）；
// 左右 30% 点按翻页，中间点按呼出/收起控制条；页脚显示进度与章题。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROUTE_NAMES } from '../navigation/routeNames.js';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Modal,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { EmptyState, GhostButton } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useApp } from '../context/AppContext.js';

import { useTranslation } from '../i18n/I18nContext.js';

import { splitBookIntoBlocks } from './blocks.js';
import { computeChapterPercent, normalizeChapterProgress } from './chapterProgress.js';
import ChapterScrubber from './ChapterScrubber.js';
import { saveBookProgress } from './library.js';
import { formatReadingPercent } from './commentPrompts.js';
import { pageBodyText, pageText } from './pagination.js';
import {
  PAGE_TURN_MODES,
  getBookReaderSettings,
  saveBookReaderSettings,
} from './readerSettings.js';
import BookMarkdownList from './BookMarkdownList.js';
import { createBookMarkdownStyles, isMarkdownBook, markdownExcerpt } from './markdownBook.js';
import { useBookComments } from './useBookComments.js';
import { buildPageTextProps, LINE_HEIGHT_RATIO, MEASURE_READY, useBookReader } from './useBookReader.js';

const FONT_MIN = 13;
const FONT_MAX = 26;
const TAP_ZONE_RATIO = 0.3;
// 阅读区上下内缩：顶栏/底栏是浮层（absolute），不参与布局——留出恒定内缩，
// 保证工具栏显隐时正文区尺寸不变（否则每次呼出工具栏都会触发重测量→转圈）。
const READER_INSET_TOP = 48;
// 底部内缩放宽到 56：底栏进度文字本身要让开系统导航栏/手势条（原来只留 40，
// 底栏又贴在屏幕最下沿，最后一行字会被遮掉一半），正文也要跟着让位。
const READER_INSET_BOTTOM = 56;

// 翻页方式：点击（原行为）/ 卡片滑动 / 旋转翻页（3D 翻转）/ 淡入淡出。
// 顺序即工具栏按钮的轮换顺序（与 readerSettings.PAGE_TURN_MODES 一致）。
const PAGE_TURN_ICONS = {
  tap: 'hand-left-outline',
  slide: 'swap-horizontal-outline',
  curl: 'book-outline',
  fade: 'contrast-outline',
};
const SWIPE_MIN_DX = 48;
const TURN_ANIM_MS = 170;
// 静态 i18n 键（动态拼接的 key 无法被文案扫描静态提取）。
const PAGE_TURN_HINT_KEYS = {
  tap: 'books.reader.pageTurn.tap',
  slide: 'books.reader.pageTurn.slide',
  curl: 'books.reader.pageTurn.curl',
  fade: 'books.reader.pageTurn.fade',
};

// 分页 hook 在 Markdown 模式下传空块数组；用模块级常量避免逐渲染新建数组引用。
const EMPTY_BLOCKS = [];

function clampBlockIndex(value, size) {
  const index = Math.floor(Number(value)) || 0;
  return Math.min(Math.max(0, index), Math.max(0, size - 1));
}

function changeFontSize(current, delta) {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, (Math.floor(Number(current)) || 17) + delta));
}

export default function BookReaderView({ item, content, onBack }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { characters, activeId, ensureCharacterSession, setPendingQuote } = useApp();

  const mdCapable = isMarkdownBook(item);
  const [renderMode, setRenderMode] = useState(mdCapable ? 'md' : 'text');
  const paged = renderMode === 'text';
  const [fontSize, setFontSize] = useState(17);
  const [showControls, setShowControls] = useState(true);
  const [showChapters, setShowChapters] = useState(false);
  // 目录搜索关键词（按章节名过滤，大小写不敏感）。
  const [chapterQuery, setChapterQuery] = useState('');
  const [showComments, setShowComments] = useState(false);
  const [contentArea, setContentArea] = useState({ width: 0, height: 0 });
  // 翻页方式（全局持久化）+ 切换时的短暂提示 + 翻页动画进度。
  const [pageTurn, setPageTurn] = useState('tap');
  const [pageTurnHint, setPageTurnHint] = useState('');
  const pageAnim = useRef(new Animated.Value(0)).current;
  const turningRef = useRef(false);

  const blocks = useMemo(() => splitBookIntoBlocks(content, { markdown: mdCapable }), [content, mdCapable]);
  const [mdBlockIndex, setMdBlockIndex] = useState(
    () => clampBlockIndex(item.progress && item.progress.blockIndex, blocks.length)
  );
  const mdListRef = useRef(null);
  const lineHeight = Math.round(fonts.scaled(fontSize) * LINE_HEIGHT_RATIO);
  const reader = useBookReader({
    // 非分页模式传空块：hook 保持惰性，不必测量不会显示的隐藏 Text。
    blocks: paged ? blocks : EMPTY_BLOCKS,
    initial: item.progress || {},
    pageWidth: contentArea.width,
    pageHeight: contentArea.height,
    lineHeight,
  });
  const markdownStyles = useMemo(
    () => createBookMarkdownStyles({ colors: theme.colors, fontSize: fonts.scaled(fontSize), lineHeight, tokens }),
    [theme.colors, fonts, fontSize, lineHeight, tokens]
  );
  const {
    comments,
    generating,
    error: commentError,
    characterId,
    setCharacterId,
    generate,
    retry,
  } = useBookComments({ book: item, characters, defaultCharacterId: activeId });

  // 统一阅读位置：分页模式取 hook 的 location；Markdown 模式以可见块为准。
  const currentBlockIndex = paged ? reader.blockIndex : mdBlockIndex;
  const currentBlock = blocks[currentBlockIndex] || null;
  // useMemo 固定引用：进度防抖 effect 以 location 为依赖，逐渲染新建对象会不断重置计时器。
  const location = useMemo(() => (
    paged
      ? reader.location
      : (blocks.length > 0 ? { blockIndex: mdBlockIndex, pageIndex: 0, anchorText: '' } : null)
  ), [paged, reader.location, mdBlockIndex, blocks.length]);

  // 生成请求取「当前页/当前段」快照：翻页后重试也以失败时的位置为准（lastFailedRef 语义）。
  const handleCommentOnPage = useCallback(() => {
    if (paged) {
      if (reader.status !== MEASURE_READY || !reader.page) return;
      return generate({
        excerpt: pageText(reader.lines, reader.page, { maxChars: 600 }),
        chapterTitle: (reader.block && reader.block.title) || '',
        blockIndex: reader.blockIndex,
        anchorText: reader.page.anchorText || '',
      });
    }
    if (!currentBlock) return;
    return generate({
      excerpt: markdownExcerpt(currentBlock.text, 600),
      chapterTitle: currentBlock.title || '',
      blockIndex: mdBlockIndex,
      anchorText: '',
    });
  }, [currentBlock, generate, mdBlockIndex, paged, reader]);

  // ---- 章节目录：当前章 / 已读进度 / 搜索 / 跳转 ----

  // 当前块的索引：分页模式看 reader，Markdown 模式看 mdBlockIndex。
  const readingBlockIndex = paged ? reader.blockIndex : mdBlockIndex;

  // 每章带上它在原数组里的下标：目录搜索过滤后仍要按**原下标**算进度、跳转与高亮。
  const chapterEntries = useMemo(() => (
    (item.chapters || []).map((chapter, index) => ({ ...chapter, index }))
  ), [item.chapters]);

  const filteredChapters = useMemo(() => {
    const keyword = chapterQuery.trim().toLowerCase();
    if (!keyword) return chapterEntries;
    return chapterEntries.filter(entry => String(entry.title || '').toLowerCase().includes(keyword));
  }, [chapterEntries, chapterQuery]);

  // 当前所在章：最后一个「起始块 ≤ 当前块」的章节（章节按 blockIndex 升序）。
  const currentChapterIndex = useMemo(() => {
    let found = 0;
    chapterEntries.forEach(entry => {
      if (entry.blockIndex <= readingBlockIndex) found = entry.index;
    });
    return found;
  }, [chapterEntries, readingBlockIndex]);

  // ---- 按章阅读进度（2026-10-07「已读完」虚报修复）----
  // 目录里每章的进度取自显式记录的 chapterProgress（chapterIndex → 0-100）：
  // 只有真的读到的章才有百分比，其余一律「未读」；同章取历史最大不回退，
  // 绝不从当前阅读位置反推历史章的进度（跳章集体虚报的根源）。
  const [chapterProgressMap, setChapterProgressMap] = useState(
    () => normalizeChapterProgress(item.chapterProgress)
  );
  const chapterProgressRef = useRef(chapterProgressMap);
  const pendingChapterPatchRef = useRef({});
  const lastSeenChapterRef = useRef(null);

  // 当前章的页粒度百分比（4 面读到第 3 面 = 75%），location 就绪才有值。
  const chapterPercent = useMemo(() => {
    if (!location || chapterEntries.length === 0) return null;
    return computeChapterPercent({
      chapterEntries,
      blockCount: Math.max(1, blocks.length),
      blockIndex: location.blockIndex,
      pageIndex: location.pageIndex,
      pageCount: paged ? reader.pageCount : 1,
    });
  }, [blocks.length, chapterEntries, location, paged, reader.pageCount]);

  const jumpToBlock = useCallback(blockIndex => {
    if (paged) {
      reader.jumpToChapter(blockIndex);
      return;
    }
    setMdBlockIndex(blockIndex);
    if (mdListRef.current) mdListRef.current.scrollToIndex({ index: blockIndex, animated: false });
  }, [mdListRef, paged, reader]);

  // ---- 目录列表定位与跟随（2026-10-07 修复）----
  // 滑块松手跳章后 currentChapterIndex 重算，但 FlatList 视口不会自己动：
  // 打开目录时定位到当前章（高亮行落在视口中部），跳章/过滤结果变化时跟随。
  const chapterListRef = useRef(null);

  const scrollToChapter = useCallback(chapterIndex => {
    const list = chapterListRef.current;
    if (!list) return;
    const index = filteredChapters.findIndex(entry => entry.index === chapterIndex);
    // 搜索过滤后目标章不在结果内：不打断用户搜索态，列表原地不动。
    if (index < 0) return;
    list.scrollToIndex({ index, viewPosition: 0.5, animated: true });
  }, [filteredChapters]);

  useEffect(() => {
    if (!showChapters) return undefined;
    // Modal 内容首帧尚未完成布局，scrollToIndex 可能直接失败——延一帧再定位，
    // 失败仍有 onChapterScrollToIndexFailed 兜底。
    const frame = requestAnimationFrame(() => scrollToChapter(currentChapterIndex));
    return () => cancelAnimationFrame(frame);
  }, [currentChapterIndex, scrollToChapter, showChapters]);

  // 虚拟化窗口外的 scrollToIndex 会失败：先按平均行高滚到估算位置，下一帧重试
  // （同 CharacterLibraryScreen 的成熟兜底）。
  const onChapterScrollToIndexFailed = useCallback(({ index, averageItemLength }) => {
    const list = chapterListRef.current;
    if (!list) return;
    const step = Math.max(1, Number(averageItemLength) || 60);
    const target = Math.max(0, Number(index) || 0);
    list.scrollToOffset?.({ offset: target * step, animated: false });
    setTimeout(() => {
      list.scrollToIndex?.({ index: target, viewPosition: 0.5, animated: true });
    }, 120);
  }, []);

  // 评论面板当前选中的角色：按钮文案要写具体名字（原来是「让TA聊聊这一页」）。
  const activeCharacter = useMemo(() => (
    (characters || []).find(entry => entry && entry.id === characterId) || null
  ), [characterId, characters]);
  const activeCharacterName = String((activeCharacter && activeCharacter.name) || '').trim()
    || t('common.characterFallback');

  // 让角色聊聊「这一章」：把整章的块文本拼成摘录（截断到 1500 字符）。
  const handleCommentChapter = useCallback(() => {
    const chapter = chapterEntries[currentChapterIndex];
    if (!chapter) return undefined;
    const start = chapter.blockIndex;
    const end = currentChapterIndex + 1 < chapterEntries.length
      ? chapterEntries[currentChapterIndex + 1].blockIndex
      : Math.max(start + 1, blocks.length);
    const excerpt = blocks
      .filter(block => block.index >= start && block.index < end)
      .map(block => String(block.text || ''))
      .join('\n')
      .trim()
      .slice(0, 1500);
    if (!excerpt) return undefined;
    return generate({
      excerpt,
      chapterTitle: chapter.title || '',
      blockIndex: start,
      anchorText: '',
    });
  }, [blocks, chapterEntries, currentChapterIndex, generate]);

  // 接话：切到该角色当前会话并把评论作为引用带入输入区（评论本体不进会话存储）。
  const handleQuoteComment = useCallback(async comment => {
    if (!comment || !comment.characterId) return;
    try {
      const session = await ensureCharacterSession(comment.characterId);
      if (!session || !session.id) throw new Error('no-session');
      setPendingQuote({
        sessionId: session.id,
        payload: {
          id: '',
          name: comment.characterName || t('common.characterFallback'),
          role: 'assistant',
          text: comment.text,
        },
      });
      setShowComments(false);
      navigation.navigate(ROUTE_NAMES.chat);
    } catch (error) {
      Alert.alert(t('books.comments.quoteFailed.title'), t('books.comments.quoteFailed.body'));
    }
  }, [ensureCharacterSession, navigation, setPendingQuote]);

  const textProps = useMemo(
    () => buildPageTextProps({ fonts, fontSize, colors: theme.colors }),
    [fonts, fontSize, theme.colors]
  );

  const handleFontSize = useCallback(delta => {
    const next = changeFontSize(fontSize, delta);
    if (next === fontSize) return; // 已到边界：不得留下过期的 pendingJump 污染下次测量
    reader.reanchor();
    setFontSize(next);
  }, [fontSize, reader]);

  const handleMdBlockChange = useCallback(index => {
    setMdBlockIndex(prev => (prev === index ? prev : index));
  }, []);

  // 分页 hook 是同一实例：从 Markdown 切回分页时用 ref 记下要跳转到的块，等 paged
  // 生效后交给 jumpToChapter（初次进入分页由 hook 的 initial 处理）。
  const pendingTextJumpRef = useRef(null);
  useEffect(() => {
    if (!paged) return;
    const target = pendingTextJumpRef.current;
    if (target == null) return;
    pendingTextJumpRef.current = null;
    if (target === reader.blockIndex) return;
    reader.jumpToChapter(target);
  }, [paged, reader]);

  const handleToggleRenderMode = useCallback(() => {
    if (paged) {
      setMdBlockIndex(reader.blockIndex);
      setRenderMode('md');
    } else {
      pendingTextJumpRef.current = mdBlockIndex;
      setRenderMode('text');
    }
  }, [mdBlockIndex, paged, reader.blockIndex]);

  // 阅读进度落库：翻页/滚动位置变化防抖 800ms 保存，退出阅读器时兜底保存一次。
  // 只存 { blockIndex, pageIndex, anchorText } —— 字号变化会改变页数，
  // 百分比是显示期计算值（见 library.js 注释）。
  // 同一防抖链路顺带落按章进度补丁：跨章时先按最后所见结算被离开的章
  // （跳章不丢进度），再记录当前章；同章取历史最大（回翻不降级）。
  const locationRef = useRef(null);
  locationRef.current = location;
  const progressTimerRef = useRef(null);
  const progressSavedRef = useRef('');

  useEffect(() => {
    if (!location || chapterPercent == null) return undefined;
    const chapterIndex = currentChapterIndex;
    const prev = lastSeenChapterRef.current;
    lastSeenChapterRef.current = { chapterIndex, percent: chapterPercent };
    const recordChapter = (index, percent) => {
      if (!Number.isFinite(percent)) return;
      const stored = Number(chapterProgressRef.current[index]);
      if (Number.isFinite(stored) && stored >= percent) return; // 历史最大，不回退
      chapterProgressRef.current = { ...chapterProgressRef.current, [index]: percent };
      pendingChapterPatchRef.current[index] = percent;
    };
    recordChapter(chapterIndex, chapterPercent);
    if (prev && prev.chapterIndex !== chapterIndex) recordChapter(prev.chapterIndex, prev.percent);
    const patch = pendingChapterPatchRef.current;
    if (Object.keys(patch).length > 0) setChapterProgressMap(chapterProgressRef.current);
    const stamp = `${location.blockIndex}:${location.pageIndex}:${location.anchorText}`;
    const hasPatch = Object.keys(patch).length > 0;
    if (stamp === progressSavedRef.current && !hasPatch) return undefined;
    progressTimerRef.current = setTimeout(() => {
      progressSavedRef.current = stamp;
      pendingChapterPatchRef.current = {};
      saveBookProgress(item.id, location, { ...patch }).catch(() => {});
    }, 800);
    return () => {
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    };
  }, [chapterPercent, currentChapterIndex, item.id, location]);

  // 退出兜底：防抖窗口内退出时立刻补写当前位置与未落库的章进度（fire-and-forget，
  // 失败不阻塞返回）。location 为 null（未完成测量）时只补章进度、不动阅读位置。
  const flushProgress = useCallback(() => {
    if (progressTimerRef.current) {
      clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    const pending = locationRef.current;
    const patch = { ...pendingChapterPatchRef.current };
    pendingChapterPatchRef.current = {};
    const hasPatch = Object.keys(patch).length > 0;
    if (!pending && !hasPatch) return;
    const stamp = pending
      ? `${pending.blockIndex}:${pending.pageIndex}:${pending.anchorText}`
      : '';
    if (stamp && stamp === progressSavedRef.current && !hasPatch) return;
    if (stamp) progressSavedRef.current = stamp;
    saveBookProgress(item.id, pending, hasPatch ? patch : null).catch(() => {});
  }, [item.id]);

  // 组件卸载（切页/换书等路径）同样兜底一次。flushProgress 幂等：
  // 与 handleBack 重复调用只会多一次同样的写入被 stamp 短路。
  useEffect(() => () => flushProgress(), [flushProgress]);

  const handleBack = useCallback(() => {
    flushProgress();
    onBack();
  }, [flushProgress, onBack]);

  const percent = formatReadingPercent(
    currentBlockIndex,
    Math.max(1, paged ? reader.blockCount : blocks.length),
    paged ? reader.pageIndex : 0,
    paged ? Math.max(1, reader.pageCount) : 1
  );

  // 翻页方式：读取全局设置（失败回退默认，不阻断阅读）。
  useEffect(() => {
    let cancelled = false;
    getBookReaderSettings()
      .then(settings => {
        if (!cancelled) setPageTurn(settings.pageTurn);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const cyclePageTurn = useCallback(() => {
    // 切模式只做三件事：停在途动画、解翻页锁、换状态。
    // 动画属性的结构交换靠分页 Animated.View 的 key={pageTurn} 重挂解决——
    // 78ec0a1 的「stopAnimation + setValue(0)」只防住了在途动画窗口，
    // curl→fade（transform 整体撤掉换 opacity）单点一次就能在原生侧踩出
    // IllegalArgumentException：RN 0.81 原生动画换结构是先挂新后卸旧、
    // restoreDefaultValues 夹在中间，帧延迟的值传播可能踩到拆一半的旧图。
    // 进度归零已移交下方 effect（提交后、新图挂稳时执行）。
    pageAnim.stopAnimation();
    turningRef.current = false;
    const index = PAGE_TURN_MODES.indexOf(pageTurn);
    const next = PAGE_TURN_MODES[(index + 1) % PAGE_TURN_MODES.length];
    setPageTurn(next);
    setPageTurnHint(t(PAGE_TURN_HINT_KEYS[next]));
    saveBookReaderSettings({ pageTurn: next }).catch(() => {});
  }, [pageAnim, pageTurn, t]);

  // 卸载时停表：动画回调持有 setState，组件已卸载后继续跑会报警甚至崩。
  useEffect(() => () => {
    pageAnim.stopAnimation();
  }, [pageAnim]);

  // 复位时机后移（2026-10-06 旋转翻页闪退修复）：key 重挂走 React 规范卸载/
  // 挂载路径，旧原生节点图随旧视图消亡、新图全新挂载；此时再归零就不会有
  // setAnimatedNodeValue 的帧延迟传播踩到拆一半的旧图。
  useEffect(() => {
    pageAnim.setValue(0);
  }, [pageAnim, pageTurn]);

  // 模式提示 1.6s 后自动消失。
  useEffect(() => {
    if (!pageTurnHint) return undefined;
    const timer = setTimeout(() => setPageTurnHint(''), 1600);
    return () => clearTimeout(timer);
  }, [pageTurnHint]);

  // 翻页：tap 模式直接切换；slide/curl/fade 先播动画（旧页移出 → 内容已切换 → 新页对侧入场）。
  const turnPage = useCallback(direction => {
    if (turningRef.current) return;
    const moved = direction > 0 ? reader.nextPage() : reader.prevPage();
    if (!moved) {
      setShowControls(true);
      return;
    }
    if (pageTurn === 'tap') return;
    const width = contentArea.width || 320;
    const exitTo = direction > 0 ? -width : width;
    turningRef.current = true;
    Animated.timing(pageAnim, {
      toValue: exitTo,
      duration: TURN_ANIM_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      // 停表（切换翻页方式 / 组件卸载）时回调仍会被调用一次，finished 为 false：
      // 必须在这里提前返回，否则会顺着链子再起一个 native 动画，而彼时动画属性结构
      // 已经变过——正是「切换方式后闪退」要避免的组合。
      if (!finished) {
        turningRef.current = false;
        return;
      }
      pageAnim.setValue(-exitTo);
      Animated.timing(pageAnim, {
        toValue: 0,
        duration: TURN_ANIM_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start(() => {
        turningRef.current = false;
      });
    });
  }, [contentArea.width, pageAnim, pageTurn, reader]);

  const handleTap = useCallback(event => {
    const width = contentArea.width;
    if (width <= 0) return;
    const x = event.nativeEvent.locationX;
    if (x < width * TAP_ZONE_RATIO) {
      turnPage(-1);
      return;
    }
    if (x > width * (1 - TAP_ZONE_RATIO)) {
      turnPage(1);
      return;
    }
    setShowControls(value => !value);
  }, [contentArea.width, turnPage]);

  // 滑动手势：仅 slide/curl 模式接管横向手势；tap 模式不挂 PanResponder。
  const panResponder = useMemo(() => {
    if (pageTurn === 'tap') return null;
    return PanResponder.create({
      onMoveShouldSetPanResponder: (event, gesture) => (
        Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4
      ),
      onPanResponderRelease: (event, gesture) => {
        if (gesture.dx <= -SWIPE_MIN_DX) turnPage(1);
        else if (gesture.dx >= SWIPE_MIN_DX) turnPage(-1);
      },
    });
  }, [pageTurn, turnPage]);

  // 翻页动画样式：slide 平移；curl 绕书脊 3D 翻转（旋转翻页）；fade 淡出淡入。
  // tap 与 slide 共用同一套 translateX 结构（tap 下进度恒为 0，视觉上不位移）。
  // 不变量：各模式结构允许不同，前提是分页 Animated.View 以 pageTurn 为 key
  // 重挂——禁止在活视图上原地换动画属性结构（RN 0.81 原生动画 attach-before-
  // detach 的原地交换不安全，78ec0a1 与 2026-10-06 两次闪退同源）。
  const pageAnimStyle = useMemo(() => {
    const width = contentArea.width || 320;
    if (pageTurn === 'curl') {
      const rotateY = pageAnim.interpolate({
        inputRange: [-width, 0, width],
        outputRange: ['70deg', '0deg', '-70deg'],
      });
      return {
        transform: [{ perspective: 1200 }, { rotateY }],
        backfaceVisibility: 'hidden',
      };
    }
    if (pageTurn === 'fade') {
      // 旧页淡出 → 内容切换 → 新页从透明淡入：进度 ±width 时完全透明，0 时完全不透明。
      const opacity = pageAnim.interpolate({
        inputRange: [-width, 0, width],
        outputRange: [0, 1, 0],
      });
      return { opacity };
    }
    return { transform: [{ translateX: pageAnim }] };
  }, [contentArea.width, pageAnim, pageTurn]);

  const pageBody = reader.status === MEASURE_READY && reader.page
    ? pageBodyText(reader.lines, reader.page)
    : '';

  return (
    <View style={styles.container}>
      {showControls ? (
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.backButton} onPress={handleBack} accessibilityLabel={t('books.reader.back')}>
            <Ionicons name="chevron-back" size={20} color={theme.colors.textMuted} />
            <Text style={styles.backText}>{t('ext.world.books.label')}</Text>
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>{item.name}</Text>
          <View style={styles.topActions}>
            {mdCapable ? (
              <TouchableOpacity
                style={[styles.iconButton, !paged && styles.iconButtonActive]}
                onPress={handleToggleRenderMode}
                accessibilityLabel={paged ? t('books.reader.a11y.toRendered') : t('books.reader.a11y.toPlain')}
              >
                <Text style={[styles.modeButtonText, !paged && styles.modeButtonTextActive]}>
                  {paged ? 'MD' : 'TXT'}
                </Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.iconButton} onPress={() => handleFontSize(-1)} accessibilityLabel={t('books.reader.a11y.shrink')}>
              <Text style={styles.fontButtonText}>A-</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconButton} onPress={() => handleFontSize(1)} accessibilityLabel={t('books.reader.a11y.grow')}>
              <Text style={styles.fontButtonText}>A+</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.iconButton}
              onPress={cyclePageTurn}
              accessibilityLabel={t('books.reader.a11y.pageTurn')}
            >
              <Ionicons name={PAGE_TURN_ICONS[pageTurn]} size={18} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => setShowChapters(true)}
              disabled={item.chapters.length === 0}
              accessibilityLabel={t('books.reader.a11y.chapters')}
            >
              <Ionicons name="list-outline" size={18} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => setShowComments(true)}
              accessibilityLabel={t('books.reader.a11y.comments')}
            >
              <Ionicons name="chatbubbles-outline" size={18} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      <View style={styles.contentWrap}>
        {paged ? (
          <TouchableWithoutFeedback onPress={handleTap}>
            <View style={styles.pageArea} {...(panResponder ? panResponder.panHandlers : null)}>
              <Animated.View
                key={pageTurn}
                style={[styles.pageInnerWrap, pageAnimStyle]}
                onLayout={event => {
                  const { width, height } = event.nativeEvent.layout;
                  setContentArea(current => (current.width === width && current.height === height ? current : { width, height }));
                }}
              >
                {/* 断行策略两处（可见页 + 下方测量 Text）必须同为 simple：
                    Android 默认 HIGH_QUALITY 是段落感知均衡断行，同一行文字在
                    「整块测量」与「行子集重排」两种上下文里断点可以不同 → 子集比
                    测量多出一行 → 末行被视图边界裁掉一半（2026-10-07 真机修复）。
                    simple 是无记忆贪心断行，与上下文无关，两处断行逐行一致。
                    这是组件 prop 不是样式键，不能进 buildPageTextProps 的 style。 */}
                {pageBody ? (
                  <Text textBreakStrategy="simple" style={[styles.pageText, textProps]}>{pageBody}</Text>
                ) : (
                  <View style={styles.center}>
                    <ActivityIndicator color={theme.colors.primary} />
                  </View>
                )}
                <Text
                  key={`measure-${reader.measureNonce}`}
                  textBreakStrategy="simple"
                  style={[styles.pageText, textProps, styles.measureText]}
                  onTextLayout={reader.handleTextLayout}
                >
                  {reader.measureText}
                </Text>
              </Animated.View>
            </View>
          </TouchableWithoutFeedback>
        ) : (
          <BookMarkdownList
            blocks={blocks}
            markdownStyles={markdownStyles}
            initialIndex={mdBlockIndex}
            onBlockChange={handleMdBlockChange}
            listRef={mdListRef}
            contentContainerStyle={styles.mdContent}
          />
        )}
      </View>

      {showControls ? (
        <View style={styles.bottomBar}>
          <Text style={styles.progressText}>
            {percent}%{currentBlock && currentBlock.title ? ` · ${currentBlock.title}` : ''}
            {paged && reader.pageCount > 0
              ? ` · ${t('books.reader.progress.blockPage', { page: reader.pageIndex + 1, total: reader.pageCount })}`
              : ''}
          </Text>
        </View>
      ) : null}

      <Modal
        visible={showChapters}
        animationType="slide"
        onRequestClose={() => { setShowChapters(false); setChapterQuery(''); }}
      >
        <View style={[styles.container, styles.modalRoot]}>
          <View style={styles.modalTopBar}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => { setShowChapters(false); setChapterQuery(''); }}
            >
              <Ionicons name="chevron-back" size={20} color={theme.colors.textMuted} />
              <Text style={styles.backText}>{t('books.reader.returnToReading')}</Text>
            </TouchableOpacity>
            <Text style={styles.title}>{t('books.reader.chapterTitle')}</Text>
            <View style={styles.topActions} />
          </View>
          {item.chapters.length === 0 ? (
            <EmptyState
              icon="list-outline"
              title={t('books.reader.noChapters.title')}
              description={t('books.reader.noChapters.body')}
            />
          ) : (
            <View style={styles.chapterBody}>
              <View style={styles.chapterSearchRow}>
                <Ionicons name="search-outline" size={15} color={theme.colors.textFaint} />
                <TextInput
                  style={styles.chapterSearchInput}
                  value={chapterQuery}
                  onChangeText={setChapterQuery}
                  placeholder={t('books.reader.chapter.search')}
                  placeholderTextColor={theme.colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                />
                {chapterQuery ? (
                  <TouchableOpacity onPress={() => setChapterQuery('')} hitSlop={8}>
                    <Ionicons name="close-circle" size={15} color={theme.colors.textFaint} />
                  </TouchableOpacity>
                ) : null}
              </View>
              {filteredChapters.length === 0 ? (
                <Text style={styles.chapterEmpty}>{t('books.reader.chapter.noMatch')}</Text>
              ) : (
                <FlatList
                  data={filteredChapters}
                  ref={chapterListRef}
                  onScrollToIndexFailed={onChapterScrollToIndexFailed}
                  keyExtractor={entry => `${entry.blockIndex}-${entry.index}`}
                  contentContainerStyle={styles.chapterList}
                  renderItem={({ item: entry }) => {
                    const current = entry.index === currentChapterIndex;
                    // 三态：未记录 → 未读；≥100 → 已读完；其余按记录的百分比。
                    const percent = chapterProgressMap[entry.index];
                    return (
                      <TouchableOpacity
                        style={[styles.chapterRow, current && styles.chapterRowCurrent]}
                        onPress={() => {
                          jumpToBlock(entry.blockIndex);
                          setShowChapters(false);
                          setChapterQuery('');
                        }}
                        activeOpacity={0.8}
                      >
                        <View style={styles.chapterRowMain}>
                          <Text
                            style={[styles.chapterText, current && styles.chapterTextCurrent]}
                            numberOfLines={1}
                          >
                            {entry.title}
                          </Text>
                          {current ? (
                            <Text style={styles.chapterCurrentBadge}>{t('books.reader.chapter.current')}</Text>
                          ) : null}
                        </View>
                        <Text style={styles.chapterPercent}>
                          {percent == null
                            ? t('books.reader.chapter.unread')
                            : percent >= 100
                              ? t('books.reader.chapter.done')
                              : t('books.reader.chapter.progress', { percent })}
                        </Text>
                      </TouchableOpacity>
                    );
                  }}
                />
              )}
              <ChapterScrubber
                chapters={chapterEntries}
                currentIndex={currentChapterIndex}
                onSeek={index => {
                  const entry = chapterEntries[index];
                  if (entry) jumpToBlock(entry.blockIndex);
                }}
              />
            </View>
          )}
        </View>
      </Modal>

      <Modal visible={showComments} animationType="slide" onRequestClose={() => setShowComments(false)}>
        <View style={[styles.container, styles.modalRoot]}>
          <View style={styles.modalTopBar}>
            <TouchableOpacity style={styles.backButton} onPress={() => setShowComments(false)}>
              <Ionicons name="chevron-back" size={20} color={theme.colors.textMuted} />
              <Text style={styles.backText}>{t('books.reader.returnToReading')}</Text>
            </TouchableOpacity>
            <Text style={styles.title}>{t('books.comments.title')}</Text>
            <View style={styles.topActions} />
          </View>
          <View style={styles.commentsBody}>
            <Text style={styles.sectionHint}>{t('books.comments.characterLabel')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
              {characters.map(entry => {
                const selected = entry.id === characterId;
                return (
                  <TouchableOpacity
                    key={entry.id}
                    style={[styles.characterChip, selected && styles.characterChipActive]}
                    onPress={() => setCharacterId(entry.id)}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[styles.characterChipText, selected && styles.characterChipTextActive]}
                      numberOfLines={1}
                    >
                      {String(entry.name || '').trim() || t('common.characterFallback')}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <View style={styles.generateRow}>
              <TouchableOpacity
                style={styles.generateButton}
                onPress={handleCommentOnPage}
                disabled={generating || (paged ? reader.status !== MEASURE_READY : blocks.length === 0)}
                activeOpacity={0.85}
              >
                {generating
                  ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
                  : <Ionicons name="chatbubbles" size={15} color={theme.colors.primaryContrast} />}
                <Text style={styles.generateText}>
                  {t('books.comments.generate', { character: activeCharacterName })}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.generateButton, styles.generateButtonChapter]}
                onPress={handleCommentChapter}
                disabled={generating || blocks.length === 0}
                activeOpacity={0.85}
              >
                <Ionicons name="book-outline" size={15} color={theme.colors.primarySoft} />
                <Text style={[styles.generateText, styles.generateTextChapter]}>
                  {t('books.comments.generateChapter', { character: activeCharacterName })}
                </Text>
              </TouchableOpacity>
            </View>
            {commentError ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{commentError}</Text>
                <GhostButton title={t('common.retry')} small onPress={retry} />
              </View>
            ) : null}
            {comments.length === 0 && !generating ? (
              <Text style={styles.emptyComments}>
                {characters.length > 0
                  ? t('books.comments.empty', { character: t('common.characterFallback') })
                  : t('books.comments.empty.noCharacter')}
              </Text>
            ) : null}
            {comments.map(comment => (
              <View key={comment.id} style={styles.commentCard}>
                <View style={styles.commentHead}>
                  <Text style={styles.commentName} numberOfLines={1}>
                    {comment.characterName || t('common.characterFallback')}
                    {comment.chapterTitle ? ` · ${comment.chapterTitle}` : ''}
                  </Text>
                  <TouchableOpacity
                    style={styles.quoteButton}
                    onPress={() => handleQuoteComment(comment)}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.quoteButtonText}>{t('books.comments.quote')}</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.commentText}>{comment.text}</Text>
              </View>
            ))}
          </View>
        </View>
      </Modal>

      {pageTurnHint ? (
        <View style={styles.modeHint} pointerEvents="none">
          <Text style={styles.modeHintText}>{pageTurnHint}</Text>
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  modalRoot: { paddingTop: 48 },
  // 目录 / 评论这类全屏 Modal 的顶栏：**不浮层**、参与布局。
  // 阅读页那套 topBar 是 absolute 贴屏幕顶，直接复用会把「返回阅读 / 目录」顶进系统状态栏。
  modalTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: tokens.border.thin,
    borderBottomColor: theme.colors.divider,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    // 浮层：不参与布局——工具栏显隐不再改变正文区高度，避免每次呼出都重测量。
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: theme.colors.background,
  },
  backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, paddingRight: 10 },
  backText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), marginLeft: 2 },
  title: {
    color: theme.colors.text,
    fontSize: fonts.scaled(15),
    fontWeight: '700',
    flex: 1,
    textAlign: 'center',
    marginHorizontal: 8,
  },
  topActions: { flexDirection: 'row', alignItems: 'center' },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  iconButtonActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  modeButtonText: { color: theme.colors.text, fontSize: fonts.scaled(10), fontWeight: '700' },
  modeButtonTextActive: { color: theme.colors.primaryContrast },
  fontButtonText: { color: theme.colors.text, fontSize: fonts.scaled(11), fontWeight: '700' },
  contentWrap: { flex: 1 },
  mdContent: {
    paddingHorizontal: 20,
    paddingTop: READER_INSET_TOP,
    paddingBottom: READER_INSET_BOTTOM,
  },
  // 恒定上下内缩，给浮层工具栏留位；pageInner 才是测量容器（尺寸不随工具栏变化）。
  pageArea: { flex: 1, paddingTop: READER_INSET_TOP, paddingBottom: READER_INSET_BOTTOM },
  pageInnerWrap: { flex: 1 },
  modeHint: {
    position: 'absolute',
    alignSelf: 'center',
    top: '45%',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: tokens.radius.pill || 999,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    zIndex: 20,
  },
  modeHintText: { color: '#FFFFFF', fontSize: fonts.scaled(13), fontWeight: '600' },
  pageText: { flex: 1 },
  measureText: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    opacity: 0,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    // 底部让开系统导航栏 / 手势条：贴到屏幕最下沿时最后一行进度字会被遮掉一半。
    paddingBottom: 24,
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: theme.colors.background,
  },
  progressText: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), flex: 1 },
  chapterBody: { flex: 1 },
  chapterSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginTop: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  chapterSearchInput: {
    flex: 1,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    marginLeft: 6,
    paddingVertical: 0,
  },
  chapterEmpty: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    marginTop: 20,
    textAlign: 'center',
  },
  // 右侧留出 46px 给定位条，章节文字不会压到滑块下面。
  chapterList: { paddingLeft: 20, paddingRight: 46, paddingBottom: 30 },
  chapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: tokens.radius.sm,
    marginBottom: 4,
  },
  // 「正在阅读」的那一章：底色 + 主色标题 + 徽标（见 chapterCurrentBadge）。
  chapterRowCurrent: { backgroundColor: theme.colors.surface },
  chapterRowMain: { flex: 1, marginRight: 8 },
  chapterText: { color: theme.colors.text, fontSize: fonts.scaled(14) },
  chapterTextCurrent: { color: theme.colors.primarySoft, fontWeight: '700' },
  chapterCurrentBadge: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(10),
    fontWeight: '700',
    marginTop: 2,
  },
  chapterPercent: { color: theme.colors.textFaint, fontSize: fonts.scaled(11) },
  commentsBody: { flex: 1, paddingHorizontal: 20, paddingBottom: 20 },
  sectionHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginBottom: 6 },
  chipScroll: { flexGrow: 0, flexShrink: 0, marginBottom: 10 },
  characterChip: {
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
  },
  characterChipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  characterChipText: { color: theme.colors.text, fontSize: fonts.scaled(12), maxWidth: 120 },
  characterChipTextActive: { color: theme.colors.primaryContrast, fontWeight: '600' },
  generateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingVertical: 10,
  },
  generateRow: { marginBottom: 10 },
  // 第二个入口用描边样式区分开：同为「让某角色聊」，但范围是整章。
  generateButtonChapter: {
    marginTop: 8,
    backgroundColor: 'transparent',
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
  },
  generateText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '600', marginLeft: 6 },
  generateTextChapter: { color: theme.colors.primarySoft },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 10,
  },
  errorText: { color: theme.colors.danger || theme.colors.text, fontSize: fonts.scaled(12), flex: 1, marginRight: 8 },
  emptyComments: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 12, lineHeight: fonts.scaled(17) },
  commentCard: {
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: 10,
    marginTop: 10,
  },
  commentHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  commentName: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), flex: 1, marginRight: 8 },
  quoteButton: {
    borderRadius: tokens.metrics.buttonRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  quoteButtonText: { color: theme.colors.primary, fontSize: fonts.scaled(11), fontWeight: '600' },
  commentText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19) },
});
