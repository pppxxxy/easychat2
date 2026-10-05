// 从 ChatScreen.js 原样外提（无行为变化）：角色/群聊切换、开场白确认、新建对话。
// 四个入口共享同一套「草稿快照 → token 守卫 → 失效 → 复位/回滚」骨架。
// isSwitching 状态仍归 ChatScreen（useSessionMessages 的复位回调依赖它，
// 避免 hook 调用顺序成环）；switcherOpen 随本 hook 持有。

import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import { deleteLocalImage, deleteLocalVideo, deleteTemporaryImage } from './attachments.js';
import { buildGreetingMessage } from './chatHelpers.js';
import { isGreetingMessage } from '../character/cardGreetings.js';
import {
  createGroupSession,
  setProtectedChatImageUris,
  setSessionGreetingSelected,
  startNewSession,
} from '../storage.js';
import { useTranslation } from '../i18n/I18nContext.js';

export default function useSessionSwitch({
  // 状态值（依赖数组所需，引用变化即重建回调）
  input,
  fullScreenText,
  attachments,
  quoteTarget,
  stickerPanelOpen,
  stickerNamePrompt,
  stickerNameDraft,
  isSwitching,
  isSending,
  ready,
  sessionOwnerMissing,
  sessionTransitionPending,
  greetingPicker,
  setGreetingPicker,
  messages,
  setIsSending,
  // setter
  setInput,
  setFullScreenText,
  setAttachments,
  setQuoteTarget,
  setStickerPanelOpen,
  setStickerNamePrompt,
  setStickerNameDraft,
  setIsSwitching,
  setSearchOpen,
  setSearchQuery,
  setActiveMatchIndex,
  setFocusedMessageId,
  setSelectionText,
  setGreetingReady,
  setMessages,
  // ref
  attachmentsRef,
  activeCharacterIdRef,
  activeSessionIdRef,
  switchOperationRef,
  sessionVersionRef,
  abortRef,
  errorRawRef,
  sessionsRef,
  isGroupRef,
  groupCharactersRef,
  userNameRef,
  // 回调与上下文
  invalidateSessionOperations,
  closeStickerNamePrompt,
  openGreetingPicker,
  switchCharacter,
  switchSession,
  ensureCharacterSession,
  refreshSessions,
  updateCharacter,
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const { t } = useTranslation();

  const onSwitch = useCallback(id => {
    if (isSwitching) return;
    setSwitcherOpen(false);
    if (id === activeCharacterIdRef.current && !isGroupRef.current) return;
    const previousCharacterId = activeCharacterIdRef.current;
    const previousSessionId = activeSessionIdRef.current;
    const draft = {
      input,
      fullScreenText,
      attachments: [...attachments],
      quoteTarget,
      stickerPanelOpen,
      stickerNamePrompt,
      stickerNameDraft,
    };
    const switchToken = ++switchOperationRef.current;
    setIsSwitching(true);
    invalidateSessionOperations();
    activeCharacterIdRef.current = id;
    setProtectedChatImageUris(draft.attachments
      .filter(item => item && (item.kind === 'image' || item.kind === 'video'))
      .map(item => item.uri));
    attachmentsRef.current = [];
    setQuoteTarget(null);
    setInput('');
    setFullScreenText('');
    setAttachments([]);
    setStickerPanelOpen(false);
    setStickerNamePrompt(null);
    setStickerNameDraft('');
    switchCharacter(id)
      .then(() => (
        switchOperationRef.current === switchToken
          ? ensureCharacterSession(id)
          : null
      ))
      .then(() => {
        if (switchOperationRef.current !== switchToken) return;
        draft.attachments.forEach(item => {
          if (item.kind === 'image') deleteLocalImage(item.uri);
          if (item.kind === 'video') deleteLocalVideo(item.uri);
        });
        if (draft.stickerNamePrompt && draft.stickerNamePrompt.uri) {
          deleteTemporaryImage(draft.stickerNamePrompt.uri);
        }
        setProtectedChatImageUris([]);
        setIsSwitching(false);
      })
      .catch(async () => {
        if (switchOperationRef.current !== switchToken) return;

        try {
          await switchCharacter(previousCharacterId);
          if (previousSessionId) await switchSession(previousSessionId);
        } catch (error) {}
        setIsSwitching(false);
        activeCharacterIdRef.current = previousCharacterId;
        activeSessionIdRef.current = previousSessionId;
        sessionVersionRef.current += 1;
        setInput(draft.input);
        setFullScreenText(draft.fullScreenText);
        setAttachments(draft.attachments);
        attachmentsRef.current = draft.attachments;
        setQuoteTarget(draft.quoteTarget);
        setStickerPanelOpen(draft.stickerPanelOpen);
        setStickerNamePrompt(draft.stickerNamePrompt);
        setStickerNameDraft(draft.stickerNameDraft);
        setProtectedChatImageUris(draft.attachments
          .filter(item => item && (item.kind === 'image' || item.kind === 'video'))
          .map(item => item.uri));
        Alert.alert(t('chat.session.switchFailed.title'), t('chat.session.switchFailed.body'));
      });
  }, [attachments, closeStickerNamePrompt, ensureCharacterSession, fullScreenText, input, invalidateSessionOperations, isSwitching, quoteTarget, stickerNameDraft, stickerNamePrompt, stickerPanelOpen, switchCharacter, t]);

  const onSwitchGroup = useCallback(id => {
    if (isSwitching) return;
    setSwitcherOpen(false);
    if (id === activeSessionIdRef.current) return;
    const previousSessionId = activeSessionIdRef.current;
    const draft = {
      input,
      fullScreenText,
      attachments: [...attachments],
      quoteTarget,
      stickerPanelOpen,
      stickerNamePrompt,
      stickerNameDraft,
    };
    const switchToken = ++switchOperationRef.current;
    setIsSwitching(true);
    invalidateSessionOperations();
    activeSessionIdRef.current = id;
    setProtectedChatImageUris(draft.attachments
      .filter(item => item && (item.kind === 'image' || item.kind === 'video'))
      .map(item => item.uri));
    attachmentsRef.current = [];
    setQuoteTarget(null);
    setInput('');
    setFullScreenText('');
    setAttachments([]);
    setStickerPanelOpen(false);
    setStickerNamePrompt(null);
    setStickerNameDraft('');
    switchSession(id)
      .then(() => {
        if (switchOperationRef.current !== switchToken) return;
        draft.attachments.forEach(item => {
          if (item.kind === 'image') deleteLocalImage(item.uri);
          if (item.kind === 'video') deleteLocalVideo(item.uri);
        });
        if (draft.stickerNamePrompt && draft.stickerNamePrompt.uri) {
          deleteTemporaryImage(draft.stickerNamePrompt.uri);
        }
        setProtectedChatImageUris([]);
        setIsSwitching(false);
      })
      .catch(async () => {
        if (switchOperationRef.current !== switchToken) return;

        try {
          await switchSession(previousSessionId);
        } catch (error) {}
        setIsSwitching(false);
        activeSessionIdRef.current = previousSessionId;
        sessionVersionRef.current += 1;
        setInput(draft.input);
        setFullScreenText(draft.fullScreenText);
        setAttachments(draft.attachments);
        attachmentsRef.current = draft.attachments;
        setQuoteTarget(draft.quoteTarget);
        setStickerPanelOpen(draft.stickerPanelOpen);
        setStickerNamePrompt(draft.stickerNamePrompt);
        setStickerNameDraft(draft.stickerNameDraft);
        setProtectedChatImageUris(draft.attachments
          .filter(item => item && (item.kind === 'image' || item.kind === 'video'))
          .map(item => item.uri));
        Alert.alert(t('chat.session.switchFailed.title'), t('chat.session.switchFailed.body'));
      });
  }, [attachments, closeStickerNamePrompt, fullScreenText, input, invalidateSessionOperations, isSwitching, quoteTarget, stickerNameDraft, stickerNamePrompt, stickerPanelOpen, switchSession, t]);

  const confirmGreeting = useCallback(async result => {
    const flow = greetingPicker;
    if (!flow) return false;
    const characterId = activeCharacterIdRef.current;
    const sessionId = activeSessionIdRef.current;
    const transitionToken = flow.purpose === 'new' ? ++switchOperationRef.current : 0;
    const transitionVersion = sessionVersionRef.current;
    if (flow.purpose === 'new') setIsSwitching(true);
    try {
      await updateCharacter({
        id: characterId,
        firstMes: result.firstMes,
        alternateGreetings: result.alternateGreetings,
      });
      if (activeCharacterIdRef.current !== characterId) return false;
      if (
        flow.purpose === 'new'
        && (
          switchOperationRef.current !== transitionToken
          || sessionVersionRef.current !== transitionVersion
          || activeSessionIdRef.current !== sessionId
        )
      ) return false;
      if (flow.purpose === 'new') {
        if (abortRef.current) {
          abortRef.current.abort();
          abortRef.current = null;
        }
        setIsSending(false);
        const openingTemplate = String(result.firstMes || '');
        const openingText = openingTemplate.replace(/\{\{user\}\}/g, () => userNameRef.current || t('chat.session.defaultUser'));
        const created = await startNewSession(characterId, {
          text: openingText,
          template: openingTemplate,
        });
        if (
          switchOperationRef.current !== transitionToken
          || activeCharacterIdRef.current !== characterId
          || (
            activeSessionIdRef.current !== sessionId
            && activeSessionIdRef.current !== created.id
          )
        ) return false;
        activeSessionIdRef.current = created.id;
        await refreshSessions();
        if (
          switchOperationRef.current !== transitionToken
          || activeCharacterIdRef.current !== characterId
          || activeSessionIdRef.current !== created.id
        ) return false;
        errorRawRef.current = {};
        sessionVersionRef.current += 1;
        setMessages([]);
        setAttachments([]);
        setQuoteTarget(null);
        setSearchOpen(false);
        setSearchQuery('');
        setActiveMatchIndex(0);
        setFocusedMessageId('');
        setSelectionText('');
        setGreetingReady(true);
        setGreetingPicker(null);
        return true;
      }
      if (activeSessionIdRef.current !== sessionId) return false;
      await setSessionGreetingSelected(sessionId, true);
      await refreshSessions();
      if (
        activeCharacterIdRef.current !== characterId
        || activeSessionIdRef.current !== sessionId
      ) return false;
      const nextGreeting = buildGreetingMessage(sessionId, result.firstMes, userNameRef.current);
      const hasGreeting = messages.some(item => isGreetingMessage(item, sessionId));
      if (nextGreeting) {
        setMessages(current => hasGreeting
          ? current.map(item => (
            isGreetingMessage(item, sessionId)
              ? { ...item, ...nextGreeting, id: item.id, timestamp: item.timestamp }
              : item
          ))
          : [nextGreeting, ...current]);
      } else {
        setMessages(current => current.filter(item => !isGreetingMessage(item, sessionId)));
      }
      setGreetingReady(true);
      setGreetingPicker(null);
      return true;
    } catch (error) {
      if (
        flow.purpose === 'new'
        && (
          switchOperationRef.current !== transitionToken
          || activeCharacterIdRef.current !== characterId
          || (
            activeSessionIdRef.current !== sessionId
            && activeSessionIdRef.current !== ''
          )
        )
      ) return false;
      Alert.alert(t('chat.session.greetingSaveFailed.title'), t('chat.session.greetingSaveFailed.body'));
      return false;
    } finally {
      if (
        flow.purpose === 'new'
        && switchOperationRef.current === transitionToken
      ) setIsSwitching(false);
    }
  }, [greetingPicker, messages, refreshSessions, updateCharacter, t]);

  const onNewChat = useCallback(() => {
    if (isSending || isSwitching || !ready || sessionTransitionPending || abortRef.current) return;
    if (sessionOwnerMissing) {
      Alert.alert(t('chat.session.ownerMissing.title'), t('chat.session.ownerMissing.newChatBody'));
      return;
    }
    if (isGroupRef.current && groupCharactersRef.current.length > 0) {
      Alert.alert(t('chat.session.newChat.title'), t('chat.session.newChat.body'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('chat.session.newChat.confirm'),
          onPress: async () => {
            const transitionToken = ++switchOperationRef.current;
            const previousCharacterId = activeCharacterIdRef.current;
            const previousSessionId = activeSessionIdRef.current;
            setIsSwitching(true);
            if (abortRef.current) {
              abortRef.current.abort();
              abortRef.current = null;
            }
            setIsSending(false);
            try {
              const current = sessionsRef.current.find(item => item.id === previousSessionId);
              const created = await createGroupSession(groupCharactersRef.current, (current && current.name) || t('chat.session.defaultGroupName'));
              if (
                switchOperationRef.current !== transitionToken
                || activeCharacterIdRef.current !== previousCharacterId
                || (
                  activeSessionIdRef.current !== previousSessionId
                  && activeSessionIdRef.current !== created.id
                )
              ) return;
              activeSessionIdRef.current = created.id;
              await refreshSessions();
              if (
                switchOperationRef.current !== transitionToken
                || activeCharacterIdRef.current !== previousCharacterId
                || activeSessionIdRef.current !== created.id
              ) return;
              errorRawRef.current = {};
              sessionVersionRef.current += 1;
              setMessages([]);
              setAttachments([]);
              setQuoteTarget(null);
              setSearchOpen(false);
              setSearchQuery('');
              setActiveMatchIndex(0);
              setFocusedMessageId('');
              setSelectionText('');
            } catch (error) {
              if (
                switchOperationRef.current !== transitionToken
                || activeCharacterIdRef.current !== previousCharacterId
                || (
                  activeSessionIdRef.current !== previousSessionId
                  && activeSessionIdRef.current !== ''
                )
              ) return;
              Alert.alert(t('chat.session.newChatFailed.title'), t('chat.session.newChatFailed.body'));
            } finally {
              if (switchOperationRef.current === transitionToken) setIsSwitching(false);
            }
          },
        },
      ]);
      return;
    }
    openGreetingPicker('new');
  }, [isSending, isSwitching, openGreetingPicker, ready, refreshSessions, sessionOwnerMissing, sessionTransitionPending, t]);

  return {
    switcherOpen,
    setSwitcherOpen,
    onSwitch,
    onSwitchGroup,
    confirmGreeting,
    onNewChat,
  };
}
