import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

import { getMoments, saveMoments } from './storage';
import ChapterModal from './ChapterModal';
import { TopicButton } from './ui';
import { useTheme } from './theme/ThemeContext';

function formatTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function MomentsView({ active = true }) {
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);
  const [moments, setMoments] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [commentDrafts, setCommentDrafts] = useState({});
  const [topic, setTopic] = useState(null);

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

  const removeMoment = useCallback(moment => {
    Alert.alert('删除动态', '确定删除这条动态吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => persist(moments.filter(item => item.id !== moment.id)),
      },
    ]);
  }, [moments, persist]);

  const submitComment = useCallback(moment => {
    const text = String(commentDrafts[moment.id] || '').trim();
    if (!text) return;
    const next = moments.map(item => {
      if (item.id !== moment.id) return item;
      const comments = Array.isArray(item.comments) ? item.comments : [];
      const hasUserComment = comments.some(comment => comment.by === 'user');
      const comment = {
        id: `c-${Date.now()}`,
        by: 'user',
        name: '我',
        text,
        createdAt: Date.now(),
        likedByCharacter: false,
      };
      let updatedComments = [...comments, comment];
      if (!hasUserComment) {
        updatedComments = updatedComments.map(entry => (
          entry.id === comment.id ? { ...entry, likedByCharacter: true } : entry
        ));
      }
      return { ...item, comments: updatedComments };
    });
    setCommentDrafts(current => ({ ...current, [moment.id]: '' }));
    persist(next);
  }, [commentDrafts, moments, persist]);

  const renderItem = useCallback(({ item }) => {
    const likeCount = (item.likes || []).length;
    return (
      <View style={styles.card}>
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
      </View>
    );
  }, [commentDrafts, removeMoment, styles, submitComment, theme.colors, toggleLike]);

  if (loaded && moments.length === 0) {
    return (
      <View style={styles.wrap}>
        <MomentHeader styles={styles} onPress={() => setTopic('moments')} />
        <View style={styles.empty}>
          <Ionicons name="planet-outline" size={32} color={theme.colors.textFaint} />
          <Text style={styles.emptyText}>还没有动态。和角色多聊聊，重要时刻会自动出现。</Text>
        </View>
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

const createStyles = (theme, fonts) => StyleSheet.create({
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
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  avatarWrap: { marginRight: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: theme.colors.surfaceBorder },
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
  commentList: {
    marginTop: 10,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 10,
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
    borderRadius: 10,
    color: theme.colors.text,
    fontSize: fonts.scaled(13),
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginRight: 8,
  },
  commentSend: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyText: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), marginTop: 10, textAlign: 'center', lineHeight: fonts.scaled(19) },
});
