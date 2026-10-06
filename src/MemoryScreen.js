import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROUTE_NAMES } from './navigation/routeNames.js';
import {
  Alert,
  FlatList,
  Platform,
  ScrollView,
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
import {
  buildMemoryListData,
  buildSessionBadges,
  filterSessionsForMemory,
  groupSessionsByAge,
  hasLocalSessions,
  LOCAL_FILTER,
  MEMORY_FILTERS,
} from './memory/memoryBuckets.js';
import SessionRow, { SessionAvatar, formatSessionTime } from './memory/SessionRow.js';
import MemoryCheckupModal from './memory/MemoryCheckupModal.js';
import MoreMenuModal from './chat/MoreMenuModal.js';
import ChapterModal from './books/ChapterModal.js';
import SessionRecoveryModal from './SessionRecoveryModal.js';
import { EmptyState } from './ui/index.js';
import SearchScreen from './SearchScreen.js';
import { useTheme } from './theme/ThemeContext.js';
import { useTranslation } from './i18n/I18nContext.js';

// 会话行的显示名：群聊用群名（缺省拼成员名），单聊用角色名。
// 行渲染与长按操作单都要用，抽出来避免两处各写一遍后漂移。
function sessionDisplayName(session, character, groupMembers, t) {
  if (session && session.type === 'group') {
    return String(session.name || '').trim()
      || (Array.isArray(groupMembers) ? groupMembers : []).map(item => item && item.name).filter(Boolean).join('、')
      || t('common.groupChat');
  }
  return String((character && character.name) || '').trim() || t('memory.unnamedCharacter');
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
  const [menuOpen, setMenuOpen] = useState(false);
  // 记忆体检（Phase 4）：把两层记忆（会话摘要 / 角色卡条目）摊开看，并可清理残留。
  const [checkupOpen, setCheckupOpen] = useState(false);
  // 列表筛选 chips：全部 / 置顶 / 群聊（「本地」由 Phase 3 按数据有无追加）
  const [memoryFilter, setMemoryFilter] = useState('all');
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
      Alert.alert(t('memory.recover.success.title'), t('memory.recover.success.body'));
      return true;
    } catch (error) {
      Alert.alert(t('memory.recover.fail.title'), (error && error.message) || t('common.error.retryLater'));
      return false;
    }
  }, [refreshSessions, restoreSession]);

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

  // 按时间分档 + 置顶单独成组；默认展开最新的一个分组（通常是「置顶」或「最近 7 天」），
  // 让首屏直接看到会话，而不是只剩标题、还要多点一次；其余分组保持折叠。
  // 编辑模式下强制全部展开：折叠里的会话无法被逐条点选。
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());
  // 先筛选再分组： chips（全部/置顶/群聊）只改喂给分组的数据，不动存储与排序。
  const filteredSessions = useMemo(
    () => filterSessionsForMemory(visibleSessions, memoryFilter),
    [visibleSessions, memoryFilter]
  );
  const groups = useMemo(() => groupSessionsByAge(filteredSessions), [filteredSessions]);
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

  // 切换筛选时展开该筛选下的所有组：否则换到「置顶/群聊」这类常无对应分组的
  // 筛选时会看到全折叠的空列表，以为会话丢了。首次挂载跳过（首屏只展开第一组）。
  const filterInitRef = useRef(false);
  useEffect(() => {
    if (!filterInitRef.current) {
      filterInitRef.current = true;
      return;
    }
    setExpandedGroups(new Set(groups.map(group => group.id)));
    // groups 故意不进依赖：它由 memoryFilter 派生，只在筛选变化时需要重展开；
    // 新会话落库导致 groups 变化时不能打断用户手动折叠的状态。
  }, [memoryFilter]);

  // 吸顶组头：分组头在长列表里滚动时钉住，知道当前看的是哪一组。
  const stickyHeaderIndices = useMemo(
    () => listData
      .map((entry, index) => (entry.kind === 'header' ? index : -1))
      .filter(index => index >= 0),
    [listData]
  );

  // 筛选 chips：存在本地模型会话时才追加「本地」项（旧数据全是 api 会话，
  // 常驻一个永远筛不出东西的 chip 只会误导）。
  const memoryChips = useMemo(
    () => (hasLocalSessions(visibleSessions) ? [...MEMORY_FILTERS, LOCAL_FILTER] : MEMORY_FILTERS),
    [visibleSessions]
  );

  // ⋯ 菜单：教学入口与「展开/折叠全部」从头部收纳进来；计数本就在各分组头里。
  const menuItems = useMemo(() => ([
    {
      key: 'checkup',
      icon: 'medkit-outline',
      label: t('memory.checkup.title'),
      onPress: () => setCheckupOpen(true),
    },
    {
      key: 'teach',
      icon: 'help-circle-outline',
      label: t('memory.a11y.tutorial'),
      onPress: () => setTopic('memory'),
    },
    {
      key: 'toggle-all',
      icon: allExpanded ? 'contract-outline' : 'expand-outline',
      label: allExpanded ? t('memory.collapseAll') : t('memory.expandAll'),
      disabled: !(loaded && visibleSessions.length > 0),
      onPress: toggleAllGroups,
    },
  ]), [allExpanded, loaded, visibleSessions.length, toggleAllGroups]);

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
  }, [activeId, activeSessionId, characterMap, navigation, sessions, switchCharacter, switchSession]);

  const onPin = useCallback(async session => {
    try {
      await pinSession(session.id);
    } catch (error) {
      Alert.alert(t('memory.pin.fail.title'), t('common.error.storageOrPermission'));
    }
  }, [pinSession]);

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
  }, [cloneSession]);

  // 动态可能锚定在某段对话（记忆）上：删除记忆时，提示是否连带删除对应动态。
  const countLinkedMoments = useCallback(async sessionIds => {
    const { status, moments } = await getMomentsStatus();
    if (status === 'corrupt') {
      throw new Error(t('memory.moments.readFail'));
    }
    return countMomentsBySessionIds(moments, sessionIds);
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
  }, [countLinkedMoments, deleteSession, removeMomentsOfSessions]);

  // 长按行弹出操作单：置顶/克隆/删除从「每行常驻三按钮」收进这里。
  // Android 的 Alert 最多 3 个按钮，取消靠点按外部关闭（cancelable 默认开）；
  // iOS 追加显式取消按钮（项目现有跨端模式）。
  const onRowActions = useCallback(session => {
    const character = characterMap.get(session.characterId);
    const groupMembers = session.type === 'group'
      ? (session.members || []).map(id => characterMap.get(id)).filter(Boolean)
      : [];
    const buttons = [
      { text: session.pinned ? t('memory.unpin') : t('memory.pin'), onPress: () => onPin(session) },
      { text: t('memory.clone.action'), onPress: () => onClone(session) },
      { text: t('common.delete'), style: 'destructive', onPress: () => onDelete(session) },
    ];
    if (Platform.OS === 'ios') buttons.push({ text: t('common.cancel'), style: 'cancel' });
    // badge 放不下模型全名：长按操作单的副标题补上（本地 · Qwen2.5-1.5B）。
    const modelLine = session.modelKind === 'local'
      ? t('memory.localModelLine', { name: String(session.modelName || '').trim() || t('memory.localModelFallback') })
      : '';
    Alert.alert(
      sessionDisplayName(session, character, groupMembers, t),
      modelLine || undefined,
      buttons
    );
  }, [characterMap, onPin, onClone, onDelete]);

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
  }, [activeId, activeSessionId, characters, navigation, refreshSessions, sessions, setPendingTarget, switchCharacter, switchSession]);

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
  }, [countLinkedMoments, deleteSessions, exitEdit, removeMomentsOfSessions, selectedIds]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('memory.title')}</Text>
        <View style={styles.headerRight}>
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
          {editing ? null : (
            <TouchableOpacity
              style={styles.headerIconButton}
              onPress={() => setSearchOpen(true)}
              activeOpacity={0.7}
              accessibilityLabel={t('memory.a11y.search')}
            >
              <Ionicons name="search" size={18} color={theme.colors.primarySoft} />
            </TouchableOpacity>
          )}
          {editing ? null : (
            <TouchableOpacity
              style={styles.headerIconButton}
              onPress={() => setMenuOpen(true)}
              activeOpacity={0.7}
              accessibilityLabel={t('chat.bubble.moreA11y')}
            >
              <Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.primarySoft} />
            </TouchableOpacity>
          )}
        </View>
      </View>
      {loaded && !editing && visibleSessions.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipScroll}
          contentContainerStyle={styles.chipRow}
          keyboardShouldPersistTaps="handled"
        >
          {memoryChips.map(chip => {
            const active = memoryFilter === chip.id;
            return (
              <TouchableOpacity
                key={chip.id}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => setMemoryFilter(chip.id)}
                activeOpacity={0.75}
                accessibilityLabel={t('memory.a11y.filter', { label: chip.label })}
                accessibilityRole="button"
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{chip.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      ) : null}
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
          stickyHeaderIndices={stickyHeaderIndices}
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
                  accessibilityLabel={expanded ? t('memory.a11y.collapseGroup', { label: item.label }) : t('memory.a11y.expandGroup', { label: item.label })}
                >
                  <Ionicons
                    name={expanded ? 'chevron-down' : 'chevron-forward'}
                    size={16}
                    color={theme.colors.textFaint}
                  />
                  <Text style={styles.groupLabel}>{item.label}</Text>
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
            const name = sessionDisplayName(session, character, groupMembers, t);
            return (
              <SessionRow
                key={session.id}
                mode="manage"
                avatar={(
                  <SessionAvatar
                    isGroup={isGroup}
                    uri={isGroup ? session.avatarUri : ((character && character.avatarUri) || '')}
                    name={name}
                    members={groupMembers}
                  />
                )}
                name={name}
                badges={buildSessionBadges(session)}
                pinned={session.pinned === true}
                preview={
                  String(session.preview || '').trim()
                  || String(previewFallback[session.id] || '').trim()
                  || t('memory.emptyPreview')
                }
                time={formatSessionTime(session.updatedAt)}
                selectable={editing}
                selected={selectedIds.includes(session.id)}
                onPress={() => (editing ? toggleSelect(session.id) : onOpen(session))}
                onLongPress={editing ? undefined : () => onRowActions(session)}
              />
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

      <MoreMenuModal
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={menuItems}
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

      <MemoryCheckupModal
        visible={checkupOpen}
        onClose={() => setCheckupOpen(false)}
        sessions={sessions}
        characters={characters}
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
  headerIconButton: {
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
  chipScroll: { flexGrow: 0, marginBottom: 4 },
  chipRow: { paddingHorizontal: 20, paddingBottom: 6 },
  chip: {
    marginRight: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: tokens.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
  },
  chipActive: {
    backgroundColor: theme.colors.primaryAlpha(0.18),
    borderColor: theme.colors.primaryMuted,
  },
  chipText: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), fontWeight: '700' },
  chipTextActive: { color: theme.colors.primarySoft },
  editButton: { marginLeft: 12, paddingVertical: 6, paddingHorizontal: 4 },
  editButtonText: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(14), fontWeight: '700' },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    marginTop: 6,
    backgroundColor: theme.colors.background,
  },
  groupLabel: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    fontWeight: '800',
    marginLeft: 6,
  },
  groupCount: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(12),
    marginLeft: 8,
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
