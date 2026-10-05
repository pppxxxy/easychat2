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
  getApiConfigs,
  getEnabledGlobalPresetPrompts,
  getMessagesBySessionStatus,
  getSessionDraft,
  getUserProfile,
  hasShownDefaultGreeting,
  markDefaultGreetingShown,
  saveMessagesBySession,
  saveSessionDraft,
  clearSessionDraft,
  setSessionGreetingSelected,
  getVectorMemoryConfig,
  updateVectorIndex,
} from '../storage.js';
import { indexMessages } from '../vectorMemory/index.js';
import { getVectorOwnerId, shouldIndexSession } from '../vectorMemory/scope.js';

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
  setIsSending,
  chatOptions,
  chatOptionsRef,
  resetSessionUi,
  onProfileLoaded,
}) {
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
  // 上一次处理过的主动消息刷新计数：用于把「主动消息落库刷新」与「切会话」区分开。
  const refreshTickRef = useRef(messageRefreshTick);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const messagesRef = useRef([]);
  messagesRef.current = messages;
  const [ready, setReady] = useState(false);
  const [greetingReady, setGreetingReady] = useState(false);

  // 立即落定某个会话的草稿：开启保留则写入，关闭则清除（避免旧草稿在新开关下复活）。
  const persistDraftNow = useCallback((sessionId, text) => {
    const id = String(sessionId || '');
    if (!id) return;
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
    sendLockRef.current = null;
    let cancelled = false;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setReady(false);
    setIsSending(false);
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
    getMessagesBySessionStatus(activeSessionId)
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
            '聊天记录读取失败',
            '本次没能读出该会话的消息（可能因数据过大）。系统已停止本次自动写回；继续发送会生成新记录，请先保留设备数据后再操作。'
          );
          return;
        }
        const initial = Array.isArray(result && result.messages) ? result.messages : [];
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
          '聊天记录读取失败',
          '本次没能读出该会话的消息（可能因数据过大）。记录本身没有被删除，可稍后重试；继续发送可能覆盖原内容。'
        );
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      sessionVersionRef.current += 1;
    };
  }, [activeSessionId, loaded, sessionOwnerMissing, messageRefreshTick]);

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
      .then(text => {
        if (cancelled) return;
        if (activeSessionIdRef.current !== targetSessionId) return;
        // 用户已在异步回填前开始输入时，不覆盖他正在写的内容。
        if (draftTextRef.current) return;
        const value = String(text || '');
        draftTextRef.current = value;
        if (value) setInput(value);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeSessionId, loaded, chatOptions.keepDraft]);

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
    const savePromise = saveQueueRef.current
      .catch(() => {})
      .then(() => saveMessagesBySession(
        activeSessionId,
        persistableMessages,
        recoverOwnerId,
        protectedImageUris
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
            if (__DEV__) console.warn('[vector] indexing failed', error);
          });
      }).catch(() => {
        if (saveInFlightSnapshotRef.current === snapshotBeingSaved) {
          saveInFlightSnapshotRef.current = null;
        }
        scheduleSaveRetry();
        if (!saveFailedRef.current) {
          saveFailedRef.current = true;
          Alert.alert('聊天记录保存失败', '请检查存储空间或权限。');
        }
      });
    return () => {
      // 切会话/卸载或下一次保存到来时，终止仍在进行的向量嵌入，避免无谓网络与写入。
      if (indexController) indexController.abort();
    };
  }, [activeSessionId, persistableSnapshot, ready, character.id, saveRetryTick]);

  useEffect(() => () => {
    if (saveRetryTimerRef.current) {
      clearTimeout(saveRetryTimerRef.current);
      saveRetryTimerRef.current = null;
    }
  }, []);

  return {
    input,
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
