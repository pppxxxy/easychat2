// 角色库列表页。从 src/CharacterScreen.js 原样搬出「Card ① 角色库」整块（无行为变化），
// 编辑表单搬去 src/character/CharacterDetailScreen.js。
//
// 唯一的结构性变化：点角色卡的语义从「切到该角色并停留在同一页」变成
// 「切到该角色 → 进入该角色的详情页」。切换本身仍走原 onSwitch：守卫、锁、
// 失败回滚、Alert 文案一字未改，只在切换成功后再 navigate。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROUTE_NAMES } from '../navigation/routeNames.js';
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import ChapterModal from '../books/ChapterModal.js';
import { Card, FieldHint, FieldLabel, TextField } from '../ui/index.js';
import { useApp } from '../context/AppContext.js';
import { selectSessionsForCharacters } from '../context/sessionLibrary.js';
import { useNavigation } from '@react-navigation/native';
import ScrollScrubber from '../chat/ScrollScrubber.js';
import {
  clearCharacterEditDraft,
  createGroupSession,
  deleteMomentsForCharacterDeletion,
  getMomentsStatus,
} from '../storage.js';
import { countMomentsForCharacterDeletion } from '../moments/moments.js';
import { isValidAigcMeta } from '../aigc/attribution.js';
import { useTheme } from '../theme/ThemeContext.js';
import { createCharacterStyles } from './characterStyles.js';
import { CHARACTER_LIST_COLLAPSE_LIMIT } from './cardHelpers.js';

