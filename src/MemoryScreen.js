import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import {
  deleteMomentsBySessionIds,
  findOrphanSessions,
  getMessagesBySession,
  getMoments,
  getUserProfile,
  restoreSession,
} from './storage';
import { buildPreview } from './context/sessionLibrary';
import { countMomentsBySessionIds } from './moments/moments';
import ChapterModal from './ChapterModal';
import SessionRecoveryModal from './SessionRecoveryModal';
import { Card, EmptyState, TopicButton } from './ui';
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
    refreshSessions,
  } = useApp();

  const [searchOpen, setSearchOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [topic, setTopic] = useState(null);
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  // 旧版本新建对话会误删会话记录：扫出"消息还在、会话没了"的对话，供用户恢复
  const [orphans, setOrphans] = useState([]);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [userName, setUserName] = useState('');

  const scanOrphans = useCallback(async () => {
    try {
      const [list, profile] = await Promise.all([
        findOrphanSessions(),
        getUserProfile().catch(() => null),
      ]);
      setOrphans(list);
      setUserName(String((profile && profile.userName) || '').trim());
    } catch (error) {
      setOrphans([]);
      Alert.alert(
        '无法检查丢失的对话',
        (error && error.message) || '会话记录暂时读不出来，请稍后重试。'
      );
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    scanOrphans();
  }, [loaded, scanOrphans]);

  // 聊天页保存消息时只写存储、不会同步 Context 的会话列表；回到记忆页若
  // 不重读，就会看到过期的 preview/updatedAt（空会话、排到底部都是这个原因）。
  useEffect(() => {
    if (!navigation) return undefined;
    const refresh = () => {
      refreshSessions().catch(() => {});
    };
    refresh();
    const unsubscribe = navigation.addListener('focus', refresh);
    return unsubscribe;
  }, [navigation, refreshSessions]);

  const onRecover = useCallback(async (orphan, characterId) => {
    try {
      await restoreSession(orphan.sessionId, characterId);
      await refreshSessions();
      setOrphans(current => current.filter(item => item.sessionId !== orphan.sessionId));
      Alert.alert('已恢复', '这段对话已回到列表，它的记忆摘要也会一起生效。');
    } catch (error) {
      Alert.alert('恢复失败', (error && error.message) || '请稍后重试。');
    }
  }, [refreshSessions]);

  const characterMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(characters) ? characters : []).forEach(character => {
      map.set(character.id, character);
    });
    return map;
  }, [characters]);

  // 不再隐藏“空会话”：消息被清空过的会话 preview 会变成空串，若过滤掉就会
  // 既看不见也删不掉。这里只保留存储层给的排序（置顶优先、updatedAt 降序），
  // 不再按 preview 是否为空重排——否则最近用过但 preview 暂未同步的会话会被压到底部。
  const visibleSessions = useMemo(
    () => (Array.isArray(sessions) ? sessions : []),
    [sessions]
  );

  // 兜底：存储里的 preview 可能缺失（历史会话 / 某次写盘没同步），但消息体还在。
  // 对空 preview 的会话读一次消息体补出摘要，避免“明明聊过却显示空会话”。
  const [previewFallback, setPreviewFallback] = useState({});
  useEffect(() => {
    const missing = visibleSessions.filter(session => !String((session && session.preview) || '').trim());
    if (missing.length === 0) return undefined;
    let cancelled = false;
    (async () => {
      const found = {};
      for (const session of missing) {
        try {
          const messages = await getMessagesBySession(session.id);
          const text = buildPreview(messages);
          if (text) found[session.id] = text;
        } catch (error) {}
      }
      if (!cancelled && Object.keys(found).length > 0) {
        setPreviewFallback(current => ({ ...current, ...found }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visibleSessions]);

  const onOpen = useCallback(async session => {
    try {
      if (session.type !== 'group' && characterMap.has(session.characterId)) {
        await switchCharacter(session.characterId);
      }
      await switchSession(session.id);
      navigation.navigate('聊天');
    } catch (error) {
      Alert.alert('打开失败', '请检查存储空间或权限。');
    }
  }, [characterMap, navigation, switchCharacter, switchSession]);

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

  // 动态可能锚定在某段对话（记忆）上：删除记忆时，提示是否连带删除对应动态。
  const countLinkedMoments = useCallback(async sessionIds => {
    const list = await getMoments();
    return countMomentsBySessionIds(list, sessionIds);
  }, []);

  // 先删动态再删会话：读不出动态时直接抛错中止，绝不在“动态删除没成功”的情况下
  // 先把会话删掉，留下指向不存在会话的孤儿动态。
  const removeMomentsOfSessions = useCallback(sessionIds => (
    deleteMomentsBySessionIds(sessionIds)
  ), []);

  const onDelete = useCallback(session => {
    const runDelete = async deleteMomentsToo => {
      // 动态先删、会话后删：第二步失败时明确告知动态已删，别让用户以为整件事失败。
      let momentsDeleted = false;
      try {
        if (deleteMomentsToo) {
          await removeMomentsOfSessions([session.id]);
          momentsDeleted = true;
        }
        await deleteSession(session.id);
      } catch (error) {
        Alert.alert(
          '删除失败',
          momentsDeleted
            ? '关联动态已删除，但这段记忆删除失败，请重试。'
            : '请检查存储空间或权限。'
        );
      }
    };
    countLinkedMoments([session.id])
      .then(count => {
        if (count === 0) {
          Alert.alert('删除会话', '将删除这段对话及其全部消息。', [
            { text: '取消', style: 'cancel' },
            { text: '删除', style: 'destructive', onPress: () => { runDelete(false); } },
          ]);
          return;
        }
        Alert.alert(
          '删除记忆',
          `这段记忆对应 ${count} 条动态，要一起删除吗？`,
          [
            { text: '取消', style: 'cancel' },
            { text: '只删记忆', onPress: () => { runDelete(false); } },
            { text: '一起删除', style: 'destructive', onPress: () => { runDelete(true); } },
          ]
        );
      })
      .catch(() => {
        Alert.alert('删除失败', '没能读出关联动态，请稍后重试。');
      });
  }, [countLinkedMoments, deleteSession, removeMomentsOfSessions]);

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
    const runDelete = async deleteMomentsToo => {
      let momentsDeleted = false;
      try {
        if (deleteMomentsToo) {
          await removeMomentsOfSessions(selectedIds);
          momentsDeleted = true;
        }
        await deleteSessions(selectedIds);
        exitEdit();
      } catch (error) {
        Alert.alert(
          '删除失败',
          momentsDeleted
            ? '关联动态已删除，但选中的记忆删除失败，请重试。'
            : '请检查存储空间或权限。'
        );
      }
    };
    countLinkedMoments(selectedIds)
      .then(linked => {
        if (linked === 0) {
          Alert.alert('删除会话', `确定删除选中的 ${count} 段对话及其消息吗？`, [
            { text: '取消', style: 'cancel' },
            { text: '删除', style: 'destructive', onPress: () => { runDelete(false); } },
          ]);
          return;
        }
        Alert.alert(
          '删除记忆',
          `选中的 ${count} 段对话对应 ${linked} 条动态，要一起删除吗？`,
          [
            { text: '取消', style: 'cancel' },
            { text: '只删记忆', onPress: () => { runDelete(false); } },
            { text: '一起删除', style: 'destructive', onPress: () => { runDelete(true); } },
          ]
        );
      })
      .catch(() => {
        Alert.alert('删除失败', '没能读出关联动态，请稍后重试。');
      });
  }, [countLinkedMoments, deleteSessions, exitEdit, removeMomentsOfSessions, selectedIds]);

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
      {orphans.length > 0 ? (
        <TouchableOpacity
          style={styles.recoverNotice}
          onPress={() => setRecoverOpen(true)}
          activeOpacity={0.8}
          accessibilityLabel="恢复丢失的对话"
        >
          <Ionicons name="alert-circle-outline" size={13} color={theme.colors.star} />
          <Text style={styles.recoverNoticeText}>
            {`发现 ${orphans.length} 段丢失的对话，点此恢复`}
          </Text>
        </TouchableOpacity>
      ) : null}
      {loaded && visibleSessions.length === 0 ? (
        <EmptyState
          icon="albums-outline"
          title="还没有历史对话"
          description="去聊天页开始一段新的对话吧。"
        />
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
              <Card
                key={session.id}
                padded={false}
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
                      {String(session.preview || '').trim()
                        || String(previewFallback[session.id] || '').trim()
                        || '（空会话，可删除）'}
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
              </Card>
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

      <SessionRecoveryModal
        visible={recoverOpen}
        orphans={orphans}
        characters={characters}
        userName={userName}
        onClose={() => setRecoverOpen(false)}
        onRecover={onRecover}
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

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
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
  recoverNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginBottom: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: tokens.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  recoverNoticeText: {
    marginLeft: 6,
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    fontWeight: '700',
  },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  topicButton: {
    marginRight: 6,
  },
  searchButton: {
    marginLeft: 12,
    width: 34,
    height: 34,
    borderRadius: tokens.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.primaryAlpha(0.14),
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primaryMutedAlpha(0.35),
  },
  editButton: { marginLeft: 12, paddingVertical: 6, paddingHorizontal: 4 },
  editButtonText: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(14), fontWeight: '700' },
  checkbox: { marginRight: 10 },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 12,
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
  avatar: { width: 48, height: 48, borderRadius: tokens.radius.md, backgroundColor: theme.colors.surfaceBorder },
  groupAvatars: { width: 48, height: 48, marginRight: 0 },
  groupAvatar: {
    position: 'absolute',
    top: 0,
    width: 34,
    height: 34,
    borderRadius: tokens.radius.sm,
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
    backgroundColor: theme.colors.primaryAlpha(0.2),
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primaryMutedAlpha(0.35),
    borderRadius: tokens.radius.pill,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  pinMark: { marginLeft: 6 },
  preview: { color: theme.colors.textMuted, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(20), marginTop: 4 },
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
  editBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: tokens.border.thin,
    borderTopColor: theme.colors.divider,
    backgroundColor: theme.colors.surfaceAlt,
  },
  selectAll: { flexDirection: 'row', alignItems: 'center' },
  selectAllText: { color: theme.colors.primarySoft, fontSize: fonts.scaled(14), fontWeight: '700', marginLeft: 8 },
  deleteButton: {
    backgroundColor: theme.colors.danger,
    borderRadius: tokens.metrics.buttonRadius,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  deleteButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '700' },
  disabled: { opacity: tokens.opacity.disabled },
});
