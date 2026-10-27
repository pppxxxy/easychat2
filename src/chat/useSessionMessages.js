// 从 ChatScreen.js 原样外提（无行为变化）：会话消息的加载、落盘与草稿。
// 涵盖：主动消息 tick 刷新分支、切会话时的草稿落定与数据加载（含群聊开场、
// 内置助手教学开场白）、损坏兜底提示、快照比对 + promise 队列的串行落盘、
// 向量索引增量更新、草稿防抖保存与回填。
// 会话切换时的 UI 复位（附件清理、引用/表情面板/多选等）仍属 ChatScreen，
// 通过 resetSessionUi 回调在原时序位置调用；用户头像回填通过 onProfileLoaded。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { getConfigFingerprint } from '../network/api.js';
import { ASSISTANT_ID } from './chatConstants.js';
import {
  buildGreetingMessage,
  buildPersistableMessages,
  createPersistableSnapshotCache,
} from './chatHelpers.js';
import { generateOpening } from './groupChat.js';
import {
  DEFAULT_CHARACTER,
  hasShownDefaultGreeting,
  markDefaultGreetingShown,
} from '../storage/characters.js';
import { getApiConfigs } from '../storage/apiConfigs.js';
import { getEnabledGlobalPresetPrompts } from '../storage/globalPresets.js';
import {
  getMessagesBySessionStatus,
  getSessionDraft,
  saveMessagesBySession,
  saveSessionDraft,
  clearSessionDraft,
  markSessionRead,
  setSessionGreetingSelected,
} from '../storage/sessions.js';
import { getUserProfile } from '../storage/personas.js';
import { getVectorMemoryConfig, updateVectorIndex } from '../storage/vector.js';
import { indexMessages } from '../vectorMemory/index.js';
import { getVectorOwnerId, shouldIndexSession } from '../vectorMemory/scope.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { createAppLogger } from '../logging/index.js';
import { measureAsync, PERF_THRESHOLDS } from '../logging/perfProbe.js';
// 跨会话运行登记表：流式草稿清理前先看该会话是否仍在后台生成（L 系）。
import { sessionRuns } from '../agent/runtime/sessionRuns.js';
import {
  clearStreamDraft,
  readStreamDraft,
  saveStreamDraft,
  shouldWriteStreamDraft,
} from '../storage/streamDraft.js';
// 输入文本的统一真源（模块级 store）。本 hook 只写；订阅在 ChatComposer。
import { getInput, setInput } from './inputStore.js';

// Z 系采纳 #10：统一分级日志（生产落本地诊断、dev 同时打 console、文本脱敏）。
const vectorLog = createAppLogger('vector');

