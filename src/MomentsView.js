import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
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
  updateMoments,
} from './storage';
import {
  buildMomentMemoryText,
  buildMomentReplyPrompt,
  normalizeMomentReply,
} from './moments/momentReply';
import { buildMemorySummaryText, isSessionScopedMemory } from './memorySummary';
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
  const { characters, sessions } = useApp();
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
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const replyingRef = useRef(new Set());
  // 回复进行中又提交了评论：记下来，等这次回复结束后再补一次，避免第二条评论没有回复。
  const pendingReplyRef = useRef(new Set());
  const requestReplyRef = useRef(null);
  const mountedRef = useRef(true);
  // 每条动态的回复都挂一个 AbortController，支持用户中途停止，也会在组件卸载时统一中止。
  const replyControllersRef = useRef(new Map());

  useEffect(() => {
    mountedRef.current = true;
    const controllers = replyControllersRef.current;
    return () => {
      mountedRef.current = false;
      pendingReplyRef.current.clear();
      requestReplyRef.current = null;
      controllers.forEach(controller => controller.abort());
      controllers.clear();
      replyingRef.current.clear();
    };
  }, []);

  useFocusEffect(useCallback(() => {
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
  }, [active]));

  // 写回时以“存储里的最新列表”为基准做增量：只更新仍然存在的动态、只删除
  // 明确要删的 id。这样别处（如记忆页连带删除）已经删掉的动态不会被本页的
  // 陈旧快照重新写回（复活）。
  const persist = useCallback(async (list, removedIds = []) => {
    setMoments(list);
    try {
      const merged = await updateMoments(stored => {
        const byId = new Map((Array.isArray(stored) ? stored : []).map(item => [item.id, item]));
        (Array.isArray(list) ? list : []).forEach(item => {
          if (item && byId.has(item.id)) byId.set(item.id, item);
        });
        (Array.isArray(removedIds) ? removedIds : []).forEach(id => byId.delete(String(id || '')));
        return [...byId.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      });
      setMoments(merged);
    } catch (error) {
      Alert.alert(
        '保存失败',
        String((error && error.message) || '').includes('动态记录读取失败')
          ? '动态记录读取失败，为避免覆盖已保留原数据，本次改动未保存。'
          : '请检查存储空间或权限。'
      );
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
    const id = String(momentId || '');
    // 用户显式停止：连待补发的那次也取消，不能停止后又被自动补发一次。
    pendingReplyRef.current.delete(id);
    const controller = replyControllersRef.current.get(id);
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
          persist(moments.filter(item => item.id !== moment.id), [moment.id]);
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
    if (!momentId || !mountedRef.current) return;
    // 已经在回复这条动态：记下来，等这次回复结束再补一次，别把新评论静默丢掉。
    if (replyingRef.current.has(momentId)) {
      pendingReplyRef.current.add(momentId);
      return;
    }
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
      if (controller.signal.aborted || !mountedRef.current) return;
      const charName = String(moment.characterName || character.name || '').trim() || '角色';
      const userName = String((profile && profile.userName) || '').trim() || '用户';
      const latest = momentsRef.current.find(item => item.id === momentId) || moment;
      // 与聊天页同一口径：按“记忆是否按会话隔离”决定用会话摘要还是角色世界书记忆。
      // 只有会话摘要、世界书都为空时才退化成最近几条原始消息。
      const scoped = isSessionScopedMemory(sessionsRef.current, character.id);
      const memoryText = buildMemorySummaryText(character, summaries, scoped)
        || buildMomentMemoryText({ summaries, messages, charName, userName });
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
      if (controller.signal.aborted || !mountedRef.current) return;
      // 接口空响应会返回占位文本：那不是角色回复，不能写进动态。
      if (String(raw || '').trim() === EMPTY_REPLY_TEXT) {
        throw new Error('没有收到回复内容，请稍后再试。');
      }
      const text = normalizeMomentReply(raw);
      if (!text) throw new Error('没有收到回复内容，请稍后再试。');
      appendComment(momentId, {
        id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
      if (mountedRef.current) {
        // 回复期间又来了评论：补一次回复（用最新动态，把新评论一并带上）。
        if (pendingReplyRef.current.has(momentId)) {
          pendingReplyRef.current.delete(momentId);
          const latest = momentsRef.current.find(item => item.id === momentId);
          if (latest && requestReplyRef.current) requestReplyRef.current(latest);
        }
      }
    }
  }, [appendComment]);
  requestReplyRef.current = requestReply;

  const submitComment = useCallback(moment => {
    const text = String(commentDrafts[moment.id] || '').trim();
    if (!text) return;
    const comments = Array.isArray(moment.comments) ? moment.comments : [];
    const hasUserComment = comments.some(comment => comment.by === 'user');
    const comment = {
      id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
    const displayName = String(item.characterName || '').trim() || '角色';
    const avatarUri = String(item.avatarUri || '').trim();
    return (
      <Card>
        <View style={styles.cardHeader}>
          <View style={styles.avatarWrap}>
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]}>
                <Text style={styles.avatarText}>
                  {String(displayName).slice(0, 1)}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.cardTitleWrap}>
            <Text style={styles.cardName} numberOfLines={1}>{displayName}</Text>
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
});
