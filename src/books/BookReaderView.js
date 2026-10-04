// 翻页阅读器：隐藏 Text 测量 + 分页 hook + 沉浸式页面。
// 可见页只渲染分到本页的行（页首行锚文本用于字号变化后的重新定位）；
// 左右 30% 点按翻页，中间点按呼出/收起控制条；页脚显示进度与章题。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROUTE_NAMES } from '../navigation/routeNames.js';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
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
import { saveBookProgress } from './library.js';
import { formatReadingPercent } from './commentPrompts.js';
import { pageText } from './pagination.js';
import BookMarkdownList from './BookMarkdownList.js';
import { createBookMarkdownStyles, isMarkdownBook, markdownExcerpt } from './markdownBook.js';
import { useBookComments } from './useBookComments.js';
import { buildPageTextProps, LINE_HEIGHT_RATIO, MEASURE_READY, useBookReader } from './useBookReader.js';

const FONT_MIN = 13;
const FONT_MAX = 26;
const TAP_ZONE_RATIO = 0.3;

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
  const [showComments, setShowComments] = useState(false);
  const [contentArea, setContentArea] = useState({ width: 0, height: 0 });

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
  const locationRef = useRef(null);
  locationRef.current = location;
  const progressTimerRef = useRef(null);
  const progressSavedRef = useRef('');

  useEffect(() => {
    if (!location) return undefined;
    const stamp = `${location.blockIndex}:${location.pageIndex}:${location.anchorText}`;
    if (stamp === progressSavedRef.current) return undefined;
    progressTimerRef.current = setTimeout(() => {
      progressSavedRef.current = stamp;
      saveBookProgress(item.id, location).catch(() => {});
    }, 800);
    return () => {
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    };
  }, [item.id, location]);

  // 退出兜底：防抖窗口内退出时立刻补写当前位置（fire-and-forget，失败不阻塞返回）。
  const flushProgress = useCallback(() => {
    if (progressTimerRef.current) {
      clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    const pending = locationRef.current;
    if (!pending) return;
    const stamp = `${pending.blockIndex}:${pending.pageIndex}:${pending.anchorText}`;
    if (stamp === progressSavedRef.current) return;
    progressSavedRef.current = stamp;
    saveBookProgress(item.id, pending).catch(() => {});
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

  const handleTap = useCallback(event => {
    const width = contentArea.width;
    if (width <= 0) return;
    const x = event.nativeEvent.locationX;
    if (x < width * TAP_ZONE_RATIO) {
      if (!reader.prevPage()) setShowControls(true);
      return;
    }
    if (x > width * (1 - TAP_ZONE_RATIO)) {
      if (!reader.nextPage()) setShowControls(true);
      return;
    }
    setShowControls(value => !value);
  }, [contentArea.width, reader]);

  const pageBody = reader.status === MEASURE_READY && reader.page
    ? pageText(reader.lines, reader.page)
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
            <View
              style={styles.pageArea}
              onLayout={event => {
                const { width, height } = event.nativeEvent.layout;
                setContentArea(current => (current.width === width && current.height === height ? current : { width, height }));
              }}
            >
              {pageBody ? (
                <Text style={[styles.pageText, textProps]}>{pageBody}</Text>
              ) : (
                <View style={styles.center}>
                  <ActivityIndicator color={theme.colors.primary} />
                </View>
              )}
              <Text
                style={[styles.pageText, textProps, styles.measureText]}
                onTextLayout={reader.handleTextLayout}
              >
                {reader.measureText}
              </Text>
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

      <Modal visible={showChapters} animationType="slide" onRequestClose={() => setShowChapters(false)}>
        <View style={[styles.container, styles.modalRoot]}>
          <View style={styles.topBar}>
            <TouchableOpacity style={styles.backButton} onPress={() => setShowChapters(false)}>
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
            <FlatList
              data={item.chapters}
              keyExtractor={(chapter, index) => `${chapter.blockIndex}-${index}`}
              contentContainerStyle={styles.chapterList}
              renderItem={({ item: chapter }) => {
                const active = reader.blockIndex >= chapter.blockIndex;
                return (
                  <TouchableOpacity
                    style={[styles.chapterRow, active && styles.chapterRowActive]}
                    onPress={() => {
                      if (paged) {
                        reader.jumpToChapter(chapter.blockIndex);
                      } else {
                        setMdBlockIndex(chapter.blockIndex);
                        if (mdListRef.current) mdListRef.current.scrollToIndex({ index: chapter.blockIndex, animated: false });
                      }
                      setShowChapters(false);
                    }}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.chapterText} numberOfLines={1}>{chapter.title}</Text>
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </View>
      </Modal>

      <Modal visible={showComments} animationType="slide" onRequestClose={() => setShowComments(false)}>
        <View style={[styles.container, styles.modalRoot]}>
          <View style={styles.topBar}>
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
            <TouchableOpacity
              style={styles.generateButton}
              onPress={handleCommentOnPage}
              disabled={generating || (paged ? reader.status !== MEASURE_READY : blocks.length === 0)}
              activeOpacity={0.85}
            >
              {generating
                ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
                : <Ionicons name="chatbubbles" size={15} color={theme.colors.primaryContrast} />}
              <Text style={styles.generateText}>{t('books.comments.generate')}</Text>
            </TouchableOpacity>
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
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  modalRoot: { paddingTop: 40 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
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
  mdContent: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 30 },
  pageArea: { flex: 1 },
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
    paddingVertical: 8,
  },
  progressText: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), flex: 1 },
  chapterList: { paddingHorizontal: 20, paddingBottom: 30 },
  chapterRow: {
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: tokens.radius.sm,
    marginBottom: 4,
  },
  chapterRowActive: { backgroundColor: theme.colors.surface },
  chapterText: { color: theme.colors.text, fontSize: fonts.scaled(14) },
  commentsBody: { flex: 1, paddingHorizontal: 20, paddingBottom: 20 },
  sectionHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginBottom: 6 },
  chipScroll: { flexGrow: 0, marginBottom: 10 },
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
  generateText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '600', marginLeft: 6 },
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
