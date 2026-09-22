import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { EMPTY_REPLY_TEXT, isCanceledError, sendChatMessage } from './api';
import { buildRequestMessages } from './chatPipeline';
import {
  getEnabledGlobalPresetPrompts,
  getMessagesBySession,
  getMoments,
  getSessionSummaries,
  getUserProfile,
  saveMoments,
} from './storage';
import {
  buildMomentMemoryText,
  buildMomentReplyPrompt,
  normalizeMomentReply,
} from './moments/momentReply';
import { useApp } from './context/AppContext';
import ChapterModal from './ChapterModal';
import { Card, EmptyState, TopicButton } from './ui';
import { useTheme } from './theme/ThemeContext';

function formatTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function MomentsView({ active = true }) {
  const { theme, fonts, tokens } = useTheme();
  const { characters } = useApp();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [moments, setMoments] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [commentDrafts, setCommentDrafts] = useState({});
  const [replying, setReplying] = useState([]);
  const [topic, setTopic] = useState(null);
  const momentsRef = useRef(moments);
  momentsRef.current = moments;
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const replyingRef = useRef(new Set());
  // 每条动态的回复都挂一个 AbortController，支持用户中途停止，也会在组件卸载时统一中止。
  const replyControllersRef = useRef(new Map());

  useEffect(() => {
    const controllers = replyControllersRef.current;
    return () => {
      controllers.forEach(controller => controller.abort());
      controllers.clear();
    };
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    getMoments()
      .then(list => {
        if (!cancelled) {
          setMoments(list);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const persist = useCallback(async list => {
    setMoments(list);
    try {
      await saveMoments(list);
    } catch (error) {
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  }, []);

  const toggleLike = useCallback(moment => {
    const next = moments.map(item => {
      if (item.id !== moment.id) return item;
      const likes = Array.isArray(item.likes) ? item.likes : [];
      if (item.likedByUser) {
        return {
          ...item,
          likedByUser: false,
          likes: likes.filter(like => like.by !== 'user'),
        };
      }
      if (likes.some(like => like.by === 'user')) return { ...item, likedByUser: true };
      return {
        ...item,
        likedByUser: true,
        likes: [...likes, { id: `user-${Date.now()}`, by: 'user', name: '我', createdAt: Date.now() }],
      };
    });
    persist(next);
  }, [moments, persist]);

  // 停止某条动态正在进行的角色回复：中止请求，后续回包会被 isCanceledError 丢弃。
  const cancelReply = useCallback(momentId => {
    const controller = replyControllersRef.current.get(String(momentId || ''));
    if (controller) controller.abort();
  }, []);

  const removeMoment = useCallback(moment => {
    Alert.alert('删除动态', '确定删除这条动态吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          // 动态都删了，正在进行的回复也没必要继续
          cancelReply(moment.id);
          persist(moments.filter(item => item.id !== moment.id));
        },
      },
    ]);
  }, [cancelReply, moments, persist]);

  const appendComment = useCallback((momentId, comment) => {
    const next = momentsRef.current.map(item => (
      item.id === momentId
        ? { ...item, comments: [...(Array.isArray(item.comments) ? item.comments : []), comment] }
        : item
    ));
    persist(next);
  }, [persist]);

  // 动态下的评论相当于一次“不写进记忆的对话”：角色依据这条动态来源的那段记忆来回复。
  // 回复只写回动态评论，不写入会话消息，也不进入记忆摘要。
  const requestReply = useCallback(async moment => {
    const momentId = String((moment && moment.id) || '');
    if (!momentId || replyingRef.current.has(momentId)) return;
    const character = charactersRef.current.find(item => item.id === moment.characterId);
    if (!character) {
      Alert.alert('角色没有回复', '暂时找不到这条动态对应的角色（可能已被删除或尚未加载），请稍后再试。');
      return;
    }
    const controller = new AbortController();
    replyControllersRef.current.set(momentId, controller);
    replyingRef.current.add(momentId);
    setReplying(current => (current.includes(momentId) ? current : [...current, momentId]));
    try {
      const sessionId = String(moment.sessionId || '');
      const [summaries, messages, profile, presets] = await Promise.all([
        sessionId ? getSessionSummaries(sessionId).catch(() => []) : [],
        sessionId ? getMessagesBySession(sessionId).catch(() => []) : [],
        getUserProfile().catch(() => null),
        getEnabledGlobalPresetPrompts().catch(() => []),
      ]);
      if (controller.signal.aborted) return;
      const charName = String(character.name || moment.characterName || '').trim() || '角色';
      const userName = String((profile && profile.userName) || '').trim() || '用户';
      const latest = momentsRef.current.find(item => item.id === momentId) || moment;
      const memoryText = buildMomentMemoryText({ summaries, messages, charName, userName });
      const prompt = buildMomentReplyPrompt({
        moment: latest,
        comments: Array.isArray(latest.comments) ? latest.comments : [],
        memoryText,
        charName,
        userName,
      });
      const requestMessages = buildRequestMessages({
        character,
        historyMessages: [],
        userText: prompt,
        userProfile: profile || {},
        globalPresets: presets,
        // 记忆已经在 prompt 里说明过一次，这里不再重复注入摘要
        summaryText: '',
        memorySnippets: '',
        pluginContext: '',
        images: [],
        quote: null,
      });
      const raw = await sendChatMessage(requestMessages, { stream: false, signal: controller.signal });
      if (controller.signal.aborted) return;
      // 接口空响应会返回占位文本：那不是角色回复，不能写进动态。
      if (String(raw || '').trim() === EMPTY_REPLY_TEXT) {
        throw new Error('没有收到回复内容，请稍后再试。');
      }
      const text = normalizeMomentReply(raw);
      if (!text) throw new Error('没有收到回复内容，请稍后再试。');
      appendComment(momentId, {
        id: `r-${Date.now()}`,
        by: 'character',
        name: charName,
        text,
        createdAt: Date.now(),
        likedByCharacter: false,
      });
    } catch (error) {
      if (!isCanceledError(error)) {
        Alert.alert('角色没有回复', (error && error.message) || '请稍后再试。');
      }
    } finally {
      replyControllersRef.current.delete(momentId);
      replyingRef.current.delete(momentId);
      setReplying(current => current.filter(id => id !== momentId));
    }
  }, [appendComment]);

  const submitComment = useCallback(moment => {
    const text = String(commentDrafts[moment.id] || '').trim();
    if (!text) return;
    const comments = Array.isArray(moment.comments) ? moment.comments : [];
    const hasUserComment = comments.some(comment => comment.by === 'user');
    const comment = {
      id: `c-${Date.now()}`,
      by: 'user',
      name: '我',
      text,
      createdAt: Date.now(),
      likedByCharacter: false,
    };
    const next = moments.map(item => {
      if (item.id !== moment.id) return item;
      const list = Array.isArray(item.comments) ? item.comments : [];
      const updated = [...list, comment];
      if (!hasUserComment) {
        return {
          ...item,
          comments: updated.map(entry => (
            entry.id === comment.id ? { ...entry, likedByCharacter: true } : entry
          )),
        };
      }
      return { ...item, comments: updated };
    });
    setCommentDrafts(current => ({ ...current, [moment.id]: '' }));
    persist(next);
    requestReply(moment);
  }, [commentDrafts, moments, persist, requestReply]);

  const renderItem = useCallback(({ item }) => {
    const likeCount = (item.likes || []).length;
    return (
      <Card>
        <View style={styles.cardHeader}>
          <View style={styles.avatarWrap}>
            {item.avatarUri ? (
              <Image source={{ uri: item.avatarUri }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]}>
                <Text style={styles.avatarText}>
                  {String(item.characterName || '角').slice(0, 1)}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.cardTitleWrap}>
            <Text style={styles.cardName} numberOfLines={1}>{item.characterName || '角色'}</Text>
            <Text style={styles.cardTime}>{formatTime(item.createdAt)}</Text>
          </View>
          <TouchableOpacity
            onPress={() => removeMoment(item)}
            hitSlop={8}
            accessibilityLabel="删除动态"
          >
            <Ionicons name="trash-outline" size={16} color={theme.colors.textFaint} />
          </TouchableOpacity>
        </View>

        <Text style={styles.cardText}>{item.text}</Text>

        <View style={styles.cardActions}>
          <TouchableOpacity
            style={styles.likeButton}
            onPress={() => toggleLike(item)}
            activeOpacity={0.8}
            accessibilityLabel={item.likedByUser ? '取消点赞' : '点赞'}
          >
            <Ionicons
              name={item.likedByUser ? 'heart' : 'heart-outline'}
              size={16}
              color={item.likedByUser ? theme.colors.danger : theme.colors.textFaint}
            />
            <Text style={[styles.likeText, item.likedByUser && styles.likeTextActive]}>
              {likeCount > 0 ? `${likeCount} 赞` : '赞'}
            </Text>
          </TouchableOpacity>
        </View>

        {(item.comments || []).length > 0 ? (
          <View style={styles.commentList}>
            {item.comments.map(comment => (
              <View key={comment.id} style={styles.commentRow}>
                <Text style={styles.commentName}>{comment.name || '我'}</Text>
                <Text style={styles.commentText}>{comment.text}</Text>
                {comment.likedByCharacter ? (
                  <Ionicons
                    name="heart"
                    size={11}
                    color={theme.colors.danger}
                    style={styles.commentLike}
                  />
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {replying.includes(item.id) ? (
          <View style={styles.replyPendingRow}>
            <Text style={styles.replyPending}>
              {`${item.characterName || '角色'}正在回复…`}
            </Text>
            <TouchableOpacity
              onPress={() => cancelReply(item.id)}
              hitSlop={8}
              accessibilityLabel="停止回复"
            >
              <Text style={styles.replyCancel}>停止</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={styles.commentInputRow}>
          <TextInput
            style={styles.commentInput}
            value={commentDrafts[item.id] || ''}
            onChangeText={value => setCommentDrafts(current => ({ ...current, [item.id]: value }))}
            placeholder="写评论..."
            placeholderTextColor={theme.colors.textFaint}
          />
          <TouchableOpacity
            style={styles.commentSend}
            onPress={() => submitComment(item)}
            activeOpacity={0.8}
            accessibilityLabel="发表评论"
          >
            <Ionicons name="send" size={14} color={theme.colors.primaryContrast} />
          </TouchableOpacity>
        </View>
      </Card>
    );
  }, [cancelReply, commentDrafts, removeMoment, replying, styles, submitComment, theme.colors, toggleLike]);

  if (loaded && moments.length === 0) {
    return (
      <View style={styles.wrap}>
        <MomentHeader styles={styles} onPress={() => setTopic('moments')} />
        <EmptyState
          icon="planet-outline"
          title="还没有动态"
          description="和角色多聊聊，重要时刻会自动出现。"
        />
        <ChapterModal
          visible={!!topic}
          onClose={() => setTopic(null)}
          chapterIds={topic ? [topic] : []}
          title="教学"
        />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <MomentHeader styles={styles} onPress={() => setTopic('moments')} />
      <FlatList
        data={moments}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        renderItem={renderItem}
      />
      <ChapterModal
        visible={!!topic}
        onClose={() => setTopic(null)}
        chapterIds={topic ? [topic] : []}
        title="教学"
      />
    </View>
  );
}

function MomentHeader({ styles, onPress }) {
  return (
    <View style={styles.headerRow}>
      <Text style={styles.headerTitle}>动态</Text>
      <TopicButton
        onPress={onPress}
        accessibilityLabel="查看动态教学"
      />
    </View>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  wrap: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 10,
  },
  headerTitle: { color: theme.colors.text, fontSize: fonts.scaled(17), fontWeight: '800' },
  listContent: { paddingHorizontal: 16, paddingBottom: 30 },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  avatarWrap: { marginRight: 10 },
  avatar: { width: 40, height: 40, borderRadius: tokens.radius.pill, backgroundColor: theme.colors.surfaceBorder },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(16), fontWeight: '800' },
  cardTitleWrap: { flex: 1 },
  cardName: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '700' },
  cardTime: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 2 },
  cardText: { color: theme.colors.textMuted, fontSize: fonts.scaled(14), lineHeight: fonts.scaled(21), marginTop: 10 },
  cardActions: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  likeButton: { flexDirection: 'row', alignItems: 'center' },
  likeText: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginLeft: 4 },
  likeTextActive: { color: theme.colors.danger },
  replyPendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  replyPending: { color: theme.colors.textFaint, fontSize: fonts.scaled(12) },
  replyCancel: { color: theme.colors.primarySoft, fontSize: fonts.scaled(12), fontWeight: '700' },
  commentList: {
    marginTop: 10,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    padding: 10,
  },
  commentRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 },
  commentName: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(12), fontWeight: '700', marginRight: 6 },
  commentText: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), flexShrink: 1 },
  commentLike: { marginLeft: 6 },
  commentInputRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  commentInput: {
    flex: 1,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: tokens.radius.md,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 8,
  },
  commentSend: {
    width: 34,
    height: 34,
    borderRadius: tokens.radius.pill,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyText: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), marginTop: 10, textAlign: 'center', lineHeight: fonts.scaled(19) },
});
