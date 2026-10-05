import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROUTE_NAMES } from './navigation/routeNames.js';
import {
  Alert,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useApp } from './context/AppContext.js';
import {
  deleteMomentsBySessionIds,
  findOrphanSessions,
  getMessagesBySession,
  getMomentsStatus,
  getUserProfile,
  restoreSession,
} from './storage.js';
import { buildPreview } from './context/sessionLibrary.js';
import { countMomentsBySessionIds } from './moments/moments.js';
import { buildMemoryListData, groupSessionsByAge } from './memory/memoryBuckets.js';
import ChapterModal from './books/ChapterModal.js';
import SessionRecoveryModal from './SessionRecoveryModal.js';
import { Card, EmptyState, TopicButton } from './ui/index.js';
import SearchScreen from './SearchScreen.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';

function formatTime(timestamp, t) {
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
  if (date.toDateString() === yesterday.toDateString()) return t('memory.date.yesterday');
  return t('memory.date.md', { m: date.getMonth() + 1, d: date.getDate() });
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
    activeId,
    activeSessionId,
  } = useApp();

  const [searchOpen, setSearchOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [topic, setTopic] = useState(null);
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  // 旧版本新建对话会误删会话记录：扫出"消息还在、会话没了"的对话，供用户恢复
  const [orphans, setOrphans] = useState([]);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [userName, setUserName] = useState('');
  const switchLockRef = useRef(false);

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
        t('memory.scan.fail.title'),
        (error && error.message) || t('memory.scan.fail.body')
      );
    }
  }, [t]);

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
      Alert.alert(t('memory.recover.success.title'), t('memory.recover.success.body'));
      return true;
    } catch (error) {
      Alert.alert(t('memory.recover.fail.title'), (error && error.message) || t('common.error.retryLater'));
      return false;
    }
  }, [refreshSessions, restoreSession, t]);

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

  // 按时间分档 + 置顶单独成组；默认展开最新的一个分组（通常是「置顶」或「最近」），
  // 让首屏直接看到会话，而不是只剩标题、还要多点一次；其余分组保持折叠。
  // 编辑模式下强制全部展开：折叠里的会话无法被逐条点选。
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  const groups = useMemo(() => groupSessionsByAge(visibleSessions), [visibleSessions]);
  // 仅在「首次拿到非空分组」时自动展开第一组；之后用户手动折叠/展开由用户决定，
  // 不因新增会话等分组变化再次弹出。
  const autoExpandedRef = useRef(false);
  useEffect(() => {
    if (autoExpandedRef.current || groups.length === 0) return;
    autoExpandedRef.current = true;
    setExpandedGroups(new Set([groups[0].id]));
  }, [groups]);
  const effectiveExpanded = useMemo(() => (
    editing ? new Set(groups.map(group => group.id)) : expandedGroups
  ), [editing, groups, expandedGroups]);
  const listData = useMemo(
    () => buildMemoryListData(groups, effectiveExpanded),
    [groups, effectiveExpanded]
  );
  const allExpanded = groups.length > 0 && groups.every(group => expandedGroups.has(group.id));

  const toggleGroup = useCallback(groupId => {
    setExpandedGroups(current => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  // 一键展开/收起所有分组：满足「展开所有的记忆」。
  const toggleAllGroups = useCallback(() => {
    setExpandedGroups(current => {
      const allOpen = groups.length > 0 && groups.every(group => current.has(group.id));
      return allOpen ? new Set() : new Set(groups.map(group => group.id));
    });
  }, [groups]);

  const onOpen = useCallback(async session => {
    if (switchLockRef.current) return;
    switchLockRef.current = true;
    const previousCharacterId = activeId;
    const previousSessionId = activeSessionId;
    try {
      if (session.type !== 'group' && characterMap.has(session.characterId)) {
        await switchCharacter(session.characterId);
      }
      await switchSession(session.id);
      navigation.navigate(ROUTE_NAMES.chat);
    } catch (error) {
      try {
        await switchCharacter(previousCharacterId);
        if (previousSessionId) await switchSession(previousSessionId);
      } catch (rollbackError) {}
      Alert.alert(t('memory.open.fail.title'), t('common.error.storageOrPermission'));
    } finally {
      switchLockRef.current = false;
    }
  }, [activeId, activeSessionId, characterMap, navigation, sessions, switchCharacter, switchSession, t]);

  const onPin = useCallback(async session => {
    try {
      await pinSession(session.id);
    } catch (error) {
      Alert.alert(t('memory.pin.fail.title'), t('common.error.storageOrPermission'));
    }
  }, [pinSession, t]);

  const onClone = useCallback(session => {
    Alert.alert(t('memory.clone.title'), t('memory.clone.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('memory.clone.action'),
        onPress: () => {
          cloneSession(session.id).catch(() => {
            Alert.alert(t('memory.clone.fail.title'), t('common.error.storageOrPermission'));
          });
        },
      },
    ]);
  }, [cloneSession, t]);

  // 动态可能锚定在某段对话（记忆）上：删除记忆时，提示是否连带删除对应动态。
  const countLinkedMoments = useCallback(async sessionIds => {
    const { status, moments } = await getMomentsStatus();
    if (status === 'corrupt') {
      throw new Error(t('memory.moments.readFail'));
    }
    return countMomentsBySessionIds(moments, sessionIds);
  }, [t]);

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
          t('common.error.deleteFailed'),
          momentsDeleted
            ? t('memory.delete.momentsDeletedFail.body')
            : t('common.error.storageOrPermission')
        );
      }
    };
    countLinkedMoments([session.id])
      .then(count => {
        if (count === 0) {
          Alert.alert(t('memory.deleteSession.title'), t('memory.deleteSession.body'), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('common.delete'), style: 'destructive', onPress: () => { runDelete(false); } },
          ]);
          return;
        }
        Alert.alert(
          t('memory.deleteMemory.title'),
          t('memory.deleteMemory.body', { count }),
          [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('memory.deleteMemory.onlyMemory'), onPress: () => { runDelete(false); } },
            { text: t('memory.deleteMemory.deleteAll'), style: 'destructive', onPress: () => { runDelete(true); } },
          ]
        );
      })
      .catch(() => {
        Alert.alert(t('common.error.deleteFailed'), t('memory.delete.linkedReadFail.body'));
      });
  }, [countLinkedMoments, deleteSession, removeMomentsOfSessions, t]);

  const onOpenResult = useCallback(async result => {
    if (switchLockRef.current) return;
    switchLockRef.current = true;
    const previousCharacterId = activeId;
    const previousSessionId = activeSessionId;
    const previousSession = sessions.find(session => session.id === previousSessionId);
    try {
      const latestSessions = await refreshSessions();
      const target = latestSessions.find(session => session.id === result.sessionId);
      if (!target) throw new Error(t('memory.sessionMissing'));
      const characterExists = target.type !== 'group'
        && characters.some(character => character.id === target.characterId);
      if (characterExists) {
        await switchCharacter(target.characterId);
      }
      await switchSession(target.id);
      setPendingTarget({ sessionId: target.id, messageId: result.messageId });
      setSearchOpen(false);
      navigation.navigate(ROUTE_NAMES.chat);
    } catch (error) {
      try {
        if (previousSession?.type === 'group') {
          if (previousSessionId) await switchSession(previousSessionId);
        } else {
          await switchCharacter(previousCharacterId);
          if (previousSessionId) await switchSession(previousSessionId);
        }
      } catch (rollbackError) {}
      Alert.alert(t('memory.open.fail.title'), (error && error.message) || t('common.error.storageOrPermission'));
    } finally {
      switchLockRef.current = false;
    }
  }, [activeId, activeSessionId, characters, navigation, refreshSessions, sessions, setPendingTarget, switchCharacter, switchSession, t]);

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
          t('common.error.deleteFailed'),
          momentsDeleted
            ? t('memory.delete.momentsDeletedFailBatch.body')
            : t('common.error.storageOrPermission')
        );
      }
    };
    countLinkedMoments(selectedIds)
      .then(linked => {
        if (linked === 0) {
          Alert.alert(t('memory.deleteSession.title'), t('memory.deleteBatch.body', { count }), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('common.delete'), style: 'destructive', onPress: () => { runDelete(false); } },
          ]);
          return;
        }
        Alert.alert(
          t('memory.deleteMemory.title'),
          t('memory.deleteBatch.bodyLinked', { count, linked }),
          [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('memory.deleteMemory.onlyMemory'), onPress: () => { runDelete(false); } },
            { text: t('memory.deleteMemory.deleteAll'), style: 'destructive', onPress: () => { runDelete(true); } },
          ]
        );
      })
      .catch(() => {
        Alert.alert(t('common.error.deleteFailed'), t('memory.delete.linkedReadFail.body'));
      });
  }, [countLinkedMoments, deleteSessions, exitEdit, removeMomentsOfSessions, selectedIds, t]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('memory.title')}</Text>
        <View style={styles.headerRight}>
          <TopicButton
            style={styles.topicButton}
            onPress={() => setTopic('memory')}
            accessibilityLabel={t('memory.a11y.tutorial')}
          />
          {editing ? null : (
            <Text style={styles.count}>
              {loaded ? t('memory.count', { count: visibleSessions.length }) : t('memory.loading')}
            </Text>
          )}
          {loaded && visibleSessions.length > 0 ? (
            <TouchableOpacity
              style={styles.editButton}
              onPress={editing ? exitEdit : () => setEditing(true)}
              activeOpacity={0.7}
              accessibilityLabel={editing ? t('memory.a11y.finishEdit') : t('memory.a11y.editSessions')}
            >
              <Text style={styles.editButtonText}>{editing ? t('common.done') : t('memory.edit')}</Text>
            </TouchableOpacity>
          ) : null}
          {loaded && visibleSessions.length > 0 && !editing ? (
            <TouchableOpacity
              style={styles.editButton}
              onPress={toggleAllGroups}
              activeOpacity={0.7}
              accessibilityLabel={allExpanded ? t('memory.a11y.collapseAll') : t('memory.a11y.expandAll')}
            >
              <Text style={styles.editButtonText}>{allExpanded ? t('memory.collapseAll') : t('memory.expandAll')}</Text>
            </TouchableOpacity>
          ) : null}
          {editing ? null : (
            <TouchableOpacity
              style={styles.searchButton}
              onPress={() => setSearchOpen(true)}
              activeOpacity={0.7}
              accessibilityLabel={t('memory.a11y.search')}
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
          accessibilityLabel={t('memory.a11y.recover')}
        >
          <Ionicons name="alert-circle-outline" size={13} color={theme.colors.star} />
          <Text style={styles.recoverNoticeText}>
            {t('memory.recoverNotice', { count: orphans.length })}
          </Text>
        </TouchableOpacity>
      ) : null}
      {loaded && visibleSessions.length === 0 ? (
        <EmptyState
          icon="albums-outline"
          title={t('memory.empty.title')}
          description={t('memory.empty.body')}
        />
      ) : (
        <FlatList
          data={listData}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => {
            if (item.kind === 'header') {
              const expanded = effectiveExpanded.has(item.groupId);
              return (
                <TouchableOpacity
                  style={styles.groupHeader}
                  onPress={() => toggleGroup(item.groupId)}
                  disabled={editing}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={expanded
                    ? t('memory.a11y.collapseGroup', { label: t(item.labelKey) })
                    : t('memory.a11y.expandGroup', { label: t(item.labelKey) })}
                >
                  <Ionicons
                    name={expanded ? 'chevron-down' : 'chevron-forward'}
                    size={16}
                    color={theme.colors.textFaint}
                  />
                  <Text style={styles.groupLabel}>{t(item.labelKey)}</Text>
                  <Text style={styles.groupCount}>{item.count}</Text>
                </TouchableOpacity>
              );
            }
            const session = item.session;
            const character = characterMap.get(session.characterId);
            const isGroup = session.type === 'group';
            const groupMembers = isGroup
              ? (session.members || []).map(id => characterMap.get(id)).filter(Boolean)
              : [];
            const name = isGroup
              ? (session.name || groupMembers.map(item => item.name).join('、') || t('memory.groupChat'))
              : ((character && character.name) || t('memory.unnamedCharacter'));
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
                      {isClone ? <Text style={styles.badge}>{t('memory.cloneBadge')}</Text> : null}
                      {session.pinned ? (
                        <Ionicons name="star" size={12} color={theme.colors.star} style={styles.pinMark} />
                      ) : null}
                    </View>
                    <Text style={styles.preview} numberOfLines={2}>
                      {String(session.preview || '').trim()
                        || String(previewFallback[session.id] || '').trim()
                        || t('memory.emptyPreview')}
                    </Text>
                    <Text style={styles.time}>{formatTime(session.updatedAt, t)}</Text>
                  </View>
                </TouchableOpacity>
                {editing ? null : (
                  <View style={styles.actions}>
                    <RowAction
                      icon={session.pinned ? 'star' : 'star-outline'}
                      color={session.pinned ? theme.colors.star : theme.colors.textFaint}
                      label={t('memory.pin')}
                      styles={styles}
                      onPress={() => onPin(session)}
                    />
                    <RowAction
                      icon="copy-outline"
                      color={theme.colors.textFaint}
                      label={t('memory.clone.action')}
                      styles={styles}
                      onPress={() => onClone(session)}
                    />
                    <RowAction
                      icon="trash-outline"
                      color={theme.colors.danger}
                      label={t('common.delete')}
                      styles={styles}
                      onPress={() => onDelete(session)}
                    />
                  </View>
                )}
              </Card>
            );
          }}
        />
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
              {allSelected ? t('memory.unselectAll') : t('memory.selectAll')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.deleteButton, selectedIds.length === 0 && styles.disabled]}
            onPress={onBatchDelete}
            disabled={selectedIds.length === 0}
            activeOpacity={0.8}
          >
            <Text style={styles.deleteButtonText}>{t('memory.deleteCount', { count: selectedIds.length })}</Text>
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
        title={t('memory.tutorial.title')}
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
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    marginTop: 6,
  },
  groupLabel: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(13),
    fontWeight: '800',
    marginLeft: 6,
  },
  groupCount: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    marginLeft: 8,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 12,
  },
  cardSelected: {
    borderColor: theme.colors.primary,
    borderWidth: tokens.border.thick,
    backgroundColor: theme.colors.primaryAlpha(0.06),
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
    shadowColor: theme.colors.danger,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
  deleteButtonText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(14), fontWeight: '700' },
  disabled: { opacity: tokens.opacity.disabled },
});
