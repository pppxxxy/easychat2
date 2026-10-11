import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  Alert,
  FlatList,
  Image,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { EMPTY_REPLY_TEXT, getConfigFingerprint, isCanceledError, sendChatMessage } from './network/api.js';
import { buildRequestMessages } from './prompt/chatPipeline.js';
import { getEnabledGlobalPresetPrompts } from './storage/globalPresets.js';
import { getApiConfigs } from './storage/apiConfigs.js';
import { getMessagesBySession, getSessionSummaries } from './storage/sessions.js';
import { getMoments, updateMoments } from './storage/moments.js';
import { getUserProfile } from './storage/personas.js';
import {
  buildMomentMemoryText,
  buildMomentReplyPrompt,
  normalizeMomentReply,
} from './moments/momentReply.js';
import { buildMemorySummaryText, isBuiltinAssistant, isSessionScopedMemory } from './memory/memorySummary.js';
import { runUserMomentComments } from './moments/runUserMomentComments.js';
import { flattenCommentThread } from './moments/commentThread.js';
import {
  getCommentingIds,
  startCommentTask,
  stopCommentTask,
  subscribeCommentRunner,
} from './moments/commentRunner.js';
import { createMomentsStyles } from './moments/momentsStyles.js';
import { useApp } from './context/AppContext.js';
import ChapterModal from './books/ChapterModal.js';
import { Card, EmptyState, TopicButton } from './ui/index.js';
import PaneHeader from './ui/PaneHeader.js';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';
import { maskSecrets } from './storage/secrets.js';

function formatTime(timestamp, t) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return t('moments.time.format', {
    m: date.getMonth() + 1,
    d: date.getDate(),
    hh: pad(date.getHours()),
    mm: pad(date.getMinutes()),
  });
}

