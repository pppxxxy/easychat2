// 开场白编排（桌面）：候选、选择器状态、写回角色卡、建会话 —— 两个用途共用一套。
//
// 背景（真故障）：桌面「+」此前直接 startNewSession(characterId)，不带 opening，
// 于是新会话 greetingSelected=false；共享发送链路 useChatSend 的闸门
// `if (!isGroup && !greetingReady) return false;` 会让它**发不出任何消息**且不提示。
// 手机版没有这个问题，因为它先走「开场白选择器」，由 confirmGreeting 把
// firstMes 写回角色卡并以该开场白建会话（opening 非 null ⇒ greetingSelected=true）。
//
// 桌面单窗口，没有手机那种「切到别的会话中途」的多路竞争，所以不搬它的切换令牌；
// 只在写库前复核一次会话 id，避免用户在这期间切走了还往回写。
import { useCallback, useRef, useState } from 'react';

import { getUserProfile } from '../../../src/storage/personas.js';
import { setSessionGreetingSelected, startNewSession } from '../../../src/storage/sessionList.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';
import {
  applyGreetingToMessages,
  greetingMessageFor,
  greetingPickerState,
  greetingSelection,
  newSessionOpening,
} from './greetingView.js';

export default function useDesktopGreeting({
  character,
  messagesRef,
  activeSessionId,
  updateCharacter,
  setMessages,
  setGreetingReady,
  refreshSessions,
  onCreated,
}) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [flow, setFlow] = useState(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // 打开选择器。purpose: 'new'（建新会话）| 'reselect'（换当前会话的开场白）。
  const open = useCallback((purpose = 'new') => {
    if (busyRef.current) return;
    const state = greetingPickerState({
      character,
      messages: messagesRef.current,
      sessionId: activeSessionIdRef.current,
    });
    setFlow({ purpose, ...state });
  }, [character, messagesRef]);

  const cancel = useCallback(() => {
    if (busyRef.current) return;
    setFlow(null);
  }, []);

  const confirm = useCallback(async ({ drafts, selectedIndex }) => {
    if (!flow || busyRef.current) return false;
    const characterId = String((character && character.id) || '');
    busyRef.current = true;
    setBusy(true);
    // 用户名在落库前读一次：开场白里的 {{user}} 要换成真实用户名，
    // 否则模板占位符会原样显示在气泡里。
    let userName = '';
    try {
      const profile = await getUserProfile();
      userName = String((profile && profile.userName) || '').trim();
    } catch (error) {}
    const selection = greetingSelection(drafts, selectedIndex, {
      userName,
      fallbackUserName: tRef.current('chat.session.defaultUser'),
    });
    try {
      if (flow.purpose === 'new') {
        if (!characterId) return false;
        // 先写回角色卡：这条开场白从此是「之后新建对话的默认开场白」。
        await updateCharacter({
          id: characterId,
          firstMes: selection.patch.firstMes,
          alternateGreetings: selection.patch.alternateGreetings,
        });
        // 即使选「不使用开场白」也必须传 opening 对象 —— 它是 greetingSelected 的判据。
        const created = await startNewSession(characterId, newSessionOpening(selection));
        setGreetingReady(true);
        setFlow(null);
        await Promise.resolve(refreshSessions()).catch(() => {});
        if (created && created.id) {
          setMessages([]);
          if (typeof onCreated === 'function') await onCreated(created);
        }
        return true;
      }

      // reselect：只动当前会话的开场白消息，别的消息一条不碰。
      const sessionId = String(activeSessionIdRef.current || '');
      if (!sessionId) return false;
      await updateCharacter({
        id: characterId,
        firstMes: selection.patch.firstMes,
        alternateGreetings: selection.patch.alternateGreetings,
      });
      if (activeSessionIdRef.current !== sessionId) return false;
      // greetingSelected 与消息内容必须同时到位：只补消息不置位，下次冷启动读回来
      // 这条会话又会变成「未选开场白」而重新卡住发送。
      await setSessionGreetingSelected(sessionId, true);
      const greeting = greetingMessageFor(sessionId, selection.patch, {
        userName,
        fallbackUserName: tRef.current('chat.session.defaultUser'),
      });
      setMessages(current => applyGreetingToMessages(current, sessionId, greeting));
      setGreetingReady(true);
      setFlow(null);
      await Promise.resolve(refreshSessions()).catch(() => {});
      return true;
    } catch (error) {
      Alert.alert(
        tRef.current('chat.session.greetingSaveFailed.title'),
        tRef.current('chat.session.greetingSaveFailed.body')
      );
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [character, flow, onCreated, refreshSessions, setGreetingReady, setMessages, updateCharacter]);

  return {
    flow,
    busy,
    open,
    cancel,
    confirm,
    // 供界面直接渲染选择器：候选与初始下标都在 flow 里。
    pickerProps: flow
      ? {
        open: true,
        purpose: flow.purpose,
        candidates: flow.candidates,
        initialSelectedIndex: flow.initialSelectedIndex,
      }
      : { open: false, purpose: 'new', candidates: [], initialSelectedIndex: -1 },
  };
}