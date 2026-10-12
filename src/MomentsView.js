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

import { getMoments, updateMoments } from './storage/moments.js';
import { runUserMomentComments } from './moments/runUserMomentComments.js';
import { runCharacterMomentReply } from './moments/runCharacterMomentReply.js';
import { flattenCommentThread } from './moments/commentThread.js';
import {
  getCommentingIds,
  startCommentTask,
  stopCommentTask,
  subscribeCommentRunner,
} from './moments/commentRunner.js';
import { createMomentsStyles } from './moments/momentsStyles.js';
import ChapterModal from './books/ChapterModal.js';
import { Card, EmptyState, TopicButton } from './ui/index.js';
import PaneHeader from './ui/PaneHeader.js';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';

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
  const { t } = useTranslation();
  const styles = useMemo(() => createMomentsStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [moments, setMoments] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [postDraft, setPostDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [commentDrafts, setCommentDrafts] = useState({});
  // 用户对着哪条评论回应：{ [momentId]: { id, name, characterId } }。提交后清空。
  const [replyTargets, setReplyTargets] = useState({});
  // 后台任务（用户动态的群评、角色动态的单条回复）由模块级 runner 持有：退出界面也继续跑。
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
  const mountedRef = useRef(true);

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
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 订阅后台任务：任务增删时更新「正在评论 / 正在回复」状态，并把结果从存储读回来。
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
  }).catch(() => {
    if (mountedRef.current) {
      // 分类判定看 code，不看文案（范式见 src/network/api.js:51-53）。
      // 原来比的是中文文案 includes('动态记录读取失败')，而这条 message 来自
      // storage/moments.js 的 tActive('error.storage.momentsReadFailed')——它随语言变化，
      // EN 下是英文，判定必然落空，EN 用户只会看到通用「请检查存储空间或权限」，
      // 丢掉「已保留原数据、本次改动未保存」这条关键保护信息。
      //
      // 为什么退化成「任何写失败都提示保护性文案」：读失败（数据损坏、拒绝覆盖）与
      // AsyncStorage 写入失败目前无法区分——storage/moments.js:219/227 抛的是裸 Error，
      // 只带 i18n message，没有 code/status，这里没有可比的分类标记
      //（所以连形参都省了：等 storage 层补 code 后，在这里按 code 分流）。
      // 保护性文案对任何写失败都成立（改动确实没保存），
      // 通用文案却在读失败时误导用户去查空间/权限，所以统一用保护性文案更准确。
      Alert.alert(
        t('moments.alert.saveFailed.title'),
        t('moments.alert.saveFailed.bodyReadFailed')
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

  // 停止某条动态正在进行的后台任务（群评或单条回复）：中止当前请求并丢弃排队任务。
  const cancelReply = useCallback(momentId => {
    stopCommentTask(momentId);
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
  }, [cancelReply, mutateMoments, t]);

  // 角色自己的动态：让发帖角色回复用户刚发的那条评论。
  // 交给模块级 runner（与用户动态的群评同一套），退出动态页也会跑完并写库；
  // 结果挂在那条用户评论下（replyToId），渲染成缩进的小标。
  const requestReply = useCallback((moment, focusCommentId = '') => {
    const momentId = String((moment && moment.id) || '');
    const commentId = String(focusCommentId || '');
    if (!momentId || !commentId) return;
    startCommentTask(momentId, ({ signal }) => runCharacterMomentReply({
      momentId,
      commentId,
      signal,
      onComment: refreshFromStorage,
      onError: error => {
        // 用户还在页面上时才提示；已经离开就不打扰（任务本身仍在后台跑完）。
        if (!mountedRef.current) return;
        Alert.alert(
          t('moments.alert.noReply.title'),
          String((error && error.message) || '') === 'moment-character-missing'
            ? t('moments.alert.noReply.bodyMissing')
            : t('moments.alert.noReply.bodyRetry')
        );
      },
    }));
  }, [refreshFromStorage, t]);

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
      // mutateMoments 失败时已经弹过「保存失败」并返回 null——这里直接返回，
      // 不再 throw，否则外层 catch 会为同一次失败再弹一个框（用户看到两层错误弹窗）。
      if (!next) return;
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

        {commentingIds.has(item.id) ? (
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
  }, [cancelReply, commentingIds, commentDrafts, expandedComments, removeMoment, replyTargets, styles, submitComment, t, theme.colors, toggleComments, toggleLike]);

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