export default function MomentsView({ active = true }) {
  const navigation = useNavigation();
  const { theme, fonts, tokens } = useTheme();
  const { characters, sessions } = useApp();
  const { t } = useTranslation();
  const styles = useMemo(() => createMomentsStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [moments, setMoments] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [postDraft, setPostDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [commentDrafts, setCommentDrafts] = useState({});
  // 用户对着哪条评论回应：{ [momentId]: { id, name } }。提交后清空。
  const [replyTargets, setReplyTargets] = useState({});
  const [replying, setReplying] = useState([]);
  // 后台评论任务（用户动态的角色评论）由模块级 runner 持有：退出界面也继续跑。
  const [commentingIds, setCommentingIds] = useState(() => getCommentingIds());
  const [topic, setTopic] = useState(null);
  // 评论折叠：默认只显示「查看 N 条评论」，点击展开评论列表与输入框。
  const [expandedComments, setExpandedComments] = useState(() => new Set());
  const toggleComments = useCallback(momentId => {
    setExpandedComments(prev => {
      const next = new Set(prev);
      if (next.has(momentId)) next.delete(momentId);
      else next.add(momentId);
      return next;
    });
  }, []);
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

  // 从存储重读动态列表（后台任务每写一条评论都会回调一次，让评论逐步出现）。
  const refreshFromStorage = useCallback(() => {
    if (!mountedRef.current) return;
    getMoments()
      .then(list => {
        if (mountedRef.current) setMoments(list);
      })
      .catch(() => {});
  }, []);

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

  useEffect(() => {
    if (active) return;
    pendingReplyRef.current.clear();
    requestReplyRef.current = null;
    replyControllersRef.current.forEach(controller => controller.abort());
    replyControllersRef.current.clear();
    replyingRef.current.clear();
    if (mountedRef.current) setReplying([]);
  }, [active]);

  // 订阅后台评论任务：任务增删时更新「正在评论」状态，并把结果从存储读回来。
  // 后台任务不随本组件卸载中止（见 moments/commentRunner.js），所以离开再回来时
  // 结果早已落库；这里保证停留在页面上时也能看到新评论逐步出现。
  useEffect(() => {
    const unsubscribe = subscribeCommentRunner(() => {
      if (!mountedRef.current) return;
      setCommentingIds(getCommentingIds());
      refreshFromStorage();
    });
    return unsubscribe;
  }, [refreshFromStorage]);

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

  const mutateMoments = useCallback(updater => updateMoments(updater).then(next => {
    if (mountedRef.current) setMoments(next);
    return next;
  }).catch(error => {
    if (mountedRef.current) {
      Alert.alert(
        t('moments.alert.saveFailed.title'),
        String((error && error.message) || '').includes('动态记录读取失败')
          ? t('moments.alert.saveFailed.bodyReadFailed')
          : t('moments.alert.saveFailed.bodyStorage')
      );
    }
    return null;
  }), [t]);

  const toggleLike = useCallback(moment => {
    mutateMoments(list => list.map(item => {
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
        likes: [...likes, { id: `user-${Date.now()}`, by: 'user', name: t('moments.default.userName'), createdAt: Date.now() }],
      };
    }));
  }, [mutateMoments, t]);

  // 停止某条动态正在进行的工作：中止组件内的单条回复请求，并停掉后台评论任务。
  const cancelReply = useCallback(momentId => {
    const id = String(momentId || '');
    // 用户显式停止：连待补发的那次也取消，不能停止后又被自动补发一次。
    pendingReplyRef.current.delete(id);
    const controller = replyControllersRef.current.get(id);
    if (controller) controller.abort();
    // 后台评论任务不挂在组件上（见 moments/commentRunner.js），必须单独停。
    stopCommentTask(id);
  }, []);

  const removeMoment = useCallback(moment => {
    Alert.alert(t('moments.alert.delete.title'), t('moments.alert.delete.body'), [
      { text: t('moments.cancel'), style: 'cancel' },
      {
        text: t('moments.delete'),
        style: 'destructive',
        onPress: () => {
          cancelReply(moment.id);
          mutateMoments(list => list.filter(item => item.id !== moment.id));
        },
      },
    ]);
  }, [cancelReply, moments, mutateMoments, t]);

  const appendComment = useCallback((momentId, comment) => {
    mutateMoments(list => list.map(item => (
      item.id === momentId
        ? { ...item, comments: [...(Array.isArray(item.comments) ? item.comments : []), comment] }
        : item
    )));
  }, [mutateMoments]);

  // 动态下的评论相当于一次“不写进记忆的对话”：角色依据这条动态来源的那段记忆来回复。
  // 回复只写回动态评论，不写入会话消息，也不进入记忆摘要。
  const requestReply = useCallback(async (moment, focusCommentId = '') => {
    const momentId = String((moment && moment.id) || '');
    if (!momentId || !mountedRef.current) return;
    // 已经在回复这条动态：记下来，等这次回复结束再补一次，别把新评论静默丢掉。
    if (replyingRef.current.has(momentId)) {
      pendingReplyRef.current.add(momentId);
      return;
    }
    const character = charactersRef.current.find(item => item.id === moment.characterId);
    if (!character) {
      Alert.alert(t('moments.alert.noReply.title'), t('moments.alert.noReply.bodyMissing'));
      return;
    }
    const controller = new AbortController();
    replyControllersRef.current.set(momentId, controller);
    replyingRef.current.add(momentId);
    setReplying(current => (current.includes(momentId) ? current : [...current, momentId]));
    try {
      const sessionId = String(moment.sessionId || '');
      const [summaries, messages, profile, presets, apiConfig] = await Promise.all([
        sessionId ? getSessionSummaries(sessionId).catch(() => []) : [],
        sessionId ? getMessagesBySession(sessionId).catch(() => []) : [],
        getUserProfile().catch(() => null),
        getEnabledGlobalPresetPrompts().catch(() => []),
        getApiConfigs(),
      ]);
      if (controller.signal.aborted || !mountedRef.current) return;
      const charName = String(moment.characterName || character.name || '').trim() || t('moments.default.characterName');
      const userName = String((profile && profile.userName) || '').trim() || t('app.default.userName');
      const latest = momentsRef.current.find(item => item.id === momentId) || moment;
      // 提示词里必须能看到用户刚发的那条评论（focusCommentId），但 momentsRef 可能还没
      // 追上这次更新（setState 尚未重渲染）。按 id 合并两份评论列表：既不缺刚发的，
      // 也不丢等待期间新到的；Map 保序，重复 id 取先出现的那份。
      const commentsById = new Map();
      [
        ...(Array.isArray(moment.comments) ? moment.comments : []),
        ...(Array.isArray(latest.comments) ? latest.comments : []),
      ].forEach(entry => {
        if (entry && entry.id && !commentsById.has(String(entry.id))) {
          commentsById.set(String(entry.id), entry);
        }
      });
      const threadComments = [...commentsById.values()];
      // 与聊天页同一口径：按“记忆是否按会话隔离”决定用会话摘要还是角色世界书记忆。
      // 内置助手按会话级；来源会话计入判定，避免把角色卡旧记忆带进来。
      const scoped = isBuiltinAssistant(character)
        || isSessionScopedMemory(sessionsRef.current, character.id, undefined, sessionId);
      const memoryText = buildMemorySummaryText(character, summaries, scoped)
        || buildMomentMemoryText({ summaries, messages, charName, userName });
      const prompt = buildMomentReplyPrompt({
        moment: latest,
        comments: threadComments,
        memoryText,
        charName,
        userName,
        focusCommentId: String(focusCommentId || ''),
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
       const activeConfig = apiConfig.configs.find(item => item.id === apiConfig.activeId) || apiConfig.configs[0];
       const raw = await sendChatMessage(requestMessages, {
         stream: false,
         signal: controller.signal,
         expectedConfigId: String(activeConfig && activeConfig.id || ''),
         expectedConfigFingerprint: activeConfig ? getConfigFingerprint(activeConfig) : '',
       });
      if (controller.signal.aborted || !mountedRef.current) return;
      // 接口空响应会返回占位文本：那不是角色回复，不能写进动态。
      if (String(raw || '').trim() === EMPTY_REPLY_TEXT) {
        throw new Error(t('moments.error.noReply'));
      }
      const text = normalizeMomentReply(raw);
      if (!text) throw new Error(t('moments.error.noReply'));
      appendComment(momentId, {
        id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        by: 'character',
        name: charName,
        text,
        createdAt: Date.now(),
        likedByCharacter: false,
        // 回复的是用户某条评论时挂到它下面（渲染成小标）；否则是对动态本身的顶层评论。
        ...(focusCommentId ? { replyToId: String(focusCommentId) } : {}),
      });
    } catch (error) {
      if (!isCanceledError(error) && mountedRef.current) {
        Alert.alert(t('moments.alert.noReply.title'), maskSecrets((error && error.message) || t('moments.alert.noReply.bodyRetry')));
      }
    } finally {
      // 请求簿记必须同源同判：controller、replyingRef 与“正在回复”状态是同一次请求的三份记录。
      // 只清理自己注册的那一次——旧请求的 finally 晚到时，新请求的标记不能被删掉，
      // 否则 requestReply 开头的去重失效，同一动态会并发发起重复回复（重复扣费）。
      const isLatestReply = replyControllersRef.current.get(momentId) === controller;
      if (isLatestReply) {
        replyControllersRef.current.delete(momentId);
        replyingRef.current.delete(momentId);
        if (mountedRef.current) {
          setReplying(current => current.filter(id => id !== momentId));
        }
      }
      if (isLatestReply && mountedRef.current) {
        // 回复期间又来了评论：补一次回复（用最新动态，把新评论一并带上）。
        if (pendingReplyRef.current.has(momentId)) {
          pendingReplyRef.current.delete(momentId);
          const latest = momentsRef.current.find(item => item.id === momentId);
          if (latest && requestReplyRef.current) requestReplyRef.current(latest);
        }
      }
    }
  }, [appendComment, t]);
  requestReplyRef.current = requestReply;

  const submitComment = useCallback(async moment => {
    const text = String(commentDrafts[moment.id] || '').trim();
    if (!text) return;
    // 用户可能先点了某条评论的「回复」：这条评论就挂到它下面（渲染成小标）。
    const target = replyTargets[moment.id] || null;
    const comment = {
      id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      by: 'user',
      name: t('moments.default.userName'),
      text,
      createdAt: Date.now(),
      likedByCharacter: false,
      ...(target && target.id ? { replyToId: String(target.id) } : {}),
    };
    try {
      const next = await mutateMoments(list => list.map(item => {
        if (item.id !== moment.id) return item;
        const comments = Array.isArray(item.comments) ? item.comments : [];
        const hasUserComment = comments.some(entry => entry.by === 'user');
        const updated = [...comments, comment];
        return {
          ...item,
          comments: hasUserComment
            ? updated
            : updated.map(entry => (
              entry.id === comment.id ? { ...entry, likedByCharacter: true } : entry
            )),
        };
      }));
      if (!next) throw new Error(t('moments.error.saveFailed'));
      // 保存期间用户可能已经输入了新草稿，只有内容仍是本次提交的文本时才清空。
      setCommentDrafts(current => {
        if (String(current[moment.id] || '').trim() !== text) return current;
        return { ...current, [moment.id]: '' };
      });
      setReplyTargets(current => (current[moment.id] ? { ...current, [moment.id]: null } : current));
      const latest = next.find(item => item.id === moment.id);
      if (!latest) return;
      if (latest.authorType === 'user') {
        // 用户自己的动态：只有「对着某条角色评论回应」时才让那个角色接话（挂在那条评论下）。
        // 顶层评论不触发新一轮群评——发布时已经评过一轮，再跑只会刷屏。
        if (target && target.characterId) {
          startCommentTask(latest.id, ({ signal }) => runUserMomentComments({
            momentId: latest.id,
            signal,
            mode: 'reply',
            focusCommentId: comment.id,
            responderIds: [target.characterId],
            onComment: refreshFromStorage,
          }));
        }
      } else {
        // 角色自己的动态：让发帖角色回复用户这条评论。
        requestReply(latest, comment.id);
      }
    } catch (error) {
      Alert.alert(t('moments.alert.commentSaveFailed.title'), t('moments.alert.commentSaveFailed.body'));
    }
  }, [commentDrafts, replyTargets, mutateMoments, refreshFromStorage, requestReply, t]);

  // 用户发布动态：写入 by=user 的动态后，后台串行触发「最活跃保底 + 随机」角色评论。
  const submitPost = useCallback(async () => {
    const text = String(postDraft || '').trim();
    if (!text || posting) return;
    setPosting(true);
    const momentId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const moment = {
      id: momentId,
      authorType: 'user',
      characterId: '',
      characterName: t('moments.default.userName'),
      avatarUri: '',
      sessionId: '',
      trigger: 'user-post',
      text,
      createdAt: Date.now(),
      likedByUser: false,
      likes: [],
      comments: [],
    };
    try {
      const next = await mutateMoments(list => [moment, ...(Array.isArray(list) ? list : [])]);
      if (!next) throw new Error(t('moments.error.saveFailed'));
      setPostDraft('');
      // 后台串行生成评论：交给模块级 runner 持有，退出动态页也不会被组件卸载中止
      // （用户 2026-10-11 反馈：一退出评论就断了）。停止按钮走 stopCommentTask，
      // 每写一条评论回调一次让界面逐步刷新；结果本身一直在写库。
      startCommentTask(momentId, ({ signal }) => runUserMomentComments({
        momentId,
        signal,
        onComment: refreshFromStorage,
      }));
    } catch (error) {
      Alert.alert(t('moments.alert.postFailed.title'), t('moments.alert.postFailed.body'));
    } finally {
      setPosting(false);
    }
  }, [mutateMoments, postDraft, posting, refreshFromStorage, t]);

  const renderItem = useCallback(({ item }) => {
    const likeCount = (item.likes || []).length;
    const commentsExpanded = expandedComments.has(item.id);
    const displayName = String(item.characterName || '').trim() || t('moments.default.characterName');
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
            <Text style={styles.cardTime}>{formatTime(item.createdAt, t)}</Text>
          </View>
          <TouchableOpacity
            onPress={() => removeMoment(item)}
            hitSlop={8}
            accessibilityLabel={t('moments.deleteA11y')}
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
            accessibilityLabel={item.likedByUser ? t('moments.like.unlikeA11y') : t('moments.like.a11y')}
          >
            <Ionicons
              name={item.likedByUser ? 'heart' : 'heart-outline'}
              size={16}
              color={item.likedByUser ? theme.colors.danger : theme.colors.textFaint}
            />
            <Text style={[styles.likeText, item.likedByUser && styles.likeTextActive]}>
              {likeCount > 0 ? t('moments.like.count', { n: likeCount }) : t('moments.like.label')}
            </Text>
          </TouchableOpacity>
        </View>

        {(item.comments || []).length > 0 ? (
          commentsExpanded ? (
            <View style={styles.commentList}>
              {flattenCommentThread(item.comments).map(({ comment, depth, parentName }) => {
                const commentName = String(comment.name || '').trim() || t('moments.default.userName');
                return (
                  <View
                    key={comment.id}
                    style={[styles.commentRow, depth > 0 && styles.commentRowNested]}
                  >
                    <View style={styles.commentHead}>
                      <Text style={styles.commentName}>{commentName}</Text>
                      {depth > 0 && parentName ? (
                        <Text style={styles.commentReplyTag} numberOfLines={1}>
                          {t('moments.comment.replyTo', { name: parentName })}
                        </Text>
                      ) : null}
                      <View style={styles.commentSpacer} />
                      <TouchableOpacity
                        onPress={() => setReplyTargets(current => ({
                          ...current,
                          [item.id]: {
                            id: comment.id,
                            name: commentName,
                            characterId: String(comment.characterId || ''),
                          },
                        }))}
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel={t('moments.comment.replyA11y', { name: commentName })}
                      >
                        <Text style={styles.commentReplyAction}>{t('moments.comment.reply')}</Text>
                      </TouchableOpacity>
                    </View>
                    <View style={styles.commentBody}>
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
                  </View>
                );
              })}
            </View>
          ) : (
            <TouchableOpacity
              style={styles.commentToggle}
              onPress={() => toggleComments(item.id)}
              activeOpacity={0.7}
            >
              <Text style={styles.commentToggleText}>{t('moments.comments.expand', { count: item.comments.length })}</Text>
              <Ionicons name="chevron-down" size={14} color={theme.colors.textFaint} />
            </TouchableOpacity>
          )
        ) : null}

        {replying.includes(item.id) || commentingIds.has(item.id) ? (
          <View style={styles.replyPendingRow}>
            <Text style={styles.replyPending}>
              {item.authorType === 'user' ? t('moments.replying.commenting') : t('moments.replying.character', { name: item.characterName || t('moments.default.characterName') })}
            </Text>
            <TouchableOpacity
              onPress={() => cancelReply(item.id)}
              hitSlop={8}
              accessibilityLabel={t('moments.replying.stopA11y')}
            >
              <Text style={styles.replyCancel}>{t('moments.replying.stop')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {commentsExpanded || (item.comments || []).length === 0 ? (
          <>
            {replyTargets[item.id] ? (
              <View style={styles.replyTargetRow}>
                <Text style={styles.replyTargetText} numberOfLines={1}>
                  {t('moments.comment.replyingTo', { name: replyTargets[item.id].name })}
                </Text>
                <TouchableOpacity
                  onPress={() => setReplyTargets(current => ({ ...current, [item.id]: null }))}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('moments.comment.cancelReplyA11y')}
                >
                  <Ionicons name="close" size={13} color={theme.colors.primarySoft} />
                </TouchableOpacity>
              </View>
            ) : null}
            <View style={styles.commentInputRow}>
              <TextInput
                style={styles.commentInput}
                value={commentDrafts[item.id] || ''}
                onChangeText={value => setCommentDrafts(current => ({ ...current, [item.id]: value }))}
                placeholder={replyTargets[item.id] ? t('moments.comment.replyPlaceholder') : t('moments.comment.placeholder')}
                placeholderTextColor={theme.colors.textFaint}
              />
              <TouchableOpacity
                style={styles.commentSend}
                onPress={() => submitComment(item)}
                activeOpacity={0.8}
                accessibilityLabel={t('moments.comment.sendA11y')}
              >
                <Ionicons name="send" size={14} color={theme.colors.primaryContrast} />
              </TouchableOpacity>
            </View>
          </>
        ) : null}
      </Card>
    );
  }, [cancelReply, commentingIds, commentDrafts, expandedComments, removeMoment, replying, replyTargets, styles, submitComment, t, theme.colors, toggleComments, toggleLike]);

  if (loaded && moments.length === 0) {
    return (
      <View style={styles.wrap}>
        <PaneHeader
          title={t('moments.title')}
          onBack={() => navigation.goBack()}
          right={<TopicButton onPress={() => setTopic('moments')} accessibilityLabel={t('moments.tutorial.a11y')} />}
        />
        <View style={styles.postComposer}>
          <TextInput
            style={styles.postInput}
            value={postDraft}
            onChangeText={setPostDraft}
            placeholder={t('moments.post.placeholder')}
            placeholderTextColor={theme.colors.textFaint}
            multiline
          />
          <TouchableOpacity
            style={[styles.postSend, (!postDraft.trim() || posting) && styles.postSendDisabled]}
            onPress={submitPost}
            disabled={!postDraft.trim() || posting}
            activeOpacity={0.8}
            accessibilityLabel={t('moments.post.sendA11y')}
          >
            <Ionicons name="send" size={15} color={theme.colors.primaryContrast} />
          </TouchableOpacity>
        </View>
        <EmptyState
          icon="planet-outline"
          title={t('moments.empty.title')}
          description={t('moments.empty.description')}
        />
        <ChapterModal
          visible={!!topic}
          onClose={() => setTopic(null)}
          chapterIds={topic ? [topic] : []}
          title={t('moments.tutorial.title')}
        />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <PaneHeader
        title={t('moments.title')}
        onBack={() => navigation.goBack()}
        right={<TopicButton onPress={() => setTopic('moments')} accessibilityLabel={t('moments.tutorial.a11y')} />}
      />
      <FlatList
        data={moments}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={(
          <>
            <View style={styles.postComposer}>
              <TextInput
                style={styles.postInput}
                value={postDraft}
                onChangeText={setPostDraft}
                placeholder={t('moments.post.placeholder')}
                placeholderTextColor={theme.colors.textFaint}
                multiline
              />
              <TouchableOpacity
                style={[styles.postSend, (!postDraft.trim() || posting) && styles.postSendDisabled]}
                onPress={submitPost}
                disabled={!postDraft.trim() || posting}
                activeOpacity={0.8}
                accessibilityLabel={t('moments.post.sendA11y')}
              >
                <Ionicons name="send" size={15} color={theme.colors.primaryContrast} />
              </TouchableOpacity>
            </View>
            {/* 动态由 AI 生成：显式标识常驻列表头部（与聊天页提示行同口径） */}
            <Text style={styles.aigcHint}>{t('moments.aigcHint')}</Text>
          </>
        )}
        renderItem={renderItem}
      />
      <ChapterModal
        visible={!!topic}
        onClose={() => setTopic(null)}
        chapterIds={topic ? [topic] : []}
        title={t('moments.tutorial.title')}
      />
    </View>
  );
}
