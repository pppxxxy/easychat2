// 记忆页列表视图模型：把「会话 / 看屏幕 threads」按筛选 + 时间分档组织成可直接
// 喂给 FlatList 的 listData，并维护分组展开态、吸顶组头、筛选 chips。
// 从 MemoryScreen.js 原样外提（无行为变化）；纯逻辑仍在 memory/memoryBuckets.js。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { getMessagesBySession } from '../storage/sessions.js';
import { buildPreview } from '../context/sessionLibrary.js';
import {
  buildMemoryListData,
  filterSessionsForMemory,
  groupSessionsByAge,
  hasLocalSessions,
  isScreenWatchFilter,
  LOCAL_FILTER,
  mapScreenThreadsToGroupItems,
  MEMORY_FILTERS,
  SCREEN_WATCH_FILTER,
} from './memoryBuckets.js';

export default function useMemoryListView({
  sessions,
  characters,
  activeThreads,
  memoryFilter,
  editing,
}) {
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

  return {
    characterMap,
    visibleSessions,
    // 当前筛选集（chips 生效后）：要出圈给「全选」用——全选必须与列表渲染集同口径，
    // 否则会把筛选之外的会话一并选中并被 deleteSessions 真删掉（用户看不见、不可逆）。
    filteredSessions,
    previewFallback,
    isScreenWatch,
    groups,
    effectiveExpanded,
    listData,
    allExpanded,
    toggleGroup,
    toggleAllGroups,
    stickyHeaderIndices,
    memoryChips,
  };
}