export default function CharacterLibraryScreen() {
  const {
    characters,
    activeId,
    loaded,
    switchCharacter,
    ensureCharacterSession,
    addCharacter,
    deleteCharacter,
    pinCharacter,
    deleteCharacters,
    refreshSessions,
    sessions,
    activeSessionId,
    switchSession,
    deleteSessions,
  } = useApp();
  const navigation = useNavigation();
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createCharacterStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const [characterListExpanded, setCharacterListExpanded] = useState(false);
  const [characterScrubberOpen, setCharacterScrubberOpen] = useState(false);
  const [groupPanelOpen, setGroupPanelOpen] = useState(false);
  const [groupSelected, setGroupSelected] = useState([]);
  const [groupName, setGroupName] = useState('');
  const [groupAvatarUri, setGroupAvatarUri] = useState('');
  const [groupBgUri, setGroupBgUri] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [query, setQuery] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [topic, setTopic] = useState(null);
  // 拆分后这里不再持有 switchAuthorization：原实现用它 + authorizedActiveIdRef 通知
  // 表单的 seed effect「这次角色切换是用户授权的、别回滚」。seed effect 现在在详情页，
  // 由详情页自己的 state 承担；列表页不再需要这份授权信号（回滚动作本身仍在 catch 里保留）。
  const authorizedActiveIdRef = useRef('');
  const formDirtyRef = useRef(false);
  const listRef = useRef(null);
  const switchLockRef = useRef(false);

  const visibleCharacters = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return characters;
    return characters.filter(item => {
      const name = String(item.name || '').toLowerCase();
      if (name.includes(text)) return true;
      return (item.tags || []).some(tag => String(tag).toLowerCase().includes(text));
    });
  }, [characters, query]);

  const activeIsGroup = useMemo(
    () => (Array.isArray(sessions) ? sessions : []).some(
      item => item && item.id === activeSessionId && item.type === 'group'
    ),
    [sessions, activeSessionId]
  );

  const characterMap = useMemo(() => {
    const map = new Map();
    characters.forEach(item => map.set(item.id, item));
    return map;
  }, [characters]);

  const groupNameOf = useCallback(session => {
    const names = (session.members || [])
      .map(id => (characterMap.get(id) || {}).name)
      .filter(Boolean);
    return String(session.name || '').trim() || names.join('、') || '群聊';
  }, [characterMap]);

  const visibleGroups = useMemo(() => {
    const list = (Array.isArray(sessions) ? sessions : []).filter(
      item => item && item.type === 'group'
    );
    const text = query.trim().toLowerCase();
    if (!text) return list;
    return list.filter(item => groupNameOf(item).toLowerCase().includes(text));
  }, [sessions, query, groupNameOf]);

  // 页头「当前：…」用的群聊对象：从全部会话里找，不受搜索结果过滤影响，
  // 否则搜了个不匹配的词时页头会显示成「群聊」而丢掉真实群名。
  const activeGroupSession = useMemo(
    () => (Array.isArray(sessions) ? sessions : []).find(
      item => item && item.type === 'group' && item.id === activeSessionId
    ) || null,
    [sessions, activeSessionId]
  );

  const characterDisplayItems = useMemo(() => [
    ...visibleCharacters.map(item => ({
      id: item.id,
      kind: 'character',
      item,
    })),
    ...(editMode ? [] : visibleGroups.map(group => ({
      id: `group-${group.id}`,
      kind: 'group',
      item: group,
    }))),
  ], [editMode, visibleCharacters, visibleGroups]);
  const characterListNeedsCollapse = characterDisplayItems.length > CHARACTER_LIST_COLLAPSE_LIMIT;
  const displayedCharacterItems = characterListExpanded
    ? characterDisplayItems
    : characterDisplayItems.slice(0, CHARACTER_LIST_COLLAPSE_LIMIT);
  const characterScrubberPreviews = useMemo(() => displayedCharacterItems.map(item => ({
    label: item.kind === 'group' ? '群聊' : '角色',
    speaker: item.kind === 'group' ? groupNameOf(item.item) : (item.item.name || '未命名角色'),
    text: item.kind === 'group'
      ? `${(item.item.members || []).length} 人群聊`
      : (item.item.tags || []).map(tag => String(tag || '').trim()).filter(Boolean).slice(0, 3).join('、') || '角色卡',
  })), [displayedCharacterItems, groupNameOf]);

  useEffect(() => {
    if (!characterListNeedsCollapse && characterListExpanded) {
      setCharacterListExpanded(false);
      setCharacterScrubberOpen(false);
    }
  }, [characterListNeedsCollapse, characterListExpanded]);

  useEffect(() => {
    if (editMode) setCharacterScrubberOpen(false);
  }, [editMode]);

  // 定位滑块：FlatList numColumns 虚拟化后，直接用官方 scrollToIndex 定位，
  // 不再需要任何布局测量（网格几何推导随 FlatList 化一并退役）。
  const onCharacterScrubberSeek = useCallback(index => {
    if (!displayedCharacterItems[index]) return;
    listRef.current?.scrollToIndex?.({ index, animated: true, viewPosition: 0 });
  }, [displayedCharacterItems]);

  const onCharacterScrubberToStart = useCallback(() => {
    listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
  }, []);

  const onCharacterScrubberToEnd = useCallback(() => {
    listRef.current?.scrollToEnd?.({ animated: true });
  }, []);

  // scrollToIndex 对尚未渲染的项会失败（虚拟化窗口外），先滚到估算位置再重试。
  const onScrollToIndexFailed = useCallback(({ index }) => {
    listRef.current?.scrollToOffset?.({ offset: Math.max(0, index) * 120, animated: false });
    setTimeout(() => {
      listRef.current?.scrollToIndex?.({ index, animated: true, viewPosition: 0 });
    }, 120);
  }, []);

  const toggleCharacterList = useCallback(() => {
    const next = !characterListExpanded;
    setCharacterListExpanded(next);
    if (next) {
      requestAnimationFrame(() => setCharacterScrubberOpen(characterListNeedsCollapse));
    } else {
      setCharacterScrubberOpen(false);
    }
  }, [characterListExpanded, characterListNeedsCollapse]);

  const onOpenGroup = useCallback(group => {
    switchSession(group.id)
      .then(() => navigation.navigate(ROUTE_NAMES.chat))
      .catch(() => {
        Alert.alert('切换失败', '请检查存储空间或权限。');
      });
  }, [switchSession, navigation]);

  const toggleEditMode = () => {
    setEditMode(current => {
      if (current) setSelectedIds([]);
      return !current;
    });
  };

  const toggleSelect = id => {
    setSelectedIds(current => (
      current.includes(id) ? current.filter(item => item !== id) : [...current, id]
    ));
  };

  const visibleSelectableIds = useMemo(
    () => visibleCharacters.filter(item => item.id !== 'default').map(item => item.id),
    [visibleCharacters]
  );
  const allVisibleSelected = visibleSelectableIds.length > 0
    && visibleSelectableIds.every(id => selectedIds.includes(id));

  useEffect(() => {
    setSelectedIds(current => current.filter(id => visibleSelectableIds.includes(id)));
  }, [visibleSelectableIds]);

  const selectAll = () => {
    setSelectedIds(allVisibleSelected ? [] : visibleSelectableIds);
  };

  const onTogglePin = item => {
    pinCharacter(item.id, !item.pinned).catch(() => {
      Alert.alert('置顶失败', '请检查存储空间或权限。');
    });
  };

  const sessionsOfCharacters = useCallback(ids => (
    selectSessionsForCharacters(sessions, ids)
      .map(session => session.id)
      .filter(Boolean)
  ), [sessions]);

  const countLinkedMoments = useCallback(async (characterIds, sessionIds) => {
    const { status, moments } = await getMomentsStatus();
    if (status === 'corrupt') {
      throw new Error('动态记录读取失败，请稍后重试');
    }
    return countMomentsForCharacterDeletion(moments, characterIds, sessionIds);
  }, []);

  const removeMomentsOfCharacterData = useCallback((characterIds, sessionIds) => (
    deleteMomentsForCharacterDeletion(characterIds, sessionIds)
  ), []);

  const runDeleteSelected = (ids, deleteMemories) => {
    const targetIds = (Array.isArray(ids) ? ids : [])
      .map(id => String(id || ''))
      .filter(Boolean);
    if (targetIds.length === 0) return;
    const memoryIds = sessionsOfCharacters(targetIds);
    let momentsDeleted = false;
    let sessionsDeleted = false;
    const beforeCharacterDelete = async () => {
      if (!deleteMemories) return;
      await removeMomentsOfCharacterData(targetIds, memoryIds);
      momentsDeleted = true;
      if (memoryIds.length > 0) {
        await deleteSessions(memoryIds, targetIds);
      }
      sessionsDeleted = true;
    };
    Promise.resolve()
      .then(beforeCharacterDelete)
      .then(() => (
        targetIds.length === 1
          ? deleteCharacter(targetIds[0], { clearVectorIds: deleteMemories ? targetIds : [] })
          : deleteCharacters(targetIds, { clearVectorIds: deleteMemories ? targetIds : [] })
      ))
      .then(() => {
        setSelectedIds([]);
        setEditMode(false);
      })
      .catch(error => {
        let message = (error && error.message) || '请检查存储空间或权限。';
        if (deleteMemories && momentsDeleted && sessionsDeleted) {
          message = '关联动态和记忆已删除，但角色删除失败，请重试。';
        } else if (deleteMemories && momentsDeleted) {
          message = '关联动态已删除，但记忆删除失败，角色未删除，请重试。';
        } else if (deleteMemories) {
          message = '关联动态删除失败，角色未删除，请重试。';
        }
        Alert.alert('删除失败', message);
      });
  };

  const showDeleteChoice = (ids, intro) => {
    const targetIds = (Array.isArray(ids) ? ids : [])
      .map(id => String(id || ''))
      .filter(Boolean);
    if (targetIds.length === 0) return;
    const memoryIds = sessionsOfCharacters(targetIds);
    countLinkedMoments(targetIds, memoryIds)
      .then(linked => {
        const details = [];
        if (memoryIds.length > 0) details.push(`${memoryIds.length} 条记忆`);
        if (linked > 0) details.push(`${linked} 条动态`);
        if (details.length === 0) {
          Alert.alert('删除角色', intro, [
            { text: '取消', style: 'cancel' },
            {
              text: '删除',
              style: 'destructive',
              onPress: () => runDeleteSelected(targetIds, false),
            },
          ]);
          return;
        }
        Alert.alert(
          '删除角色',
          `${intro}\n关联数据：${details.join('、')}。是否一并删除？`,
          [
            { text: '取消', style: 'cancel' },
            { text: '仅删角色', onPress: () => runDeleteSelected(targetIds, false) },
            {
              text: '角色、记忆和动态都删',
              style: 'destructive',
              onPress: () => runDeleteSelected(targetIds, true),
            },
          ]
        );
      })
      .catch(() => {
        Alert.alert('删除失败', '没能读出关联数据，请稍后重试。');
      });
  };

  const confirmSelectedDelete = ids => {
    showDeleteChoice(ids, `将删除选中的 ${ids.length} 个角色。`);
  };

  const onDeleteSelected = () => {
    if (selectedIds.length === 0) return;
    const allSelected = selectedIds.length >= characters.filter(item => item.id !== 'default').length;
    if (!allSelected) {
      Alert.alert('删除角色', `将删除选中的 ${selectedIds.length} 个角色。`, [
        { text: '取消', style: 'cancel' },
        {
          text: '继续',
          style: 'destructive',
          onPress: () => confirmSelectedDelete(selectedIds),
        },
      ]);
      return;
    }
    Alert.alert(
      '删除全部角色',
      '这会删除除默认角色外的全部角色，且无法恢复。请输入「删除」以确认。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确认删除',
          style: 'destructive',
          onPress: () => promptConfirmAllDelete(),
        },
      ]
    );
  };

  const promptConfirmAllDelete = () => {
    Alert.prompt
      ? Alert.prompt('输入确认', '请输入「删除」两个字以确认。', value => {
        if (String(value || '').trim() === '删除') {
          confirmSelectedDelete(selectedIds);
        } else {
          Alert.alert('已取消', '确认文字不匹配，未执行删除。');
        }
      })
      : Alert.alert('无法输入确认', '当前平台不支持输入确认，请逐个删除。');
  };

  const onDeleteCharacter = item => {
    showDeleteChoice(
      [item.id],
      `确定删除「${item.name || '未命名角色'}」吗？`
    );
  };

  const onNewCharacter = async () => {
    if (!loaded) return;
    try {
      const created = await addCharacter({ name: '新角色' });
      // 同上：新角色要有自己的会话，聊天页才不会留着上一个角色的对话
      await ensureCharacterSession(created.id).catch(() => {});
    } catch (error) {
      Alert.alert('新建失败', '请检查存储空间或权限。');
    }
  };

  const toggleGroupMember = id => {
    if (!groupSelected.includes(id) && groupSelected.length >= 8) {
      Alert.alert('成员数量已达上限', '群聊最多选择 8 个角色。');
      return;
    }
    setGroupSelected(current => (
      current.includes(id)
        ? current.filter(item => item !== id)
        : [...current, id]
    ));
  };

  const onCreateGroup = async () => {
    if (groupSelected.length < 2 || groupSelected.length > 8) {
      Alert.alert('成员数量不符', '群聊需要选择 2 到 8 个角色。');
      return;
    }
    if (creatingGroup) return;
    setCreatingGroup(true);
    try {
      const members = groupSelected.slice();
      const fallbackName = characters
        .filter(item => members.includes(item.id))
        .map(item => item.name || '未命名角色')
        .join('、');
       await createGroupSession(members, groupName.trim() || fallbackName, {
         avatarUri: groupAvatarUri,
         bgUri: groupBgUri,
       });
       try {
         await refreshSessions();
       } catch (error) {
         Alert.alert('群聊已创建', '会话列表刷新失败，请重新进入应用后查看。');
         return;
       }
       setGroupPanelOpen(false);
       setGroupSelected([]);
       setGroupName('');
       setGroupAvatarUri('');
       setGroupBgUri('');
       navigation.navigate(ROUTE_NAMES.chat);
    } catch (error) {
      Alert.alert('创建失败', '请检查存储空间或权限。');
    } finally {
      setCreatingGroup(false);
    }
  };

  // 切换当前角色：守卫、锁、失败回滚与文案全部沿用原 onSwitch。
  // 唯一的差异是切换成功后由调用方进入详情页（见 openCharacterDetail）。
  const onSwitch = async id => {
    if (switchLockRef.current) return;
    const performSwitch = async () => {
      if (switchLockRef.current) return;
      switchLockRef.current = true;
      const previousCharacterId = activeId;
      const previousSessionId = activeSessionId;
      try {
        await switchCharacter(id);
        await ensureCharacterSession(id);
      } catch (error) {
        let rollbackFailed = false;
        try {
          // 记下「切换由本页发起、用户已授权」：原实现用 authorizedActiveIdRef +
          // switchAuthorization 让表单的 seed effect 跳过回滚分支。表单已搬到详情页，
          // 本页不再持有 seed effect；但回滚本身（切回原角色与原会话）行为必须保留。
          authorizedActiveIdRef.current = previousCharacterId;
          await switchCharacter(previousCharacterId);
          if (previousSessionId) await switchSession(previousSessionId);
        } catch (rollbackError) {
          rollbackFailed = true;
        }
        Alert.alert(
          '切换失败',
          rollbackFailed
            ? '切换失败且未能恢复原状态，请重新打开应用后重试。'
            : '请检查存储空间或权限。'
        );
        throw error;
      } finally {
        switchLockRef.current = false;
      }
    };
    if (id !== activeId && formDirtyRef.current) {
      Alert.alert('有未保存的编辑', '切换角色会放弃当前界面中的修改。', [
        { text: '取消', style: 'cancel' },
        {
          text: '放弃并切换',
          style: 'destructive',
          onPress: () => {
            // 用户明确放弃：清掉编辑草稿，切回来时不再弹「恢复编辑」。
            clearCharacterEditDraft(activeId).catch(() => {});
            authorizedActiveIdRef.current = id;
            performSwitch();
          },
        },
      ]);
      return;
    }
    await performSwitch();
  };

  // 点角色卡：先切换当前角色（沿用 onSwitch 的守卫与锁），成功后再进详情页。
  // 切换失败时 onSwitch 已弹过提示，这里不再进详情页（避免详情页读到一个没切过去的角色）。
  const openCharacterDetail = async id => {
    try {
      await onSwitch(id);
    } catch (error) {
      return;
    }
    navigation.navigate('CharacterDetail', { characterId: id });
  };

  // 页头 AI 生成徽标用的元数据：原实现取当前角色 character.aigcMeta，
  // 列表页不再持有单个当前角色对象，按 activeId 从 characters 里取同一条。
  const activeCharacter = characters.find(item => item.id === activeId) || null;
  const activeCharacterAigcMeta = activeCharacter ? activeCharacter.aigcMeta : null;

  // FlatList 单项渲染：角色卡与群聊卡共用 entry 结构（{ id, kind, item }）。
  // 多选模式（editMode）下数据源已不含群聊（见 characterDisplayItems），无需再判。
  const renderCardItem = ({ item: entry }) => {
    if (entry.kind === 'group') {
      const group = entry.item;
      const selected = group.id === activeSessionId;
      return (
        <TouchableOpacity
          style={[styles.characterCard, selected && styles.characterCardActive]}
          onPress={() => onOpenGroup(group)}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={`进入群聊 ${groupNameOf(group)}`}
          accessibilityState={{ selected }}
        >
          <View style={styles.characterCardImageWrap}>
            {group.avatarUri ? (
              <Image source={{ uri: group.avatarUri }} style={styles.characterCardImage} />
            ) : (
              <View style={styles.characterCardFallback}>
                <View style={styles.characterCardFallbackDeep} />
                <Ionicons name="people" size={24} color={theme.colors.primarySoft} />
              </View>
            )}
            <View style={styles.characterCardGroupBadge}>
              <Ionicons name="people" size={12} color={theme.colors.primaryContrast} />
            </View>
            <View style={styles.characterCardScrim} pointerEvents="none" />
            <View style={styles.characterCardScrimDeep} pointerEvents="none" />
            <View style={styles.characterCardNameOverlay} pointerEvents="none">
              {selected ? <View style={styles.characterCardCurrentDot} /> : null}
              <Text style={styles.characterCardName} numberOfLines={1}>
                {groupNameOf(group)}
              </Text>
            </View>
          </View>
        </TouchableOpacity>
      );
    }
    const item = entry.item;
    const selected = !activeIsGroup && item.id === activeId;
    const checked = selectedIds.includes(item.id);
    return (
      <TouchableOpacity
        style={[styles.characterCard, selected && styles.characterCardActive]}
        onPress={() => (editMode ? (item.id === 'default' ? null : toggleSelect(item.id)) : openCharacterDetail(item.id))}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={`切换到角色 ${item.name || '未命名角色'}`}
        accessibilityState={{ selected }}
      >
        <View style={styles.characterCardImageWrap}>
          {item.avatarUri ? (
            <Image source={{ uri: item.avatarUri }} style={styles.characterCardImage} />
          ) : (
            <View style={styles.characterCardFallback}>
              <View style={styles.characterCardFallbackDeep} />
              <Text style={styles.characterCardFallbackText}>
                {(item.name || '?').charAt(0)}
              </Text>
            </View>
          )}
          {editMode && item.id !== 'default' ? (
            <View style={[styles.characterCardCheck, checked && styles.characterCardCheckOn]}>
              <Ionicons name={checked ? 'checkmark' : 'ellipse-outline'} size={15} color={theme.colors.primaryContrast} />
            </View>
          ) : null}
          {item.id !== 'default' && !editMode ? (
            <>
              <TouchableOpacity
                style={styles.characterCardPin}
                onPress={() => onTogglePin(item)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel={item.pinned ? '取消置顶' : '置顶角色'}
              >
                <Ionicons
                  name={item.pinned ? 'star' : 'star-outline'}
                  size={15}
                  color={item.pinned ? theme.colors.star : theme.colors.text}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.characterCardDelete}
                onPress={() => onDeleteCharacter(item)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel="删除角色"
              >
                <Ionicons name="trash-outline" size={15} color={theme.colors.text} />
              </TouchableOpacity>
            </>
          ) : null}
          <View style={styles.characterCardScrim} pointerEvents="none" />
          <View style={styles.characterCardScrimDeep} pointerEvents="none" />
          <View style={styles.characterCardNameOverlay} pointerEvents="none">
            {selected ? <View style={styles.characterCardCurrentDot} /> : null}
            <Text style={styles.characterCardName} numberOfLines={1}>
              {item.name || '未命名角色'}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* 整页唯一滚动容器换成 FlatList：numColumns=2 虚拟化网格，
          页头与工具条收进 ListHeaderComponent，长列表只渲染视口内卡片。 */}
      <FlatList
        ref={listRef}
        style={styles.container}
        data={displayedCharacterItems}
        keyExtractor={entry => entry.id}
        numColumns={2}
        columnWrapperStyle={styles.characterRow}
        renderItem={renderCardItem}
        keyboardShouldPersistTaps="handled"
        removeClippedSubviews={false}
        extraData={selectedIds}
        onScrollToIndexFailed={onScrollToIndexFailed}
        ListEmptyComponent={(
          <Text style={styles.emptyHint}>没有匹配的角色，换个关键词试试。</Text>
        )}
        ListHeaderComponent={(
          <>
        <View style={styles.pageHeader}>
          <Text style={styles.title}>角色</Text>
          <FieldHint style={styles.hint}>聊天时会把这里的设定作为系统提示词发送给模型。</FieldHint>
          {/* 「当前角色」由卡片文字角标改为页头 pill：卡片上只留描边 + 圆点，页头给全名 */}
          <View style={styles.currentPill}>
            <View style={styles.currentPillDot} />
            <Text style={styles.currentPillText} numberOfLines={1}>
              {`当前：${activeIsGroup
                ? groupNameOf(activeGroupSession || {})
                : ((activeCharacter && activeCharacter.name) || '未命名角色')}`}
            </Text>
          </View>
          {isValidAigcMeta(activeCharacterAigcMeta) ? (
            <Text style={styles.aigcBadge}>{`本卡由 AI 生成 · 内容编号 ${activeCharacterAigcMeta.contentCode || ''}`}</Text>
          ) : null}
        </View>

        <Card>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleRow}>
              <Ionicons name="people-outline" size={16} color={theme.colors.primaryMuted} />
              <Text style={styles.cardTitle}>角色库</Text>
              <View style={styles.countBadge}>
                <Text style={styles.countBadgeText}>{characters.length}</Text>
              </View>
            </View>
            <TouchableOpacity
              style={[styles.pillButton, !loaded && styles.buttonDisabled]}
              onPress={onNewCharacter}
              disabled={!loaded}
              activeOpacity={0.8}
            >
              <Ionicons name="add" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.pillButtonText}>新建</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.pillButton, (!loaded || characters.length < 2) && styles.buttonDisabled]}
              onPress={() => setGroupPanelOpen(true)}
              disabled={!loaded || characters.length < 2}
              activeOpacity={0.8}
            >
              <Ionicons name="people" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.pillButtonText}>群聊</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.pillButton, !loaded && styles.buttonDisabled]}
              onPress={toggleEditMode}
              disabled={!loaded}
              activeOpacity={0.8}
            >
              <Ionicons name={editMode ? 'close' : 'checkmark-circle-outline'} size={15} color={theme.colors.primarySoft} />
              <Text style={styles.pillButtonText}>{editMode ? '完成' : '多选'}</Text>
            </TouchableOpacity>
          </View>
          {editMode ? (
            <View style={styles.selectBar}>
                 <TouchableOpacity style={styles.selectBarAction} onPress={selectAll} activeOpacity={0.8}>

                 <Text style={styles.selectBarText}>{allVisibleSelected ? '取消全选' : '全选'}</Text>

              </TouchableOpacity>
              <Text style={styles.selectBarCount}>{`已选 ${selectedIds.length}`}</Text>
              <TouchableOpacity
                style={[styles.selectBarDelete, selectedIds.length === 0 && styles.buttonDisabled]}
                onPress={onDeleteSelected}
                disabled={selectedIds.length === 0}
                activeOpacity={0.8}
              >
                <Text style={styles.selectBarDeleteText}>删除</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="搜索角色名或标签"
            placeholderTextColor={theme.colors.textFaint}
          />
          {characterListNeedsCollapse ? (
            <View style={styles.characterListControls}>
              <TouchableOpacity
                style={styles.characterListToggle}
                onPress={toggleCharacterList}
                activeOpacity={0.8}
                accessibilityRole="button"
              >
                <Ionicons
                  name={characterListExpanded ? 'chevron-up' : 'chevron-down'}
                  size={15}
                  color={theme.colors.primarySoft}
                />
                <Text style={styles.characterListToggleText}>
                  {characterListExpanded
                    ? '折叠角色列表'
                    : `展开全部角色（${characterDisplayItems.length}）`}
                </Text>
              </TouchableOpacity>
              {characterListExpanded ? (
                <TouchableOpacity
                  style={styles.characterListLocate}
                  onPress={() => setCharacterScrubberOpen(true)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="打开角色列表定位"
                >
                  <Ionicons name="options-outline" size={15} color={theme.colors.primarySoft} />
                  <Text style={styles.characterListLocateText}>定位</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
        </Card>
          </>
        )}
      />

      <Modal
        visible={groupPanelOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setGroupPanelOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          // Android 用 undefined：app.json 的 softwareKeyboardLayoutMode 已是 resize，
          // 再叠一层 behavior="height" 会在输入法收起时反复重算高度，表现为界面疯狂上下闪动。
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>创建群聊</Text>
            <FieldLabel style={styles.label}>群名（留空自动生成）</FieldLabel>
            <TextField
              value={groupName}
              onChangeText={setGroupName}
              placeholder="例如：周末闲聊群"
              editable={!creatingGroup}
            />
            <FieldLabel style={styles.label}>{`选择成员（已选 ${groupSelected.length} / 2-8）`}</FieldLabel>
            <ScrollView style={styles.groupList} keyboardShouldPersistTaps="handled">
              {characters.map(item => {
                const selected = groupSelected.includes(item.id);
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.groupRow}
                    onPress={() => toggleGroupMember(item.id)}
                    activeOpacity={0.75}
                  >
                    <Ionicons
                      name={selected ? 'checkbox' : 'square-outline'}
                      size={20}
                      color={selected ? theme.colors.primaryMuted : theme.colors.textFaint}
                    />
                    {item.avatarUri ? (
                      <Image source={{ uri: item.avatarUri }} style={styles.groupAvatar} />
                    ) : (
                      <View style={[styles.groupAvatar, styles.groupAvatarFallback]}>
                        <Text style={styles.avatarPlaceholderText}>
                          {String(item.name || '?').charAt(0)}
                        </Text>
                      </View>
                    )}
                    <Text style={styles.groupName} numberOfLines={1}>
                      {item.name || '未命名角色'}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {groupSelected.length > 0 ? (
              <>
                <FieldLabel style={styles.label}>群头像（可从成员选择）</FieldLabel>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.groupPickRow}>
                  <TouchableOpacity
                    style={[styles.groupPickChip, !groupAvatarUri && styles.groupPickChipActive]}
                    onPress={() => setGroupAvatarUri('')}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.groupPickText, !groupAvatarUri && styles.groupPickTextActive]}>不使用</Text>
                  </TouchableOpacity>
                  {characters.filter(item => groupSelected.includes(item.id)).map(item => {
                    const uri = String(item.avatarUri || '');
                    const active = uri && groupAvatarUri === uri;
                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[styles.groupPickChip, active && styles.groupPickChipActive]}
                        onPress={() => setGroupAvatarUri(uri)}
                        activeOpacity={0.8}
                      >
                        {uri ? (
                          <Image source={{ uri }} style={styles.groupPickAvatar} />
                        ) : (
                          <View style={[styles.groupPickAvatar, styles.groupPickAvatarFallback]}>
                            <Text style={styles.avatarPlaceholderText}>{String(item.name || '?').charAt(0)}</Text>
                          </View>
                        )}
                        <Text style={[styles.groupPickText, active && styles.groupPickTextActive]} numberOfLines={1}>
                          {item.name || '未命名'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                <FieldLabel style={styles.label}>群背景（可从成员背景选择）</FieldLabel>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.groupPickRow}>
                  <TouchableOpacity
                    style={[styles.groupPickChip, !groupBgUri && styles.groupPickChipActive]}
                    onPress={() => setGroupBgUri('')}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.groupPickText, !groupBgUri && styles.groupPickTextActive]}>不使用</Text>
                  </TouchableOpacity>
                  {characters.filter(item => groupSelected.includes(item.id)).map(item => {
                    const uri = String(item.bgUri || '');
                    const active = uri && groupBgUri === uri;
                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[styles.groupPickChip, active && styles.groupPickChipActive]}
                        onPress={() => {
                          if (!uri) {
                            Alert.alert('无法选择', `「${item.name || '该角色'}」没有背景图。`);
                            return;
                          }
                          setGroupBgUri(uri);
                        }}
                        activeOpacity={0.8}
                      >
                        <Text style={[styles.groupPickText, active && styles.groupPickTextActive]} numberOfLines={1}>
                          {item.name || '未命名'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </>
            ) : null}
            <View style={styles.presetModalActions}>
              <TouchableOpacity
                style={[styles.selectButton, styles.selectButtonGhost]}
                onPress={() => setGroupPanelOpen(false)}
                disabled={creatingGroup}
                activeOpacity={0.8}
              >
                <Text style={[styles.selectButtonText, styles.selectButtonTextGhost]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.selectButton, creatingGroup && styles.buttonDisabled]}
                onPress={onCreateGroup}
                disabled={creatingGroup}
                activeOpacity={0.8}
              >
                <Text style={styles.selectButtonText}>
                  {creatingGroup ? '创建中...' : '创建'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ChapterModal
        visible={!!topic}
        onClose={() => setTopic(null)}
        chapterIds={topic ? [topic] : []}
        title="教学"
      />

      <ScrollScrubber
        visible={characterScrubberOpen && characterListExpanded && characterListNeedsCollapse}
        onClose={() => setCharacterScrubberOpen(false)}
        messageCount={displayedCharacterItems.length}
        previews={characterScrubberPreviews}
        onSeek={onCharacterScrubberSeek}
        onToStart={onCharacterScrubberToStart}
        onToEnd={onCharacterScrubberToEnd}
      />
    </KeyboardAvoidingView>
  );
}
