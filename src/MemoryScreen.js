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
import { deleteMomentsBySessionIds, getMomentsStatus } from './storage/moments.js';
import { findOrphanSessions, getMessagesBySession, restoreSession } from './storage/sessions.js';
import { getUserProfile } from './storage/personas.js';
import { buildPreview } from './context/sessionLibrary.js';
import { countMomentsBySessionIds } from './moments/moments.js';
import {
  buildMemoryListData,
  buildSessionBadges,
  filterSessionsForMemory,
  groupSessionsByAge,
  hasLocalSessions,
  isScreenWatchFilter,
  LOCAL_FILTER,
  mapScreenThreadsToGroupItems,
  MEMORY_FILTERS,
  SCREEN_WATCH_FILTER,
  screenThreadPreview,
  splitScreenThreads,
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
import {
  clearScreenWatchThreads,
  deleteScreenWatchThread,
  getScreenWatchThreads,
} from './screenWatch/threads.js';

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

  // 看屏幕对话（screenWatch/threads.js）：不进「全部」视图，只在「屏幕对话」chip
  // 下以行形式展示/删除 —— 用户要求「看屏幕对话的管理要和记忆界面互通」。
  const [threads, setThreads] = useState([]);

  const reloadThreads = useCallback(async () => {
    try {
      setThreads(await getScreenWatchThreads());
    } catch (error) {
      setThreads([]);
    }
  }, []);

  const { active: activeThreads, empty: emptyThreads } = useMemo(
    () => splitScreenThreads(threads),
    [threads]
  );

  const handleDeleteThread = useCallback(thread => {
    if (!thread) return;
    const name = String(thread.characterName || '').trim() || t('common.characterFallback');
    Alert.alert(
      t('memory.screenWatch.delete.title'),
      t('memory.screenWatch.delete.body', { name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            deleteScreenWatchThread(thread.id)
              .then(() => reloadThreads())
              .catch(() => {});
          },
        },
      ]
    );
  }, [reloadThreads, t]);

  // 长按屏幕对话行：与主列表一致的「长按出操作单」交互（这里只有删除）。
  const onThreadActions = useCallback(thread => {
    const name = String(thread.characterName || '').trim() || t('common.characterFallback');
    const buttons = [
      { text: t('common.delete'), style: 'destructive', onPress: () => handleDeleteThread(thread) },
    ];
    if (Platform.OS === 'ios') buttons.push({ text: t('common.cancel'), style: 'cancel' });
    Alert.alert(name, screenThreadPreview(thread) || undefined, buttons, { cancelable: true });
  }, [handleDeleteThread, t]);

  // 空会话（0 条 entry）不逐行展示，聚合成一行可一键清理的入口。
  const handleClearEmptyThreads = useCallback(() => {
    if (emptyThreads.length === 0) return;
    Alert.alert(
      t('memory.screenWatch.clearEmptyConfirm.title'),
      t('memory.screenWatch.clearEmptyConfirm.body', { count: emptyThreads.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            Promise.all(emptyThreads.map(thread => deleteScreenWatchThread(thread.id).catch(() => {})))
              .then(() => reloadThreads());
          },
        },
      ]
    );
  }, [emptyThreads, reloadThreads, t]);

  const handleClearAllThreads = useCallback(() => {
    if (threads.length === 0) return;
    Alert.alert(
      t('memory.screenWatch.clearAllConfirm.title'),
      t('memory.screenWatch.clearAllConfirm.body', { count: threads.length }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            clearScreenWatchThreads().then(() => reloadThreads()).catch(() => {});
          },
        },
      ]
    );
  }, [reloadThreads, t, threads.length]);

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
  // 看屏幕对话同理：在「看屏幕」里新建/接话后回到记忆页要刷新 threads。
  useEffect(() => {
    if (!navigation) return undefined;
    const refresh = () => {
      refreshSessions().catch(() => {});
      reloadThreads();
    };
    refresh();
    const unsubscribe = navigation.addListener('focus', refresh);
    return unsubscribe;
  }, [navigation, refreshSessions, reloadThreads]);

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
  // 选中「屏幕对话」chip 时不看会话，改为把看屏幕 threads 借同一套时间分档展示。
  const isScreenWatch = isScreenWatchFilter(memoryFilter);
  const filteredSessions = useMemo(
    () => filterSessionsForMemory(visibleSessions, memoryFilter),
    [visibleSessions, memoryFilter]
  );
  const sessionGroups = useMemo(() => groupSessionsByAge(filteredSessions), [filteredSessions]);
  const threadGroups = useMemo(
    () => groupSessionsByAge(mapScreenThreadsToGroupItems(activeThreads)),
    [activeThreads]
  );
  const groups = useMemo(
    () => (isScreenWatch ? threadGroups : sessionGroups),
    [isScreenWatch, sessionGroups, threadGroups]
  );
  // 首次拿到非空分组时自动展开第一组（首屏不留光秃秃的组头）；之后用户手动折叠/展开
  // 由用户决定。但当分组结构整体换掉、当初展开的组 id 已不存在时（典型：把全部会话
  // 都置顶后只剩「置顶」一组，而展开态还停在旧的「最近 7 天」），必须补展开，
  // 否则列表只剩一个折叠组头，看起来像会话全丢了。
  const autoExpandedRef = useRef(false);
  useEffect(() => {
    if (groups.length === 0) return;
    if (!autoExpandedRef.current) {
      autoExpandedRef.current = true;
      setExpandedGroups(new Set([groups[0].id]));
      return;
    }
    setExpandedGroups(current => (
      groups.some(group => current.has(group.id)) ? current : new Set([groups[0].id])
    ));
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
  // 只在 iOS 下启用：Android 上 FlatList 在同一次渲染里既换 data 又换
  // stickyHeaderIndices 会在原生层崩溃（facebook/react-native#25157，本页筛选
  // 切换/置顶都会触发）；RN 自身对 SectionList 的吸顶在 Android 也默认关闭。
  const stickyHeaderIndices = useMemo(
    () => (Platform.OS === 'ios'
      ? listData
        .map((entry, index) => (entry.kind === 'header' ? index : -1))
        .filter(index => index >= 0)
      : []),
    [listData]
  );

  // 筛选 chips：存在本地模型会话时才追加「本地」项（旧数据全是 api 会话，
  // 常驻一个永远筛不出东西的 chip 只会误导）。「屏幕对话」恒在末位。
  const memoryChips = useMemo(() => {
    const base = hasLocalSessions(visibleSessions) ? [...MEMORY_FILTERS, LOCAL_FILTER] : MEMORY_FILTERS;
    return [...base, SCREEN_WATCH_FILTER];
  }, [visibleSessions]);

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
  // Android 的 Alert 最多 3 个按钮，取消靠点按外部/返回键关闭——必须显式传
  // `cancelable: true`（Android 默认是 false，之前没传导致三个按钮之外无法退出）；
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
      buttons,
      { cancelable: true }
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
          {loaded && !isScreenWatch && visibleSessions.length > 0 ? (
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
      {loaded && !editing && (visibleSessions.length > 0 || threads.length > 0) ? (
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
                onPress={() => {
                  if (chip.id === SCREEN_WATCH_FILTER.id && editing) exitEdit();
                  setMemoryFilter(chip.id);
                }}
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
      {isScreenWatch && emptyThreads.length > 0 ? (
        <View style={styles.emptyThreadsRow}>
          <Text style={styles.emptyThreadsText}>
            {t('memory.screenWatch.emptyCount', { count: emptyThreads.length })}
          </Text>
          <TouchableOpacity
            onPress={handleClearEmptyThreads}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={t('memory.screenWatch.a11y.clearEmpty')}
          >
            <Text style={styles.emptyThreadsAction}>{t('memory.screenWatch.clear')}</Text>
          </TouchableOpacity>
        </View>
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
      {loaded && (isScreenWatch ? activeThreads.length === 0 : visibleSessions.length === 0) ? (
        <EmptyState
          icon={isScreenWatch ? 'desktop-outline' : 'albums-outline'}
          title={isScreenWatch ? t('memory.screenWatch.empty.title') : t('memory.empty.title')}
          description={isScreenWatch ? t('memory.screenWatch.empty.body') : t('memory.empty.body')}
        />
      ) : (
        <FlatList
          style={styles.list}
          data={listData}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          stickyHeaderIndices={stickyHeaderIndices}
          renderItem={({ item }) => {
            if (item.kind === 'header') {
              const expanded = effectiveExpanded.has(item.groupId);
              const showClearAll = isScreenWatch && groups.length > 0 && item.groupId === groups[0].id;
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
                  {showClearAll ? (
                    <TouchableOpacity
                      style={styles.clearAllButton}
                      onPress={handleClearAllThreads}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel={t('memory.screenWatch.a11y.clearAll')}
                    >
                      <Text style={styles.clearAllText}>{t('memory.screenWatch.clearAll')}</Text>
                    </TouchableOpacity>
                  ) : null}
                </TouchableOpacity>
              );
            }
            if (isScreenWatch) {
              const thread = item.session.thread;
              const threadName = String(thread.characterName || '').trim() || t('common.characterFallback');
              const threadCharacter = characterMap.get(thread.characterId);
              return (
                <SessionRow
                  key={thread.id}
                  mode="manage"
                  avatar={threadCharacter && threadCharacter.avatarUri ? (
                    <SessionAvatar uri={threadCharacter.avatarUri} name={threadName} />
                  ) : (
                    <View style={styles.screenThreadAvatar}>
                      <Ionicons name="desktop-outline" size={20} color={theme.colors.primarySoft} />
                    </View>
                  )}
                  name={threadName}
                  preview={screenThreadPreview(thread) || t('memory.screenWatch.emptyPreview')}
                  time={formatSessionTime(thread.updatedAt)}
                  onLongPress={() => onThreadActions(thread)}
                />
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
  screenThreadAvatar: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceBorder,
  },
  emptyThreadsRow: {
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
  emptyThreadsText: {
    flex: 1,
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    fontWeight: '700',
  },
  emptyThreadsAction: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(12),
    fontWeight: '700',
    marginLeft: 8,
  },
  clearAllButton: { marginLeft: 'auto', paddingHorizontal: 8, paddingVertical: 2 },
  clearAllText: { color: theme.colors.primaryMuted, fontSize: fonts.scaled(12), fontWeight: '700' },
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
  // flexGrow:0 只阻止拉伸，阻止不了收缩：RN 横向 ScrollView 基础样式
  // baseHorizontal 自带 flexShrink:1，纵向空间不足时（展开看屏幕卡/恢复条/
  // 大字号）压缩量会落到 chips 行把胶囊压扁——必须显式 flexShrink:0。
  chipScroll: { flexGrow: 0, flexShrink: 0, marginBottom: 4 },
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
  // FlatList 显式接管剩余空间：溢出压力全部由列表吸收，
  // 不再外溢到 chips 等非列表元素（与 chipScroll 的 flexShrink:0 配套）。
  list: { flex: 1 },
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
