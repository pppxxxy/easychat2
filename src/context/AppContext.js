import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert } from 'react-native';

import {
  DEFAULT_CHARACTER,
  DEFAULT_ASSISTANT_LEGACY_PROMPTS,
  getActiveCharacterIdStatus,
  getCharacterLibrary,
  isCharacterLibraryWriteBlocked,
  saveCharacterLibrary,
  setActiveCharacterId,
  setCharacterLibraryWriteBlocked,
  sortCharacters,
} from '../storage/characters.js';
import { saveCharacterState } from '../storage/characterState.js';
import {
  getSessions,
  whenSessionMutationsSettled,
  setActiveSessionId,
  setSessionPinned,
  startNewSession,
  appendProactiveMessage,
  cloneSession as cloneSessionStorage,
  deleteSession as deleteSessionStorage,
  deleteSessions as deleteSessionsStorage,
  reconcileVectorIndexes,
  reconcileWorldMemories,
} from '../storage/sessions.js';
// 活动会话指针的三态读取：sessions.js barrel 已把它与 getActiveSessionId 一并转发，
// 这里直取 sessionCore（指针的定义处，键与读写同源），避免多一层转发。
import { getActiveSessionIdStatus } from '../storage/sessionCore.js';
import { getProactiveSettings, bindProactiveSlotSession } from '../storage/moments.js';
import { collectOrphanImageFiles } from '../storage/orphanMedia.js';

