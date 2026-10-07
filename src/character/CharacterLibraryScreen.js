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
import { useTranslation } from '../i18n/I18nContext.js';
import { createCharacterStyles } from './characterStyles.js';
import { CHARACTER_LIST_COLLAPSE_LIMIT, gridRowIndex } from './cardHelpers.js';

// 角色库网格列数。FlatList 在 numColumns>1 时，scrollToIndex 的 index 按「行」计数，
// 定位滑块给的是「项」序号，需经 gridRowIndex 折算，否则下半部分会越界闪退。
const CHARACTER_GRID_COLUMNS = 2;

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
  const { t } = useTranslation();
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
    return String(session.name || '').trim() || names.join('、') || t('common.groupChat');
  }, [characterMap, t]);

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
    label: item.kind === 'group' ? t('common.groupChat') : t('character.library.scrubber.kindCharacter'),
    speaker: item.kind === 'group' ? groupNameOf(item.item) : (item.item.name || t('common.unnamedCharacter')),
    text: item.kind === 'group'
      ? t('character.library.scrubber.groupMeta', { count: (item.item.members || []).length })
      : (item.item.tags || []).map(tag => String(tag || '').trim()).filter(Boolean).slice(0, 3).join('、') || t('character.library.scrubber.tagFallback'),
  })), [displayedCharacterItems, groupNameOf, t]);

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
  // 注意：numColumns>1 时 scrollToIndex 的 index 是「行号」而非「项序号」，
  // 滑块给的是项序号，需按列数折算，否则越界闪退。
  const onCharacterScrubberSeek = useCallback(index => {
    if (!displayedCharacterItems[index]) return;
    const rowIndex = gridRowIndex(index, CHARACTER_GRID_COLUMNS);
    listRef.current?.scrollToIndex?.({ index: rowIndex, animated: true, viewPosition: 0 });
  }, [displayedCharacterItems]);

  const onCharacterScrubberToStart = useCallback(() => {
    listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
  }, []);

  const onCharacterScrubberToEnd = useCallback(() => {
    listRef.current?.scrollToEnd?.({ animated: true });
  }, []);

  // scrollToIndex 对尚未渲染的项会失败（虚拟化窗口外），先滚到估算位置再重试。
  // index 同样是行号；估算步长优先用框架给的平均行高，避免固定值偏差过大导致重试反复失败。
  const onScrollToIndexFailed = useCallback(({ index, averageItemLength }) => {
    const step = Math.max(1, Number(averageItemLength) || 120);
    const rowIndex = Math.max(0, Number(index) || 0);
    listRef.current?.scrollToOffset?.({ offset: rowIndex * step, animated: false });
    setTimeout(() => {
      listRef.current?.scrollToIndex?.({ index: rowIndex, animated: true, viewPosition: 0 });
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
        Alert.alert(t('character.library.switch.fail.title'), t('common.error.storageOrPermission'));
      });
  }, [switchSession, navigation, t]);

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
      Alert.alert(t('memory.pin.fail.title'), t('common.error.storageOrPermission'));
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
      throw new Error(t('memory.moments.readFail'));
    }
    return countMomentsForCharacterDeletion(moments, characterIds, sessionIds);
  }, [t]);

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
        let message = (error && error.message) || t('common.error.storageOrPermission');
        if (deleteMemories && momentsDeleted && sessionsDeleted) {
          message = t('character.library.delete.fail.partialFull');
        } else if (deleteMemories && momentsDeleted) {
          message = t('character.library.delete.fail.partialSessions');
        } else if (deleteMemories) {
          message = t('character.library.delete.fail.partialMoments');
        }
        Alert.alert(t('common.error.deleteFailed'), message);
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
        if (memoryIds.length > 0) details.push(t('character.library.delete.detail.memories', { count: memoryIds.length }));
        if (linked > 0) details.push(t('character.library.delete.detail.moments', { count: linked }));
        if (details.length === 0) {
          Alert.alert(t('character.library.delete.title'), intro, [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('common.delete'),
              style: 'destructive',
              onPress: () => runDeleteSelected(targetIds, false),
            },
          ]);
          return;
        }
        Alert.alert(
          t('character.library.delete.title'),
          t('character.library.delete.withLinked', {
            intro,
            details: details.join(t('character.library.delete.detail.join')),
          }),
          [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('character.library.delete.onlyCharacter'), onPress: () => runDeleteSelected(targetIds, false) },
            {
              text: t('character.library.delete.all'),
              style: 'destructive',
              onPress: () => runDeleteSelected(targetIds, true),
            },
          ]
        );
      })
      .catch(() => {
        Alert.alert(t('common.error.deleteFailed'), t('character.library.delete.readFail.body'));
      });
  };

  const confirmSelectedDelete = ids => {
    showDeleteChoice(ids, t('character.library.delete.introBatch', { count: ids.length }));
  };

  const onDeleteSelected = () => {
    if (selectedIds.length === 0) return;
    const allSelected = selectedIds.length >= characters.filter(item => item.id !== 'default').length;
    if (!allSelected) {
      Alert.alert(t('character.library.delete.title'), t('character.library.delete.introBatch', { count: selectedIds.length }), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('character.library.delete.continue'),
          style: 'destructive',
          onPress: () => confirmSelectedDelete(selectedIds),
        },
      ]);
      return;
    }
    Alert.alert(
      t('character.library.deleteAll.title'),
      t('character.library.deleteAll.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('character.library.deleteAll.confirm'),
          style: 'destructive',
          onPress: () => promptConfirmAllDelete(),
        },
      ]
    );
  };

  const promptConfirmAllDelete = () => {
    Alert.prompt
      ? Alert.prompt(t('character.library.prompt.title'), t('character.library.prompt.body'), value => {
        // 确认词固定为「删除」二字，不随界面语言变化。
        if (String(value || '').trim() === '删除') {
          confirmSelectedDelete(selectedIds);
        } else {
          Alert.alert(t('character.library.prompt.mismatch.title'), t('character.library.prompt.mismatch.body'));
        }
      })
      : Alert.alert(t('character.library.prompt.unsupported.title'), t('character.library.prompt.unsupported.body'));
  };

  const onDeleteCharacter = item => {
    showDeleteChoice(
      [item.id],
      t('character.library.delete.introSingle', { name: item.name || t('common.unnamedCharacter') })
    );
  };

  const onNewCharacter = async () => {
    if (!loaded) return;
    try {
      const created = await addCharacter({ name: '新角色' });
      // 同上：新角色要有自己的会话，聊天页才不会留着上一个角色的对话
      await ensureCharacterSession(created.id).catch(() => {});
    } catch (error) {
      Alert.alert(t('character.library.new.fail.title'), t('common.error.storageOrPermission'));
    }
  };

  const toggleGroupMember = id => {
    if (!groupSelected.includes(id) && groupSelected.length >= 8) {
      Alert.alert(t('character.library.group.limit.title'), t('character.library.group.limit.body'));
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
      Alert.alert(t('character.library.group.count.title'), t('character.library.group.count.body'));
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
         Alert.alert(t('character.library.group.created.title'), t('character.library.group.created.body'));
         return;
       }
       setGroupPanelOpen(false);
       setGroupSelected([]);
       setGroupName('');
       setGroupAvatarUri('');
       setGroupBgUri('');
       navigation.navigate(ROUTE_NAMES.chat);
    } catch (error) {
      Alert.alert(t('character.library.group.createFail.title'), t('common.error.storageOrPermission'));
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
          t('character.library.switch.fail.title'),
          rollbackFailed
            ? t('character.library.switch.rollbackFail.body')
            : t('common.error.storageOrPermission')
        );
        throw error;
      } finally {
        switchLockRef.current = false;
      }
    };
    if (id !== activeId && formDirtyRef.current) {
      Alert.alert(t('character.library.unsaved.title'), t('character.library.unsaved.body'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('character.library.unsaved.discard'),
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
                accessibilityLabel={t('character.library.a11y.deleteCharacter')}
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
        contentContainerStyle={styles.listContent}
        style={styles.flex}
        data={displayedCharacterItems}
        keyExtractor={entry => entry.id}
        numColumns={CHARACTER_GRID_COLUMNS}
        columnWrapperStyle={styles.characterRow}
        renderItem={renderCardItem}
        keyboardShouldPersistTaps="handled"
        removeClippedSubviews={false}
        extraData={selectedIds}
        onScrollToIndexFailed={onScrollToIndexFailed}
        ListEmptyComponent={(
          <Text style={styles.emptyHint}>{t('character.library.searchEmpty')}</Text>
        )}
        ListHeaderComponent={(
          <>
        <View style={styles.pageHeader}>
          <Text style={styles.title}>{t('app.tab.character')}</Text>
          <FieldHint style={styles.hint}>{t('character.library.pageHint')}</FieldHint>
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
              <Text style={styles.cardTitle}>{t('character.library.cardTitle')}</Text>
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
              <Text style={styles.pillButtonText}>{t('character.library.new')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.pillButton, (!loaded || characters.length < 2) && styles.buttonDisabled]}
              onPress={() => setGroupPanelOpen(true)}
              disabled={!loaded || characters.length < 2}
              activeOpacity={0.8}
            >
              <Ionicons name="people" size={15} color={theme.colors.primarySoft} />
              <Text style={styles.pillButtonText}>{t('common.groupChat')}</Text>
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
                <Text style={styles.selectBarDeleteText}>{t('common.delete')}</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder={t('character.library.searchPlaceholder')}
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
                  accessibilityLabel={t('character.library.a11y.locate')}
                >
                  <Ionicons name="options-outline" size={15} color={theme.colors.primarySoft} />
                  <Text style={styles.characterListLocateText}>{t('character.library.locate')}</Text>
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
            <Text style={styles.modalTitle}>{t('character.library.group.createTitle')}</Text>
            <FieldLabel style={styles.label}>{t('character.library.group.nameLabel')}</FieldLabel>
            <TextField
              value={groupName}
              onChangeText={setGroupName}
              placeholder={t('group.namePlaceholder')}
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
                <FieldLabel style={styles.label}>{t('character.library.group.avatarLabel')}</FieldLabel>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.groupPickRow}>
                  <TouchableOpacity
                    style={[styles.groupPickChip, !groupAvatarUri && styles.groupPickChipActive]}
                    onPress={() => setGroupAvatarUri('')}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.groupPickText, !groupAvatarUri && styles.groupPickTextActive]}>{t('group.noImage')}</Text>
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
                <FieldLabel style={styles.label}>{t('character.library.group.bgLabel')}</FieldLabel>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.groupPickRow}>
                  <TouchableOpacity
                    style={[styles.groupPickChip, !groupBgUri && styles.groupPickChipActive]}
                    onPress={() => setGroupBgUri('')}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.groupPickText, !groupBgUri && styles.groupPickTextActive]}>{t('group.noImage')}</Text>
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
                            Alert.alert(
                              t('group.alert.cannotPick.title'),
                              t('character.library.group.noBg.body', { name: item.name || t('character.library.group.theCharacter') })
                            );
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
                <Text style={[styles.selectButtonText, styles.selectButtonTextGhost]}>{t('common.cancel')}</Text>
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
        title={t('settings.tutorial.title')}
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
