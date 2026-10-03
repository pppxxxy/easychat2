// 翻页阅读器：隐藏 Text 测量 + 分页 hook + 沉浸式页面。
// 可见页只渲染分到本页的行（页首行锚文本用于字号变化后的重新定位）；
// 左右 30% 点按翻页，中间点按呼出/收起控制条；页脚显示进度与章题。

import React, { useCallback, useMemo, useState } from 'react';
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

import { splitBookIntoBlocks } from './blocks.js';
import { formatReadingPercent } from './commentPrompts.js';
import { pageText } from './pagination.js';
import { useBookComments } from './useBookComments.js';
import { buildPageTextProps, LINE_HEIGHT_RATIO, MEASURE_READY, useBookReader } from './useBookReader.js';

const FONT_MIN = 13;
const FONT_MAX = 26;
const TAP_ZONE_RATIO = 0.3;

function changeFontSize(current, delta) {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, (Math.floor(Number(current)) || 17) + delta));
}

export default function BookReaderView({ item, content, onBack }) {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const navigation = useNavigation();
  const { characters, activeId, ensureCharacterSession, setPendingQuote } = useApp();

  const [fontSize, setFontSize] = useState(17);
  const [showControls, setShowControls] = useState(true);
  const [showChapters, setShowChapters] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [contentArea, setContentArea] = useState({ width: 0, height: 0 });

  const blocks = useMemo(() => splitBookIntoBlocks(content), [content]);
  const lineHeight = Math.round(fonts.scaled(fontSize) * LINE_HEIGHT_RATIO);
  const reader = useBookReader({
    blocks,
    initial: item.progress || {},
    pageWidth: contentArea.width,
    pageHeight: contentArea.height,
    lineHeight,
  });
  const {
    comments,
    generating,
    error: commentError,
    characterId,
    setCharacterId,
    generate,
    retry,
  } = useBookComments({ book: item, characters, defaultCharacterId: activeId });

  // 生成请求取「当前页」快照：翻页后重试也以失败时的页为准（lastFailedRef 语义）。
  const handleCommentOnPage = useCallback(() => {
    if (reader.status !== MEASURE_READY || !reader.page) return;
    return generate({
      excerpt: pageText(reader.lines, reader.page, { maxChars: 600 }),
      chapterTitle: (reader.block && reader.block.title) || '',
      blockIndex: reader.blockIndex,
      anchorText: reader.page.anchorText || '',
    });
  }, [generate, reader]);

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
          name: comment.characterName || '角色',
          role: 'assistant',
          text: comment.text,
        },
      });
      setShowComments(false);
      navigation.navigate('聊天');
    } catch (error) {
      Alert.alert('无法接话', '没能打开该角色的会话，请稍后重试。');
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

  const percent = formatReadingPercent(
    reader.blockIndex,
    Math.max(1, reader.blockCount),
    reader.pageIndex,
    Math.max(1, reader.pageCount)
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
          <TouchableOpacity style={styles.backButton} onPress={onBack} accessibilityLabel="返回书架">
            <Ionicons name="chevron-back" size={20} color={theme.colors.textMuted} />
            <Text style={styles.backText}>书架</Text>
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>{item.name}</Text>
          <View style={styles.topActions}>
            <TouchableOpacity style={styles.iconButton} onPress={() => handleFontSize(-1)} accessibilityLabel="缩小字号">
              <Text style={styles.fontButtonText}>A-</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconButton} onPress={() => handleFontSize(1)} accessibilityLabel="放大字号">
              <Text style={styles.fontButtonText}>A+</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => setShowChapters(true)}
              disabled={item.chapters.length === 0}
              accessibilityLabel="章节目录"
            >
              <Ionicons name="list-outline" size={18} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => setShowComments(true)}
              accessibilityLabel="陪读评论"
            >
              <Ionicons name="chatbubbles-outline" size={18} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      <View style={styles.contentWrap}>
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
      </View>

      {showControls ? (
        <View style={styles.bottomBar}>
          <Text style={styles.progressText}>
            {percent}%{reader.block && reader.block.title ? ` · ${reader.block.title}` : ''}
            {reader.pageCount > 0 ? ` · 本段 ${reader.pageIndex + 1}/${reader.pageCount}` : ''}
          </Text>
        </View>
      ) : null}

      <Modal visible={showChapters} animationType="slide" onRequestClose={() => setShowChapters(false)}>
        <View style={[styles.container, styles.modalRoot]}>
          <View style={styles.topBar}>
            <TouchableOpacity style={styles.backButton} onPress={() => setShowChapters(false)}>
              <Ionicons name="chevron-back" size={20} color={theme.colors.textMuted} />
              <Text style={styles.backText}>返回阅读</Text>
            </TouchableOpacity>
            <Text style={styles.title}>目录</Text>
            <View style={styles.topActions} />
          </View>
          {item.chapters.length === 0 ? (
            <EmptyState
              icon="list-outline"
              title="没有识别到章节"
              description="未按「第X章」等格式命名的书籍没有目录，可直接翻页阅读。"
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
                      reader.jumpToChapter(chapter.blockIndex);
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
              <Text style={styles.backText}>返回阅读</Text>
            </TouchableOpacity>
            <Text style={styles.title}>陪读评论</Text>
            <View style={styles.topActions} />
          </View>
          <View style={styles.commentsBody}>
            <Text style={styles.sectionHint}>一起读的角色</Text>
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
                      {String(entry.name || '').trim() || '角色'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity
              style={styles.generateButton}
              onPress={handleCommentOnPage}
              disabled={generating || reader.status !== MEASURE_READY}
              activeOpacity={0.85}
            >
              {generating
                ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
                : <Ionicons name="chatbubbles" size={15} color={theme.colors.primaryContrast} />}
              <Text style={styles.generateText}>让TA聊聊这一页</Text>
            </TouchableOpacity>
            {commentError ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{commentError}</Text>
                <GhostButton title="重试" small onPress={retry} />
              </View>
            ) : null}
            {comments.length === 0 && !generating ? (
              <Text style={styles.emptyComments}>
                还没有评论。翻到想聊的一页，点上面的按钮，{characters.length > 0 ? '角色' : '选好角色后'}会在这里聊这段内容。
              </Text>
            ) : null}
            {comments.map(comment => (
              <View key={comment.id} style={styles.commentCard}>
                <View style={styles.commentHead}>
                  <Text style={styles.commentName} numberOfLines={1}>
                    {comment.characterName || '角色'}
                    {comment.chapterTitle ? ` · ${comment.chapterTitle}` : ''}
                  </Text>
                  <TouchableOpacity
                    style={styles.quoteButton}
                    onPress={() => handleQuoteComment(comment)}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.quoteButtonText}>接话</Text>
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
  fontButtonText: { color: theme.colors.text, fontSize: fonts.scaled(11), fontWeight: '700' },
  contentWrap: { flex: 1 },
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
