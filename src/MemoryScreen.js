import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useApp } from './context/AppContext';
import ChapterModal from './ChapterModal';
import { TopicButton } from './ui';
import SearchScreen from './SearchScreen';
import { useTheme } from './theme/ThemeContext';

function formatTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const now = new Date();
  const pad = number => String(number).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function RowAction({ icon, color, onPress, label, styles }) {
  return (
    <TouchableOpacity
      style={styles.rowAction}
      onPress={onPress}
      accessibilityLabel={label}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Ionicons name={icon} size={18} color={color} />
    </TouchableOpacity>
  );
}

export default function MemoryScreen({ navigation }) {
  const {
    sessions,
    characters,
    loaded,
    switchSession,
    switchCharacter,
    pinSession,
    cloneSession,
    deleteSession,
    deleteSessions,
    setPendingTarget,
  } = useApp();

  const [searchOpen, setSearchOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [topic, setTopic] = useState(null);
  const { theme, fonts } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts), [theme, fonts]);

  const characterMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(characters) ? characters : []).forEach(character => {
      map.set(character.id, character);
    });
    return map;
  }, [characters]);

  const visibleSessions = useMemo(
    () => (Array.isArray(sessions) ? sessions : []).filter(
      session => String(session.preview || '').trim().length > 0
    ),
    [sessions]
  );

  const onOpen = useCallback(async session => {
    try {
      if (session.type !== 'group') {
        await switchCharacter(session.characterId);
      }
      await switchSession(session.id);
      navigation.navigate('聊天');
    } catch (error) {
      Alert.alert('打开失败', '请检查存储空间或权限。');
    }
  }, [navigation, switchCharacter, switchSession]);

  const onPin = useCallback(async session => {
    try {
      await pinSession(session.id);
    } catch (error) {
      Alert.alert('置顶失败', '请检查存储空间或权限。');
    }
  }, [pinSession]);

  const onClone = useCallback(session => {
    Alert.alert('克隆会话', '将复制这段对话为一段新的会话。', [
      { text: '取消', style: 'cancel' },
      {
        text: '克隆',
        onPress: () => {
          cloneSession(session.id).catch(() => {
            Alert.alert('克隆失败', '请检查存储空间或权限。');
          });
        },
      },
    ]);
  }, [cloneSession]);

  const onDelete = useCallback(session => {
    Alert.alert('删除会话', '将删除这段对话及其全部消息。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          deleteSession(session.id).catch(() => {
            Alert.alert('删除失败', '请检查存储空间或权限。');
          });
        },
      },
    ]);
  }, [deleteSession]);

  const onOpenResult = useCallback(async result => {
    try {
      const target = sessions.find(session => session.id === result.sessionId);
      if (!target || target.type !== 'group') {
        await switchCharacter(result.characterId);
      }
      await switchSession(result.sessionId);
      setPendingTarget({ sessionId: result.sessionId, messageId: result.messageId });
      setSearchOpen(false);
      navigation.navigate('聊天');
    } catch (error) {
      Alert.alert('打开失败', '请检查存储空间或权限。');
    }
  }, [navigation, sessions, setPendingTarget, switchCharacter, switchSession]);

  const exitEdit = useCallback(() => {
    setEditing(false);
    setSelectedIds([]);
  }, []);

  const toggleSelect = useCallback(id => {
    setSelectedIds(current =>
      current.includes(id) ? current.filter(item => item !== id) : [...current, id]
    );
  }, []);

  const allSelected = visibleSessions.length > 0
    && selectedIds.length === visibleSessions.length;

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(current =>
      current.length === visibleSessions.length
        ? []
        : visibleSessions.map(session => session.id)
    );
  }, [visibleSessions]);

  const onBatchDelete = useCallback(() => {
    if (selectedIds.length === 0) return;
    const count = selectedIds.length;
    Alert.alert('删除会话', `确定删除选中的 ${count} 段对话及其消息吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          deleteSessions(selectedIds)
            .then(() => exitEdit())
            .catch(() => {
              Alert.alert('删除失败', '请检查存储空间或权限。');
            });
        },
      },
    ]);
  }, [selectedIds, deleteSessions, exitEdit]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>记忆</Text>
        <View style={styles.headerRight}>
          <TopicButton
            style={styles.topicButton}
            onPress={() => setTopic('memory')}
            accessibilityLabel="查看记忆界面教学"
          />
          {editing ? null : (
            <Text style={styles.count}>
              {loaded ? `${visibleSessions.length} 段对话` : '加载中'}
            </Text>
          )}
          {loaded && visibleSessions.length > 0 ? (
            <TouchableOpacity
              style={styles.editButton}
              onPress={editing ? exitEdit : () => setEditing(true)}
              activeOpacity={0.7}
              accessibilityLabel={editing ? '完成编辑' : '编辑会话'}
            >
              <Text style={styles.editButtonText}>{editing ? '完成' : '编辑'}</Text>
            </TouchableOpacity>
          ) : null}
          {editing ? null : (
            <TouchableOpacity
              style={styles.searchButton}
              onPress={() => setSearchOpen(true)}
              activeOpacity={0.7}
              accessibilityLabel="搜索历史聊天记录"
            >
              <Ionicons name="search" size={18} color={theme.colors.primarySoft} />
            </TouchableOpacity>
          )}
        </View>
      </View>
      {loaded && visibleSessions.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Ionicons name="albums-outline" size={40} color={theme.colors.textFaint} />
          <Text style={styles.emptyTitle}>还没有历史对话</Text>
          <Text style={styles.emptyHint}>去聊天页开始一段新的对话吧。</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          {visibleSessions.map(session => {
            const character = characterMap.get(session.characterId);
            const isGroup = session.type === 'group';
            const groupMembers = isGroup
              ? (session.members || []).map(id => characterMap.get(id)).filter(Boolean)
              : [];
            const name = isGroup
              ? (session.name || groupMembers.map(item => item.name).join('、') || '群聊')
              : ((character && character.name) || '未命名角色');
            const isClone = !!session.clonedFrom;
            return (
              <View
                key={session.id}
                style={[
                  styles.card,
                  editing && selectedIds.includes(session.id) && styles.cardSelected,
                ]}
              >
                <TouchableOpacity
                  style={styles.cardMain}
                  activeOpacity={0.75}
                  onPress={() => (editing ? toggleSelect(session.id) : onOpen(session))}
                >
                  {editing ? (
                    <Ionicons
                      name={selectedIds.includes(session.id) ? 'checkbox' : 'square-outline'}
                      size={22}
                      color={selectedIds.includes(session.id) ? theme.colors.primaryMuted : theme.colors.textFaint}
                      style={styles.checkbox}
                    />
                  ) : null}
                  {isGroup ? (
                    session.avatarUri ? (
                      <Image source={{ uri: session.avatarUri }} style={styles.avatar} />
                    ) : (
                      <View style={styles.groupAvatars}>
                        {groupMembers.slice(0, 3).map((member, index) => (
                          member.avatarUri ? (
                            <Image
                              key={member.id}
                              source={{ uri: member.avatarUri }}
                              style={[styles.groupAvatar, { left: index * 12 }]}
                            />
                          ) : (
                            <View
                              key={member.id}
                              style={[styles.groupAvatar, styles.avatarFallback, { left: index * 12 }]}
                            >
                              <Text style={styles.avatarText}>
                                {String(member.name || '?').charAt(0)}
                              </Text>
                            </View>
                          )
                        ))}
                      </View>
                    )
                  ) : character && character.avatarUri ? (
                    <Image source={{ uri: character.avatarUri }} style={styles.avatar} />
                  ) : (
                    <View style={[styles.avatar, styles.avatarFallback]}>
                      <Text style={styles.avatarText}>{name.slice(0, 1)}</Text>
                    </View>
                  )}
                  <View style={styles.cardText}>
                    <View style={styles.nameRow}>
                      <Text style={styles.name} numberOfLines={1}>{name}</Text>
                      {isClone ? <Text style={styles.badge}>副本</Text> : null}
                      {session.pinned ? (
                        <Ionicons name="star" size={12} color={theme.colors.star} style={styles.pinMark} />
                      ) : null}
                    </View>
                    <Text style={styles.preview} numberOfLines={2}>
                      {session.preview}
                    </Text>
                    <Text style={styles.time}>{formatTime(session.updatedAt)}</Text>
                  </View>
                </TouchableOpacity>
                {editing ? null : (
                  <View style={styles.actions}>
                    <RowAction
                      icon={session.pinned ? 'star' : 'star-outline'}
                      color={session.pinned ? theme.colors.star : theme.colors.textFaint}
                      label="置顶"
                      styles={styles}
                      onPress={() => onPin(session)}
                    />
                    <RowAction
                      icon="copy-outline"
                      color={theme.colors.textFaint}
                      label="克隆"
                      styles={styles}
                      onPress={() => onClone(session)}
                    />
                    <RowAction
                      icon="trash-outline"
                      color={theme.colors.danger}
                      label="删除"
                      styles={styles}
                      onPress={() => onDelete(session)}
                    />
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}

      {editing ? (
        <View style={styles.editBar}>
          <TouchableOpacity
            style={styles.selectAll}
            onPress={toggleSelectAll}
            activeOpacity={0.7}
          >
            <Ionicons
              name={allSelected ? 'checkbox' : 'square-outline'}
              size={20}
              color={theme.colors.primarySoft}
            />
            <Text style={styles.selectAllText}>
              {allSelected ? '取消全选' : '全选'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.deleteButton, selectedIds.length === 0 && styles.disabled]}
            onPress={onBatchDelete}
            disabled={selectedIds.length === 0}
            activeOpacity={0.8}
          >
            <Text style={styles.deleteButtonText}>{`删除（${selectedIds.length}）`}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <SearchScreen
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenResult={onOpenResult}
        characters={characters}
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

const createStyles = (theme, fonts) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 10,
  },
  title: { color: theme.colors.text, fontSize: fonts.scaled(20), fontWeight: '800' },
  count: { color: theme.colors.textFaint, fontSize: fonts.scaled(13) },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  topicButton: {
    marginRight: 6,
  },
  searchButton: {
    marginLeft: 12,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${theme.colors.primary}2e`,
    borderWidth: 1,
    borderColor: `${theme.colors.primaryMuted}59`,
  },
  editButton: { marginLeft: 12, paddingVertical: 6, paddingHorizontal: 4 },
  editButtonText: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(14), fontWeight: '700' },
  checkbox: { marginRight: 10 },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    marginBottom: 10,
    paddingLeft: 12,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  cardSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surfaceAlt,
  },
  cardMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingRight: 6,
  },
  avatar: { width: 46, height: 46, borderRadius: 12, backgroundColor: theme.colors.surfaceBorder },
  groupAvatars: { width: 46, height: 46, marginRight: 0 },
  groupAvatar: {
    position: 'absolute',
    top: 0,
    width: 34,
    height: 34,
    borderRadius: 9,
    backgroundColor: theme.colors.surfaceBorder,
    borderWidth: 1,
    borderColor: theme.colors.surfaceAlt,
  },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: theme.colors.textMuted, fontSize: fonts.scaled(18), fontWeight: '700' },
  cardText: { flex: 1, marginLeft: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  name: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700', maxWidth: '70%' },
  badge: {
    marginLeft: 6,
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(10),
    fontWeight: '700',
    backgroundColor: `${theme.colors.primary}40`,
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  pinMark: { marginLeft: 6 },
  preview: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(18), marginTop: 4 },
  time: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 5 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 8,
  },
  rowAction: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 80,
  },
  emptyTitle: { color: theme.colors.textMuted, fontSize: fonts.scaled(15), fontWeight: '700', marginTop: 14 },
  emptyHint: { color: theme.colors.textFaint, fontSize: fonts.scaled(13), marginTop: 6 },
  editBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
    backgroundColor: theme.colors.surfaceAlt,
  },
  selectAll: { flexDirection: 'row', alignItems: 'center' },
  selectAllText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(14), fontWeight: '700', marginLeft: 8 },
  deleteButton: {
    backgroundColor: theme.colors.danger,
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  deleteButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '700' },
  disabled: { opacity: 0.45 },
});