export default function useSessionMessages({
  activeSessionId,
  loaded,
  sessionOwnerMissing,
  messageRefreshTick,
  characterId,
  character,
  activeSessionIdRef,
  activeCharacterIdRef,
  sessionsRef,
  isGroupRef,
  groupCharactersRef,
  userNameRef,
  attachmentsRef,
  pendingAttachmentUrisRef,
  errorRawRef,
  atBottomRef,
  sendLockRef,
  abortRef,
  sessionVersionRef,
  openingRequestRef,
  openingAbortControllerRef,
  syncActiveRun,
  chatOptions,
  chatOptionsRef,
  resetSessionUi,
  onProfileLoaded,
}) {
  // 翻译经 ref 取用：加载/落盘 effect 的依赖刻意收窄（不含 t），
  // 直接闭包 t 会在切换语言后继续用旧语言。
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  // 落盘基准与保存队列：快照比对去重、失败重试、串行写。
  const lastSavedSnapshotRef = useRef(null);
  const saveFailedRef = useRef(false);
  const saveInFlightSnapshotRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve());
  const saveRetryTimerRef = useRef(null);
  const saveRetryAttemptsRef = useRef(0);
  const [saveRetryTick, setSaveRetryTick] = useState(0);
  // 输入框草稿按会话保留。draftTextRef 只记录“用户真实输入”的文本，程序性的
  // setInput('')（切会话/发送后清空）不经过 onInputChange，因此不会污染草稿。
  const draftSessionIdRef = useRef('');
  const draftTextRef = useRef('');
  const draftSaveTimerRef = useRef(null);
  // 草稿「读不出来」（corrupt）的会话：既不回填、也不置空 draftTextRef，并**禁用该会话的草稿自动保存**
  // ——否则用户接下来的输入会在 400ms 后直接覆盖盘上那份唯一的手打草稿（草稿别处没有副本，
  // 而消息体损坏时 storage/sessionMessages/messages.js 是会先 backupCorruptValue 的）。
  // 读改写路径在「读不出」时必须中止，与 storage/worldMap.js 同口径。
  const draftBlockedSessionIdRef = useRef('');
  // 上一次处理过的主动消息刷新计数：用于把「主动消息落库刷新」与「切会话」区分开。
  const refreshTickRef = useRef(messageRefreshTick);
  // 输入文本自 2026-10-18 起放在模块级 store 里（chat/inputStore.js），不再是 useState。
  // 原因：本 hook 由 ChatScreen 调用，useState 版每敲一个字符都会让 ChatScreen 重渲染
  // （31 个子组件里 28 个未 memo，另有 6 个回调因 input 进依赖而重建）。
  // 现在只有真正渲染这个值的 ChatComposer 订阅它；本 hook 只负责**写**（含草稿联动）。
  // setInput 直接从 store 取（同名，消费方无需改动）。
  const [messages, setMessages] = useState([]);
  const messagesRef = useRef([]);
  messagesRef.current = messages;
  const [ready, setReady] = useState(false);
  const [greetingReady, setGreetingReady] = useState(false);

  // 立即落定某个会话的草稿：开启保留则写入，关闭则清除（避免旧草稿在新开关下复活）。
  const persistDraftNow = useCallback((sessionId, text) => {
    const id = String(sessionId || '');
    if (!id) return;
    // 读不出的会话：读改写路径必须中止，绝不拿默认/空值覆盖盘上那份草稿。
    if (draftBlockedSessionIdRef.current === id) return;
    if (chatOptionsRef.current.keepDraft) {
      saveSessionDraft(id, text).catch(() => {});
    } else {
      clearSessionDraft(id).catch(() => {});
    }
  }, []);

  // 用户真实输入走这里：更新界面与草稿 ref，并在开启保留时防抖写盘。
  // 程序性 setInput（切会话清空、发送后清空、回填）不经过本函数，故不会误写。
  const onInputChange = useCallback(text => {
    setInput(text);
    draftTextRef.current = String(text ?? '');
    if (!chatOptionsRef.current.keepDraft) return;
    const id = String(draftSessionIdRef.current || '');
    if (!id) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    const value = draftTextRef.current;
    draftSaveTimerRef.current = setTimeout(() => {
      draftSaveTimerRef.current = null;
      if (!chatOptionsRef.current.keepDraft) return;
      if (draftBlockedSessionIdRef.current === id) return;
      saveSessionDraft(id, value).catch(() => {});
    }, 400);
  }, []);

  const persistableMessages = useMemo(
    () => buildPersistableMessages(messages),
    [messages]
  );
  // 已提交（非 pending）消息：流式期间 pending 消息不参与落盘
  const committedMessages = useMemo(
    () => (messages || []).filter(item => item && !item.pending),
    [messages]
  );
  const snapshotCacheRef = useRef(null);
  const persistableSnapshot = useMemo(() => {
    if (!snapshotCacheRef.current) snapshotCacheRef.current = createPersistableSnapshotCache();
    return snapshotCacheRef.current.get(committedMessages, messages);
  }, [committedMessages, messages]);

  useEffect(() => {
    if (!loaded) return;
    const loadSessionId = String(activeSessionId || '');
    const previousSessionId = String(draftSessionIdRef.current || '');
    const sessionChanged = previousSessionId !== loadSessionId;
    const tickChanged = refreshTickRef.current !== messageRefreshTick;
    // 后台主动消息落库会把 messageRefreshTick 推进，但会话并未切换。这条路径
    // 只把新落库的消息读回来：绝不清空正在输入的草稿、删除已选附件，也不打断
    // 进行中的请求。正在发送/流式时索性不覆盖本地消息，避免丢掉尚未落盘的回复；
    // 此时不消费 tick，等下一次刷新再补。
    if (!sessionChanged && tickChanged && loadSessionId) {
      if (sendLockRef.current || abortRef.current) return undefined;
      refreshTickRef.current = messageRefreshTick;
      let tickCancelled = false;
      getMessagesBySessionStatus(loadSessionId)
        .then(result => {
          if (tickCancelled) return;
          if (!result || result.status !== 'ok') return;
          const refreshed = Array.isArray(result.messages) ? result.messages : [];
          // 同步落盘基准，避免随后把刚读回的消息当成本地改动又写一遍。
          lastSavedSnapshotRef.current = JSON.stringify(refreshed);
          setMessages(refreshed);
        })
        .catch(() => {});
      return () => {
        tickCancelled = true;
      };
    }
    refreshTickRef.current = messageRefreshTick;
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    // 只在会话真的切换时动草稿：会话内其它依赖（如角色资料缺失）触发的重跑
    // 不应重新回填，否则会覆盖用户正在输入的内容。
    if (sessionChanged) {
      if (previousSessionId) {
        // 离开旧会话：按开关立即落定草稿（开启保存、关闭清除），避免旧草稿复活。
        persistDraftNow(previousSessionId, draftTextRef.current);
      }
      draftSessionIdRef.current = loadSessionId;
      draftTextRef.current = '';
      // 换会话即解除「读不出」封锁（它只针对上一个会话的键）。
      draftBlockedSessionIdRef.current = '';
    }
    resetSessionUi();
    setInput('');
    activeCharacterIdRef.current = characterId;
    activeSessionIdRef.current = activeSessionId;
    sessionVersionRef.current += 1;
    openingRequestRef.current += 1;
    if (openingAbortControllerRef.current) {
      openingAbortControllerRef.current.abort();
      openingAbortControllerRef.current = null;
    }
    let cancelled = false;
    // 切会话**不中止**正在跑的运行（L 系）：旧运行的控制器留在登记表里继续跑，结果落回
    // 它自己的会话。这里只把界面上的发送锁对齐到新会话——切到没在跑的会话即解锁，切回
    // 仍在后台跑的会话即重新上锁（syncActiveRun 同时维护 sendLockRef/abortRef/isSending）。
    syncActiveRun();
    setReady(false);
    errorRawRef.current = {};
    atBottomRef.current = true;
    if (!activeSessionId) {
      lastSavedSnapshotRef.current = '[]';
      setMessages([]);
      setGreetingReady(false);
      setReady(true);
      return () => {
        cancelled = true;
        sessionVersionRef.current += 1;
      };
    }
    const profilePromise = getUserProfile().then(profile => {
      if (cancelled) return;
      userNameRef.current = String(profile.userName || '').trim();
      onProfileLoaded(profile);
    }).catch(() => {});
    // 会话读数耗时进性能探针（默认关闭，只在超过阈值时留一条诊断）。
    // 「切会话卡」与「越用越卡」若源于单个会话的历史过大，这里会先暴露出来。
    measureAsync('session.loadMessages', () => getMessagesBySessionStatus(activeSessionId), PERF_THRESHOLDS.storageRead)
      .then(async result => {
        if (cancelled) return;
        await profilePromise;
        if (cancelled) return;
        // 损坏（读取失败）时不能当成空会话：明确提示记录仍在，且不做后续写盘。
        if (result && result.status === 'corrupt') {
          lastSavedSnapshotRef.current = '[]';
          setMessages([]);
          setGreetingReady(false);
          Alert.alert(
            tRef.current('chat.session.loadFailed.title'),
            tRef.current('chat.session.loadFailed.corruptBody')
          );
          return;
        }
        let initial = Array.isArray(result && result.messages) ? result.messages : [];
        // Z 系采纳 #8：上次非正常中断（进程被杀/断线）留下的流式草稿 → 作为「已恢复」
        // 消息并入时间线，用户看到半截回复而不是空白。读一次即清（之后由常规落盘接管）。
        try {
          const draft = await readStreamDraft(activeSessionId);
          if (cancelled) return;
          if (draft) {
            if (!initial.some(item => String((item && item.id) || '') === draft.messageId)) {
              initial = [...initial, {
                id: draft.messageId,
                role: ASSISTANT_ID,
                text: draft.text,
                reasoning: draft.reasoning || '',
                timestamp: draft.at || Date.now(),
                recovered: true,
              }];
            }
            await clearStreamDraft(activeSessionId);
          }
        } catch (error) {}
        if (initial.length === 0 && isGroupRef.current) {
          const members = groupCharactersRef.current;
          lastSavedSnapshotRef.current = '[]';
          setMessages([]);
          setGreetingReady(true);
          if (members.length > 0) {
            const openingSessionId = activeSessionId;
            const openingToken = openingRequestRef.current;
            const openingController = new AbortController();
            openingAbortControllerRef.current = openingController;
            (async () => {
              try {
                const [profile, presets, apiState] = await Promise.all([
                  getUserProfile().catch(() => null),
                  getEnabledGlobalPresetPrompts().catch(() => []),
                  getApiConfigs().catch(() => ({ configs: [], activeId: '' })),
                ]);
                const currentConfig = (apiState.configs || []).find(
                  item => item.id === apiState.activeId
                ) || (apiState.configs || [])[0];
                const opening = await generateOpening({
                  characters: members,
                  userProfile: profile,
                  globalPresets: presets,
                  expectedConfigId: String(currentConfig && currentConfig.id || ''),
                  expectedConfigFingerprint: currentConfig ? getConfigFingerprint(currentConfig) : '',
                  signal: openingController.signal,
                });
                if (cancelled || !opening) return;
                if (openingRequestRef.current !== openingToken) return;
                if (activeSessionIdRef.current !== openingSessionId) return;
                setMessages(current => current.length === 0
                  ? [{
                      id: `${Date.now()}-opening`,
                      role: ASSISTANT_ID,
                      text: opening.opening,
                      speakerId: opening.speakerId,
                      speakerName: opening.speakerName,
                      timestamp: Date.now(),
                    }]
                  : current);
              } catch (error) {
              } finally {
                if (openingAbortControllerRef.current === openingController) {
                  openingAbortControllerRef.current = null;
                }
              }
            })();
          }
          return;
        }
        // 默认角色（内置助手）的空会话：首次进入自动显示内置教学开场白，
        // 让新手一进来就看到「配 API → 导入角色卡 → 开始聊天」的引导，而不是空白。
        // 仅对内置默认角色、仅当该会话为空、且从未自动展示过时执行一次；
        // 用户自定义开场白的角色、已有消息的会话、以及清空后都不再自动注入。
        if (
          initial.length === 0
          && !isGroupRef.current
          && !sessionOwnerMissing
          && characterId === DEFAULT_CHARACTER.id
          && String(character.firstMes || '').trim()
        ) {
          try {
            const alreadyShown = await hasShownDefaultGreeting();
            if (!cancelled && !alreadyShown && activeSessionIdRef.current === activeSessionId) {
              const greeting = buildGreetingMessage(
                activeSessionId,
                character.firstMes,
                userNameRef.current
              );
              if (greeting) {
                // 不预置 lastSavedSnapshotRef，让常规保存 effect 把这条开场白写盘，
                // 否则重启后（标记已置位、不再自动补）会变成空会话。
                setMessages([greeting]);
                setGreetingReady(true);
                markDefaultGreetingShown().catch(() => {});
                setSessionGreetingSelected(activeSessionId, true).catch(() => {});
                return;
              }
            }
          } catch (error) {
            // 自动开场白失败退回普通空状态，不阻断加载。
          }
        }
        setGreetingReady(
          isGroupRef.current
          || initial.length > 0
          || sessionsRef.current.some(session => (
            session.id === activeSessionId && session.greetingSelected === true
          ))
        );
        lastSavedSnapshotRef.current = JSON.stringify(initial);
        setMessages(initial);
      })
      .catch(() => {
        if (cancelled) return;
        lastSavedSnapshotRef.current = '[]';
        setMessages([]);
        setGreetingReady(false);
        // 读取失败时以前是静默显示空对话，用户很容易误以为记录被清空了。
        // 明确告知：记录还在，只是这次没读出来；且不会覆盖原数据。
        Alert.alert(
          tRef.current('chat.session.loadFailed.title'),
          tRef.current('chat.session.loadFailed.readBody')
        );
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      sessionVersionRef.current += 1;
    };
  }, [activeSessionId, loaded, sessionOwnerMissing, messageRefreshTick, syncActiveRun]);

  // 回填输入草稿。独立于会话加载 effect：chatOptions 是异步读出的，冷启动时
  // 往往晚于会话就绪；若挤在加载 effect 里，keepDraft 还没读出来就会回填失败。
  useEffect(() => {
    if (!loaded || !activeSessionId) return undefined;
    if (!chatOptions.keepDraft) {
      draftTextRef.current = '';
      return undefined;
    }
    const targetSessionId = String(activeSessionId);
    let cancelled = false;
    getSessionDraft(targetSessionId)
      .then(result => {
        if (cancelled) return;
        if (activeSessionIdRef.current !== targetSessionId) return;
        // 「读不出」≠「没有草稿」：三态分流（storage/sessionMessages/drafts.js 现在返回
        // { status, text }）。corrupt 时**不回填、不置空 draftTextRef、并禁用该会话的草稿自动保存**
        // ——否则用户接下来的输入会在 400ms 后覆盖盘上那份唯一的手打草稿。
        if (String((result && result.status) || '') === 'corrupt') {
          draftBlockedSessionIdRef.current = targetSessionId;
          return;
        }
        // 用户已在异步回填前开始输入时，不覆盖他正在写的内容。
        if (draftTextRef.current) return;
        const value = String((result && result.text) || '');
        draftTextRef.current = value;
        if (value) setInput(value);
      })
      .catch(() => {
        // 读取本身抛出（异常路径）同样按「读不出」处理，绝不当作「没有草稿」。
        if (cancelled) return;
        if (activeSessionIdRef.current !== targetSessionId) return;
        draftBlockedSessionIdRef.current = targetSessionId;
      });
    return () => { cancelled = true; };
  }, [activeSessionId, loaded, chatOptions.keepDraft]);

  // 未读小红点的**清除时机**（记忆页行头像角标）。一个 effect 覆盖两种情形，
  // 都归到同一个判据「这个会话的当前消息内容已经摆在用户眼前了」：
  //   ① 打开会话 —— 加载完成（ready）即视为看过；
  //   ② 正在看的会话收到新消息（含流式结束落盘）—— persistableSnapshot 变化。
  // 第 ② 种不能省：否则「看着对方回完、退出」之后，最后一条会把红点重新点亮，
  // 用户点进来却看到没有新东西。
  //
  // 顺序上踩过一次真实的坑，写在这里防复发：本 effect 声明在负责写盘的 effect **之前**，
  // 所以持久化动作是「先标记已读、后写消息」——而写盘那条会在队列内把 updatedAt 推到
  // 此刻（比 lastReadAt 新），于是用户正盯着屏幕、红点却亮起来了（已用真实现复现：
  // updatedAt 比 lastReadAt 大 1ms ⇒ hasSessionUnread 为真）。
  // 所以标记必须发生在**落盘之后**：savePromise 落定（.then）时再标一次。
  // 只前进不后退由 applySessionLastRead 兜住，重复触发无副作用。
  //
  // 失败静默：标记已读是「顺带清理」，绝不能因为写不进去而打断聊天主链路。
  useEffect(() => {
    if (!ready) return;
    if (!activeSessionId) return;
    markSessionRead(activeSessionId).catch(() => {});
  }, [activeSessionId, ready, persistableSnapshot]);

  useEffect(() => {
    if (!ready) return;
    if (!activeSessionId) return;
    if (persistableSnapshot === lastSavedSnapshotRef.current) return;
    if (persistableSnapshot === saveInFlightSnapshotRef.current) return;
    saveInFlightSnapshotRef.current = persistableSnapshot;
    const snapshotBeingSaved = persistableSnapshot;
    const indexController = typeof AbortController === 'function' ? new AbortController() : null;
    const scheduleSaveRetry = () => {
      if (saveRetryTimerRef.current) clearTimeout(saveRetryTimerRef.current);
      if (saveRetryAttemptsRef.current >= 5) return;
      saveRetryAttemptsRef.current += 1;
      const delay = Math.min(3000 * (2 ** (saveRetryAttemptsRef.current - 1)), 60000);
      saveRetryTimerRef.current = setTimeout(() => setSaveRetryTick(tick => tick + 1), delay);
    };
    const messagesToIndex = persistableMessages;
    // 会话条目若已从存储里缺失（历史版本的 startNewSession 会误删），
    // 把归属角色一并传下去，让本次写盘把会话行补回来；群聊没有单一归属角色，跳过。
    const ownerRow = sessionsRef.current.find(item => item.id === activeSessionId);
    const indexableSession = shouldIndexSession(ownerRow);
    const indexedCharacterId = getVectorOwnerId(ownerRow, character.id);

    const recoverOwnerId = isGroupRef.current
      ? ''
      : String((ownerRow && ownerRow.characterId) || character.id || '');
    const indexVersion = sessionVersionRef.current;
    const protectedImageUris = [
      ...attachmentsRef.current
        .filter(item => item && (item.kind === 'image' || item.kind === 'video'))
        .map(item => item.uri),
      ...pendingAttachmentUrisRef.current,
    ];
    // 写盘串行化：同会话连续快照若并行写，旧快照可能在新快照之后落盘，
    // 让持久化结果回退。用 promise 队列保证顺序，后到的快照总是最后写入。
    //
    // measureAsync 包住的是**队列里的这一步**（不是入队本身），所以量到的正是真实
    // 落盘耗时：默认关闭时它只多一次布尔判断，开启后超过 120ms 才留一条诊断。
    const savePromise = saveQueueRef.current
      .catch(() => {})
      .then(() => measureAsync(
        'session.saveMessages',
        () => saveMessagesBySession(
          activeSessionId,
          persistableMessages,
          recoverOwnerId,
          protectedImageUris
        ),
        PERF_THRESHOLDS.storageWrite
      ));
    saveQueueRef.current = savePromise;
    savePromise
      .then(savedMessages => {
        if (saveInFlightSnapshotRef.current === snapshotBeingSaved) {
          saveInFlightSnapshotRef.current = null;
        }
        saveRetryAttemptsRef.current = 0;
        if (saveRetryTimerRef.current) {
          clearTimeout(saveRetryTimerRef.current);
          saveRetryTimerRef.current = null;
        }
        lastSavedSnapshotRef.current = snapshotBeingSaved;
        saveFailedRef.current = false;
        // 落盘已经写进 updatedAt = 此刻，这里补标一次「已读」，红点才不会在用户
        // 正看着会话时被自己刚发出的消息点亮（顺序陷阱见上方 mark effect 的注释）。
        // 只在这个会话仍是当前会话时才标：切走了就不算「看过」。
        if (activeSessionIdRef.current === activeSessionId) {
          markSessionRead(activeSessionId).catch(() => {});
        }
        if (
          !Array.isArray(savedMessages)
          || savedMessages.length === 0
          || activeSessionIdRef.current !== activeSessionId
          || !indexableSession
          || !indexedCharacterId

        ) return;
        getVectorMemoryConfig()
          .then(config => {
            if (
              activeSessionIdRef.current !== activeSessionId
              || sessionVersionRef.current !== indexVersion
              || !indexableSession
            ) return null;

            // 向量记忆**关闭**时不读也不写索引。此前这里照常走 updateVectorIndex：
            // indexMessages 在关闭时原样返回 current（见 vectorMemory/index.js:329-331），
            // 于是这次调用既付出「读整条索引」的代价（getItem + JSON.parse +
            // normalizeVectorIndex，都是 O(条数×维度)；实测 1000 条 × 1024 维单键约 19.8MB，
            // parse 71ms + normalize 16ms，且超过 CursorWindow 约 2MB 的读取上限后还要走
            // storage/io.js 的 SQLite 分块兜底），又把同一份内容整键写回。
            // 关掉向量记忆的用户每次发消息都在付这笔钱——「关了也一样卡」的由来之一。
            if (config.enabled !== true) return null;

            return updateVectorIndex(indexedCharacterId, current => {
              if (
                activeSessionIdRef.current !== activeSessionId
                || sessionVersionRef.current !== indexVersion
                || !indexableSession
              ) return undefined;

              return indexMessages({
                messages: messagesToIndex,
                config,
                existing: current,
                sessionId: activeSessionId,
                signal: indexController ? indexController.signal : null,
              });
            });
          })
          .catch(error => {
            vectorLog.warn('indexing failed', error);
          });
      }).catch(() => {
        if (saveInFlightSnapshotRef.current === snapshotBeingSaved) {
          saveInFlightSnapshotRef.current = null;
        }
        scheduleSaveRetry();
        if (!saveFailedRef.current) {
          saveFailedRef.current = true;
          Alert.alert(tRef.current('chat.session.saveFailed.title'), tRef.current('chat.session.saveFailed.body'));
        }
      });
    return () => {
      // 切会话/卸载或下一次保存到来时，终止仍在进行的向量嵌入，避免无谓网络与写入。
      if (indexController) indexController.abort();
    };
  }, [activeSessionId, persistableSnapshot, ready, character.id, saveRetryTick]);

  // Z 系采纳 #8：流式草稿——生成中按节流把**部分回复**落盘（供进程被杀后恢复），
  // 没有 pending 消息时清掉（正常结束/取消/失败）。
  const streamDraftRef = useRef({ sessionId: '', at: 0, len: 0, active: false });
  useEffect(() => {
    const sessionId = String(activeSessionIdRef.current || '');
    const pending = (messages || []).find(item => (
      item && item.pending && item.role === ASSISTANT_ID && !item.transient
    ));
    if (pending) {
      const len = String(pending.text || '').length;
      const now = Date.now();
      if (!shouldWriteStreamDraft({
        lastAt: streamDraftRef.current.at,
        now,
        lastLen: streamDraftRef.current.len,
        nextLen: len,
      })) return;
      streamDraftRef.current = { sessionId, at: now, len, active: true };
      saveStreamDraft(sessionId, {
        messageId: pending.id,
        text: pending.text,
        reasoning: pending.reasoning,
        at: now,
      }).catch(() => {});
      return;
    }
    if (streamDraftRef.current.active) {
      const previous = streamDraftRef.current.sessionId;
      streamDraftRef.current = { sessionId: '', at: 0, len: 0, active: false };
      // 草稿所属会话仍在后台跑（L 系切会话不中止生成）时**不能**删草稿：此刻删掉，
      // 「进程被杀恢复半截回复」的承诺就对后台生成静默失效，而切换会话是高频操作。
      // 交给正常生命周期收尾：完成落库（persistBackgroundReply 成功即清）/取消/
      // 会话删除（sessionList/mutations 已有清理），或用户切回时由上方读路径消费（读一次即清）。
      if (previous && !sessionRuns.isRunning(previous)) {
        clearStreamDraft(previous).catch(() => {});
      }
    }
  }, [messages]);

  useEffect(() => () => {
    if (saveRetryTimerRef.current) {
      clearTimeout(saveRetryTimerRef.current);
      saveRetryTimerRef.current = null;
    }
  }, []);

  return {
    // input 不再随返回值暴露：它现在是模块级 store 的值，宿主用 getInput() 在**调用期**
    // 读取（不订阅 ⇒ 不因按键重渲染）。setInput 照旧暴露（就是 store 的 setInput），
    // 消费方的 `setInput('')` 等调用一字不变。
    getInput,
    setInput,
    onInputChange,
    persistDraftNow,
    draftTextRef,
    messages,
    setMessages,
    messagesRef,
    ready,
    greetingReady,
    setGreetingReady,
  };
}