import {
  describeDefaultArtwork,
  describeDefaultAssistantRefresh,
  resolveActiveId,
  resolveStartupFailure,
  runWithRollback,
  withAddedCharacter,
  withDeletedCharacter,
  withDeletedCharacters,
  withPinnedCharacter,
  withSwitchedCharacter,
  withUpdatedCharacter,
} from './characterLibrary.js';
import { resolveActiveSessionId, shouldPersistResolvedId, sortSessions } from './sessionLibrary.js';
import { normalizePendingQuote, normalizePendingTarget } from './pendingPayloads.js';
import { materializeDefaultArtwork } from '../character/defaultCharacterAssets.js';
import { ingestProactiveMessagesInto } from './proactiveIngest.js';
// 状态守卫文案走 tActive（同步取词）：这些 throw 的 message 会被调用方 catch 后
// 经 error.message 直通 Alert/提示条，硬编码中文会让英文界面弹中文。
// 用 tActive 而不是 hook：throw 发生在 async 回调/事件处理里，拿不到 React 上下文。
import { tActive } from '../i18n/index.js';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [characters, setCharactersState] = useState([DEFAULT_CHARACTER]);
  const [activeId, setActiveIdState] = useState(DEFAULT_CHARACTER.id);
  const [sessions, setSessionsState] = useState([]);
  const [activeSessionId, setActiveSessionIdState] = useState('');
  const [pendingTarget, setPendingTargetState] = useState(null);
  // 听歌等面板「接话」带入的引用：{ sessionId, payload }。与 pendingTarget 同一
  // ref+state 惯例——目标会话激活后由聊天页消费一次，消费前多次设置以最后一次为准。
  const [pendingQuote, setPendingQuoteState] = useState(null);
  const [loaded, setLoaded] = useState(false);
  // 启动加载失败的可见错误态（{ title, body, reason } 或 null）。启动失败此前是**完全
  // 静默**的：没有诊断、没有错误态、没有提示，用户只会看到角色库「变空」了。这里把
  // 错误态放进 context，任何界面（错误条/设置页诊断入口）都能读到，也便于测试断言。
  const [startupError, setStartupError] = useState(null);
  // 主动消息落库后自增，通知聊天页重新读取当前会话消息（同会话追加时 activeSessionId 不变）。
  const [messageRefreshTick, setMessageRefreshTick] = useState(0);
  const charactersRef = useRef([DEFAULT_CHARACTER]);
  const activeIdRef = useRef(DEFAULT_CHARACTER.id);
  const sessionsRef = useRef([]);
  const activeSessionIdRef = useRef('');
  const pendingTargetRef = useRef(null);
  const pendingQuoteRef = useRef(null);
  const loadedRef = useRef(false);
  const mutationRef = useRef(Promise.resolve());

  const enqueueMutation = useCallback(operation => {
    const pending = mutationRef.current.then(operation);
    mutationRef.current = pending.catch(() => {});
    return pending;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // 记忆归属对账必须在读角色库**之前**：它会退休卡上不合法的「记忆总结」条目
        // （单会话时代残留的、删会话后留下的、跨卡流通过来的），若先读进内存，
        // 内存快照就会与盘不一致——用户随后编辑角色时会把退休标记又覆盖回去。
        // 代价很小：只有卡上真有生效的记忆条目时才会去读会话消息。
        await reconcileWorldMemories().catch(error => {
          if (__DEV__) console.warn('[memory] world memory reconciliation failed', error);
        });
        const [list, storedActive, sessionList, storedActiveSession] = await Promise.all([
          getCharacterLibrary(),
          getActiveCharacterIdStatus(),
          getSessions(),
          getActiveSessionIdStatus(),
        ]);
        if (cancelled) return;
        // 三态读取：指针只允许在 ok / missing（键从未存在过）时写回；corrupt
        // （getItem 抛错 / JSON 损坏）必须保持盘上原值不动——否则读失败返回 '' 会让这里
        // 解析出**另一段**会话 / 另一个角色再落盘，用户「上次停在的对话」被永久改掉。
        const storedActiveId = storedActive.value;
        const storedActiveSessionId = storedActiveSession.value;
        const libraryBlocked = isCharacterLibraryWriteBlocked();
        // 默认角色（EasyChat2 助手）首次运行时补上内置头像/背景：仅当用户尚未自定义。
        // 落盘为 avatars/ 下的普通文件，使所有既有渲染点无需改动即可生效。
        let resolvedList = list;
        if (!libraryBlocked) {
          const defaultCharacter = list.find(item => item.id === DEFAULT_CHARACTER.id);
          const needs = describeDefaultArtwork({
            id: DEFAULT_CHARACTER.id,
            avatarUri: defaultCharacter && defaultCharacter.avatarUri,
            bgUri: defaultCharacter && defaultCharacter.bgUri,
            defaultId: DEFAULT_CHARACTER.id,
          });
          if (needs.avatar || needs.bg) {
            const artwork = await materializeDefaultArtwork();
            if (cancelled) return;
            if (artwork.avatarUri || artwork.bgUri) {
              resolvedList = list.map(item => {
                if (item.id !== DEFAULT_CHARACTER.id) return item;
                return {
                  ...item,
                  avatarUri: needs.avatar && artwork.avatarUri ? artwork.avatarUri : item.avatarUri,
                  bgUri: needs.bg && artwork.bgUri ? artwork.bgUri : item.bgUri,
                };
              });
              await saveCharacterLibrary(resolvedList).catch(() => {});
            }
          }
          // 内置助手：系统提示仍是历史内置文案时刷新为最新版（用户改过的不动，非内置卡不动）。
          const assistantRefresh = describeDefaultAssistantRefresh({
            id: DEFAULT_CHARACTER.id,
            builtin: defaultCharacter && defaultCharacter.builtin,
            systemPrompt: defaultCharacter && defaultCharacter.systemPrompt,
            defaultId: DEFAULT_CHARACTER.id,
            legacyPrompts: DEFAULT_ASSISTANT_LEGACY_PROMPTS,
            nextPrompt: DEFAULT_CHARACTER.systemPrompt,
          });
          if (assistantRefresh) {
            resolvedList = resolvedList.map(item => (
              item.id === DEFAULT_CHARACTER.id ? { ...item, ...assistantRefresh } : item
            ));
            await saveCharacterLibrary(resolvedList).catch(() => {});
          }
        }
        const resolved = resolveActiveId(resolvedList, storedActiveId);
        const sortedSessions = sortSessions(sessionList);
        const resolvedSessionId = resolveActiveSessionId(sortedSessions, storedActiveSessionId);
        charactersRef.current = resolvedList;
        activeIdRef.current = libraryBlocked ? (storedActiveId || resolved) : resolved;
        sessionsRef.current = sortedSessions;
        activeSessionIdRef.current = resolvedSessionId;
        setCharactersState(resolvedList);
        setActiveIdState(libraryBlocked ? (storedActiveId || resolved) : resolved);
        setSessionsState(sortedSessions);
        setActiveSessionIdState(resolvedSessionId);
        // 角色指针与下面的会话指针同一套三态裁定：活动角色键损坏时 storedActiveId 是 ''
        // 而不是「用户上次用的角色」，此时把解析出的兜底角色写回去同样是拿推测值覆盖原值。
        if (
          !libraryBlocked
          && shouldPersistResolvedId(storedActive.status, resolved, storedActiveId)
        ) {
          setActiveCharacterId(resolved).catch(() => {});
        }
        if (
          shouldPersistResolvedId(
            storedActiveSession.status,
            resolvedSessionId,
            storedActiveSessionId
          )
        ) {
          setActiveSessionId(resolvedSessionId).catch(() => {});
        }
      } catch (error) {
        if (cancelled) return;
        // 启动加载失败**不能**当作「空库 + 无会话」的正常态继续跑：此前这个 catch 连
        // error 都没引用过，用户点一次编辑/置顶/新增就会用残缺列表把盘上其余角色键与
        // 大卡正文文件不可逆地删掉（详见 characterLibrary.resolveStartupFailure 的注释）。
        //
        // 处置顺序：先合写闸（fail-closed，且必须在任何写操作之前）→ 留痕 → 可见提示。
        // 合闸挡住的**只有**写：UI 仍要渲染出来（否则用户面对的是一块白屏，连诊断入口
        // 都点不到），所以下面照旧回落成一份最小内存快照。
        const failure = resolveStartupFailure(error, setCharacterLibraryWriteBlocked);
        charactersRef.current = [DEFAULT_CHARACTER];
        activeIdRef.current = DEFAULT_CHARACTER.id;
        sessionsRef.current = [];
        activeSessionIdRef.current = '';
        setCharactersState([DEFAULT_CHARACTER]);
        setActiveIdState(DEFAULT_CHARACTER.id);
        setSessionsState([]);
        setActiveSessionIdState('');
        setStartupError(failure);
        Alert.alert(failure.title, failure.body || failure.title);
      } finally {
        if (!cancelled) {
          // loaded 仍然置 true，判断依据：
          //   1. loaded 在本文件里的全部作用是「放行」——loadedRef 守卫（updateCharacter /
          //      addCharacter / deleteCharacter / pinCharacter / deleteCharacters /
          //      ensureCharacterSession / switchSession / …）与 UI 渲染。若失败后保持
          //      false，界面停在空态且所有操作抛 error.context.*NotLoaded，用户连
          //      「角色库读不出来」这条提示都看不到。
          //   2. 会被 loaded 放行的写操作**全都**经过角色库写闸：
          //      updateCharacter/addCharacter/deleteCharacter/pinCharacter/deleteCharacters
          //      → saveCharacterState → saveCharacterLibrary（写闸命中即抛
          //      error.storage.characterLibraryRecovering）；会话侧的
          //      ensureCharacterSession/switchSession/… 只写会话域，不碰角色库；
          //      activeId 修正 effect（`if (!loaded || isCharacterLibraryWriteBlocked())`）
          //      本身就带写闸守卫。
          //   3. 存储层的写闸现在是「读失败即合闸」（见 getCharacterLibrary 的包装），
          //      不再依赖 AppContext 记得去合闸，所以 loaded=true 不会漏出写路径。
          // 结论：loaded 与写闸职责分离——loaded 管「能不能渲染/进入操作态」，写闸管
          // 「能不能落盘」。失败后 loaded=true + 写闸合上，是唯一同时满足「可见错误态」
          // 与「不可逆删除被挡住」的组合。
          loadedRef.current = true;
          setLoaded(true);
          reconcileVectorIndexes().catch(error => {
            if (__DEV__) console.warn('[vector] startup reconciliation failed', error);
          });
          collectOrphanImageFiles().catch(() => {});
        }
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyList = useCallback(list => {
    const sorted = sortCharacters(list);
    charactersRef.current = sorted;
    setCharactersState(sorted);
    return sorted;
  }, []);

  // 从盘上重读角色库并覆盖内存。存储层可能在本轮操作里改过角色卡（删除会话触发的
  // 记忆归属对账会退休卡上的记忆条目）——内存快照不跟上，用户下次编辑角色时就会把
  // 退休标记整表覆盖回去。
  const refreshCharactersDirect = useCallback(async () => {
    const list = await getCharacterLibrary();
    return applyList(list);
  }, [applyList]);

  // 排队版本：给外部（记忆体检弹层的清理动作等）用，避免与角色更新并发读写打架。
  const refreshCharacters = useCallback(
    () => enqueueMutation(() => refreshCharactersDirect()),
    [enqueueMutation, refreshCharactersDirect]
  );

  const restore = useCallback(snapshot => {
    charactersRef.current = snapshot.list;
    activeIdRef.current = snapshot.activeId;
    setCharactersState(snapshot.list);
    setActiveIdState(snapshot.activeId);
  }, []);

  const snapshotState = useCallback(() => ({
    list: charactersRef.current,
    activeId: activeIdRef.current,
  }), []);

  const updateCharacter = useCallback(async patch => {
    if (!loadedRef.current) {
      throw new Error(tActive('error.context.characterNotLoaded'));
    }
    const targetId = patch?.id || activeIdRef.current;
    return enqueueMutation(async () => {
      const snapshot = snapshotState();
      if (!snapshot.list.some(item => item.id === targetId)) {
        throw new Error(tActive('error.context.characterNotFound'));
      }
      const { list, character } = withUpdatedCharacter(snapshot.list, targetId, patch);
      applyList(list);
      await runWithRollback(snapshot, restore, () => saveCharacterLibrary(list));
      return character;
    });
  }, [applyList, restore, snapshotState, enqueueMutation]);

  const switchCharacter = useCallback(async id => {
    if (!loadedRef.current) {
      throw new Error(tActive('error.context.characterNotLoaded'));
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotState();
      const { list, character, found } = withSwitchedCharacter(
        snapshot.list,
        id,
        Date.now()
      );
      if (!found) {
        throw new Error(tActive('error.context.characterNotFound'));
      }
      if (id === snapshot.activeId) return character;
      applyList(list);
      activeIdRef.current = id;
      setActiveIdState(id);
      await runWithRollback(snapshot, restore, () => saveCharacterState(list, id));
      return character;
    });
  }, [applyList, restore, snapshotState, enqueueMutation]);

  const addCharacter = useCallback(async character => {
    if (!loadedRef.current) {
      throw new Error(tActive('error.context.characterNotLoaded'));
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotState();
      const created = withAddedCharacter(snapshot.list, character, Date.now());
      applyList(created.list);
      activeIdRef.current = created.character.id;
      setActiveIdState(created.character.id);
      await runWithRollback(snapshot, restore, () =>
        saveCharacterState(created.list, created.character.id)
      );
      return created.character;
    });
  }, [applyList, restore, snapshotState, enqueueMutation]);

  const deleteCharacter = useCallback(async (id, options = {}) => {
    if (!loadedRef.current) {
      throw new Error(tActive('error.context.characterNotLoaded'));
    }
    if (id === DEFAULT_CHARACTER.id) {
      throw new Error(tActive('error.context.defaultCharacterUndeletable'));
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotState();
      const result = withDeletedCharacter(snapshot.list, id, snapshot.activeId);
      if (!result.removed) {
        throw new Error(tActive('error.context.characterNotFound'));
      }
      applyList(result.list);
      activeIdRef.current = result.activeId;
      setActiveIdState(result.activeId);
      await runWithRollback(snapshot, restore, () =>
        saveCharacterState(
          result.list,
          result.activeId,
          id,
          options.clearVectorIds || []
        )
      );
      return result.list;
    });
  }, [applyList, restore, snapshotState, enqueueMutation]);

  const pinCharacter = useCallback(async (id, pinned) => {
    if (!loadedRef.current) {
      throw new Error(tActive('error.context.characterNotLoaded'));
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotState();
      const result = withPinnedCharacter(snapshot.list, id, pinned);
      if (!result.found) {
        throw new Error(tActive('error.context.characterNotFound'));
      }
      applyList(result.list);
      await runWithRollback(snapshot, restore, () =>
        saveCharacterState(result.list, snapshot.activeId)
      );
      return result.character;
    });
  }, [applyList, restore, snapshotState, enqueueMutation]);

  const deleteCharacters = useCallback(async (ids, options = {}) => {
    if (!loadedRef.current) {
      throw new Error(tActive('error.context.characterNotLoaded'));
    }
    const list = (Array.isArray(ids) ? ids : []).map(String)
      .filter(id => id && id !== DEFAULT_CHARACTER.id);
    if (list.length === 0) {
      throw new Error(tActive('error.context.noDeletableCharacters'));
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotState();
      // 默认角色不可删，删掉其余全部角色后仍会保留默认角色，因此这里不再拦截“全选删除”。
      const result = withDeletedCharacters(snapshot.list, list, snapshot.activeId);
      if (result.removedCount === 0) {
        throw new Error(tActive('error.context.characterNotFound'));
      }
      applyList(result.list);
      activeIdRef.current = result.activeId;
      setActiveIdState(result.activeId);
      await runWithRollback(snapshot, restore, () =>
        saveCharacterState(
          result.list,
          result.activeId,
          list,
          options.clearVectorIds || []
        )
      );
      return result.list;
    });
  }, [applyList, restore, snapshotState, enqueueMutation]);

  const applySessions = useCallback(list => {
    const sorted = sortSessions(list);
    sessionsRef.current = sorted;
    setSessionsState(sorted);
    return sorted;
  }, []);

  const restoreSessions = useCallback(snapshot => {
    sessionsRef.current = snapshot.sessions;
    activeSessionIdRef.current = snapshot.activeSessionId;
    setSessionsState(snapshot.sessions);
    setActiveSessionIdState(snapshot.activeSessionId);
  }, []);

  const snapshotSessions = useCallback(() => ({
    sessions: sessionsRef.current,
    activeSessionId: activeSessionIdRef.current,
  }), []);

  const applyActiveSessionId = useCallback(id => {
    activeSessionIdRef.current = id;
    setActiveSessionIdState(id);
  }, []);

  const setPendingTarget = useCallback(target => {
    const value = normalizePendingTarget(target);
    pendingTargetRef.current = value;
    setPendingTargetState(value);
  }, []);

  const consumePendingTarget = useCallback(() => {
    const value = pendingTargetRef.current;
    pendingTargetRef.current = null;
    setPendingTargetState(null);
    return value;
  }, []);

  const setPendingQuote = useCallback(quote => {
    const value = normalizePendingQuote(quote);
    if (value && !value.payload.text) return;
    pendingQuoteRef.current = value;
    setPendingQuoteState(value);
  }, []);

  const consumePendingQuote = useCallback(() => {
    const value = pendingQuoteRef.current;
    pendingQuoteRef.current = null;
    setPendingQuoteState(null);
    return value;
  }, []);

  const refreshSessionsDirect = useCallback(async () => {
    // 先等存储层会话写入（含旧消息迁移）排空：迁移在 storage 的队列里，
    // 与这里的 mutation 队列不是同一个；不等待会在迁移写盘中途读到中间态。
    await whenSessionMutationsSettled();
    const [sessionList, storedActiveSession] = await Promise.all([
      getSessions(),
      getActiveSessionIdStatus(),
    ]);
    const sorted = applySessions(sessionList);
    const resolved = resolveActiveSessionId(sorted, storedActiveSession.value);
    applyActiveSessionId(resolved);
    return sorted;
  }, [applySessions, applyActiveSessionId]);

  // 外部刷新也要进 mutation 队列：否则迁移/写入进行中的刷新可能用旧快照覆盖新 Context。
  const refreshSessions = useCallback(
    () => enqueueMutation(() => refreshSessionsDirect()),
    [enqueueMutation, refreshSessionsDirect]
  );

  const refreshAppData = useCallback(async () => {
    await enqueueMutation(async () => {
      const [list, storedActive, sessionList, storedActiveSession] = await Promise.all([
        getCharacterLibrary(),
        getActiveCharacterIdStatus(),
        getSessions(),
        getActiveSessionIdStatus(),
      ]);
      const resolvedList = Array.isArray(list) && list.length > 0 ? list : [DEFAULT_CHARACTER];
      const resolved = resolveActiveId(resolvedList, storedActive.value);
      const sortedSessions = sortSessions(sessionList);
      const resolvedSessionId = resolveActiveSessionId(sortedSessions, storedActiveSession.value);
      charactersRef.current = resolvedList;
      activeIdRef.current = resolved;
      sessionsRef.current = sortedSessions;
      activeSessionIdRef.current = resolvedSessionId;
      setCharactersState(resolvedList);
      setActiveIdState(resolved);
      setSessionsState(sortedSessions);
      setActiveSessionIdState(resolvedSessionId);
      setMessageRefreshTick(tick => tick + 1);
    });
  }, [enqueueMutation]);

  const ensureCharacterSession = useCallback(async (characterId, opening = null) => {
    if (!loadedRef.current) {
      throw new Error(tActive('error.context.sessionNotLoaded'));
    }
    return enqueueMutation(async () => {
      const targetId = String(characterId || '');
      const existing = sessionsRef.current.find(session => session.characterId === targetId);
      if (existing) {
        if (activeSessionIdRef.current !== existing.id) {
          applyActiveSessionId(existing.id);
          await setActiveSessionId(existing.id);
        }
        return existing;
      }
      try {
        const created = await startNewSession(targetId, opening);
        await refreshSessionsDirect();
        return sessionsRef.current.find(session => session.id === created.id) || created;
      } catch (error) {
        await refreshSessionsDirect().catch(() => {});
        throw error;
      }
    });
  }, [applyActiveSessionId, refreshSessionsDirect, enqueueMutation]);

  // 主动消息落库：把原生待写队列里的消息逐条写入各自角色的单聊会话，再刷新列表。
  // 目标会话由槽的 sessionTargetId 决定：命中该角色的历史对话则写入，否则新建一段并把槽绑定过去
  // （下次触发即固定复用；该会话若被删除则视为空，再次新建）。
  // 返回 { written, skipped, deferred, targetSessions }：
  //   written        已写入，可 ack 删除；
  //   skipped        结构残缺、永远无法处理，可 ack 删除；
  //   deferred       暂时处理不了（角色不在库/写入失败），**不 ack**，保留重试；
  //   targetSessions roleId → 本次消息实际写入的 sessionId，供通知跳转精确切到那段会话。
  // ⚠️ 三类**互斥且穷尽**：每条消息恰好属于其中一类；Context 未加载完成时全部算 deferred。
  // Z 系采纳 #9：领域逻辑外提到 context/proactiveIngest.js（可单测），这里只做装配。
  const ingestProactiveMessages = useCallback(async messages => {
    // 未加载完成：**全部归入 deferred**（保留重试），不返回四类全空。
    // 为什么不能返回全空：上面那张契约表是「三类互斥且穷尽」，全空意味着这批消息**不属于任何
    // 一类**——调用方按「全部 − deferred = 可 ack」判定消费（最自然的读法）就会把还没落库的
    // 消息从原生队列里删掉（丢消息）。当前唯一调用方（App.js）恰好「不 ack、下次重试」才没暴露，
    // 但那是运气不是契约；未加载完成本就是「暂时处理不了」，与 deferred 同义。元素口径也一致：
    // 装**消息 id**（无 id 的与正常路径同款忽略——那边也是 `if (!id) continue`）。
    if (!loadedRef.current) {
      const deferred = (Array.isArray(messages) ? messages : [])
        .map(message => String((message && message.id) || ''))
        .filter(Boolean);
      return { written: [], skipped: [], deferred, targetSessions: {} };
    }
    return ingestProactiveMessagesInto({
      messages,
      characters: charactersRef.current,
      getProactiveSettings,
      appendProactiveMessage,
      bindProactiveSlotSession,
      onWritten: async () => {
        await refreshSessionsDirect().catch(() => {});
        setMessageRefreshTick(tick => tick + 1);
      },
    });
  }, [refreshSessionsDirect]);

  const switchSession = useCallback(async id => {
    if (!loadedRef.current) {
      throw new Error(tActive('error.context.sessionNotLoaded'));
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotSessions();
      const target = snapshot.sessions.find(session => session.id === id);
      if (!target) {
        throw new Error(tActive('error.context.sessionNotFound'));
      }
      if (id === snapshot.activeSessionId) return target;
      applyActiveSessionId(id);
      await runWithRollback(snapshot, restoreSessions, () => setActiveSessionId(id));
      return target;
    });
  }, [applyActiveSessionId, restoreSessions, snapshotSessions, enqueueMutation]);

  const pinSession = useCallback(async id => {
    if (!loadedRef.current) {
      throw new Error(tActive('error.context.sessionNotLoaded'));
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotSessions();
      if (!snapshot.sessions.some(session => session.id === id)) {
        throw new Error(tActive('error.context.sessionNotFound'));
      }
      try {
        // 交给存储层在会话队列内读-改-写：用内存旧快照整表覆盖会打回并发写入
        // （如主动消息落库新建的会话行）。
        const updated = await setSessionPinned(id, !(snapshot.sessions.find(
          session => session.id === id
        ) || {}).pinned);
        const next = snapshot.sessions.map(session => (
          session.id === id ? (updated || session) : session
        ));
        return applySessions(next);
      } catch (error) {
        await refreshSessionsDirect().catch(() => {});
        throw error;
      }
    });
  }, [applySessions, refreshSessionsDirect, snapshotSessions, enqueueMutation]);

  const cloneSession = useCallback(async id => {
    if (!loadedRef.current) {
      throw new Error(tActive('error.context.sessionNotLoaded'));
    }
    return enqueueMutation(async () => {
      const snapshot = snapshotSessions();
      if (!snapshot.sessions.some(session => session.id === id)) {
        throw new Error(tActive('error.context.sessionNotFound'));
      }
      const copy = await cloneSessionStorage(id);
      applySessions([...sessionsRef.current, copy]);
      return copy;
    });
  }, [applySessions, snapshotSessions, enqueueMutation]);

  const deleteSession = useCallback(async id => {
    if (!loadedRef.current) {
      throw new Error(tActive('error.context.sessionNotLoaded'));
    }
    return enqueueMutation(async () => {
      try {
        const result = await deleteSessionStorage(id);
        applySessions(result.sessions);
        applyActiveSessionId(result.activeSessionId);
        // 删除会话会触发记忆归属对账（可能退休卡上的记忆条目），内存角色库要跟盘一致。
        await refreshCharactersDirect().catch(() => {});
        return result;
      } catch (error) {
        await refreshSessionsDirect().catch(() => {});
        throw error;
      }
    });
  }, [applySessions, applyActiveSessionId, refreshCharactersDirect, refreshSessionsDirect, enqueueMutation]);

  const deleteSessions = useCallback(async (ids, excludedCharacterIds = []) => {
    if (!loadedRef.current) {
      throw new Error(tActive('error.context.sessionNotLoaded'));
    }
    const targets = (Array.isArray(ids) ? ids : [])
      .map(id => String(id || ''))
      .filter(Boolean);
    const excluded = new Set(
      (Array.isArray(excludedCharacterIds) ? excludedCharacterIds : [])
        .map(id => String(id || ''))
        .filter(Boolean)
    );
    if (targets.length === 0) return sessionsRef.current;
    return enqueueMutation(async () => {
      const snapshot = snapshotSessions();
      try {
        const result = await deleteSessionsStorage(targets);
        let sorted = applySessions(result.sessions);
        let resolved = resolveActiveSessionId(sorted, result.activeSessionId);
        if (targets.includes(snapshot.activeSessionId) && sorted.length === 0) {
          const current = snapshot.sessions.find(
            session => session.id === snapshot.activeSessionId
          );
          const available = charactersRef.current.filter(item => !excluded.has(String(item.id || '')));
          const currentOwner = current && current.type !== 'group'
            ? String(current.characterId || '')
            : '';
          const activeOwner = String(activeIdRef.current || '');
          const fallbackCharacterId = (
            (currentOwner && available.some(item => item.id === currentOwner) && currentOwner)
            || (available.some(item => item.id === activeOwner) && activeOwner)
            || (available.find(item => item.id === DEFAULT_CHARACTER.id) || {}).id
            || (available[0] || {}).id
            || ''
          );
          await startNewSession(fallbackCharacterId);
          sorted = await refreshSessionsDirect();
          resolved = resolveActiveSessionId(sorted, activeSessionIdRef.current);
        }
        applyActiveSessionId(resolved);
        // 同上：批量删除后把角色库的内存快照刷新回与盘一致。
        await refreshCharactersDirect().catch(() => {});
        return sorted;
      } catch (error) {
        await refreshSessionsDirect().catch(() => {});
        throw error;
      }
    });
  }, [applySessions, applyActiveSessionId, refreshCharactersDirect, refreshSessionsDirect, enqueueMutation]);

  // activeId 失效（存储损坏 / 角色被外部删除）时界面角色会退回初始卡。若同时继续对外
  // 暴露失效的 activeId，就会造成“高亮的角色”和“当前角色”不是同一个的身份错位，后续
  // 按 activeId 落盘的数据也会指错人。这里统一以解析出的角色为准：character.id 就是
  // 唯一有效的 activeId。
  const character = useMemo(
    () => characters.find(item => item.id === activeId)
      || characters.find(item => item.id === DEFAULT_CHARACTER.id)
      || DEFAULT_CHARACTER,
    [characters, activeId]
  );
  const resolvedActiveId = character.id;

  // activeId 与当前角色不一致时立即修正并落盘，避免失效 id 一直留在存储里。
  useEffect(() => {
    if (!loaded || isCharacterLibraryWriteBlocked()) return;
    if (activeIdRef.current === resolvedActiveId) return;
    activeIdRef.current = resolvedActiveId;
    setActiveIdState(resolvedActiveId);
    setActiveCharacterId(resolvedActiveId).catch(() => {});
  }, [loaded, resolvedActiveId]);

  const dismissStartupError = useCallback(() => setStartupError(null), []);

  const value = useMemo(
    () => ({
      character,
      characters,
      activeId: resolvedActiveId,
      loaded,
      startupError,
      dismissStartupError,
      updateCharacter,
      switchCharacter,
      addCharacter,
      deleteCharacter,
      pinCharacter,
      deleteCharacters,
      sessions,
      activeSessionId,
      switchSession,
      pinSession,
      cloneSession,
      deleteSession,
      deleteSessions,
      refreshSessions,
      refreshCharacters,
      refreshAppData,
      ensureCharacterSession,
      ingestProactiveMessages,
      messageRefreshTick,
      pendingTarget,
      setPendingTarget,
      consumePendingTarget,
      pendingQuote,
      setPendingQuote,
      consumePendingQuote,
    }),
    [
      character,
      characters,
      resolvedActiveId,
      loaded,
      startupError,
      dismissStartupError,
      updateCharacter,
      switchCharacter,
      addCharacter,
      deleteCharacter,
      pinCharacter,
      deleteCharacters,
      sessions,
      activeSessionId,
      switchSession,
      pinSession,
      cloneSession,
      deleteSession,
      deleteSessions,
      refreshSessions,
      refreshCharacters,
      refreshAppData,
      ensureCharacterSession,
      ingestProactiveMessages,
      messageRefreshTick,
      pendingTarget,
      setPendingTarget,
      consumePendingTarget,
      pendingQuote,
      setPendingQuote,
      consumePendingQuote,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) {
    // 开发者错误（在 Provider 外用 hook），但仍走 i18n：仓库铁律是用户可见文案不硬编码，
    // 且开发期报错也可能被错误边界渲染到界面上。
    throw new Error(tActive('error.context.providerMissing'));
  }
  return ctx;
}
