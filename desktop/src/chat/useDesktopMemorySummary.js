// 记忆总结（桌面）：手动总结当前会话，写入角色世界书或本会话上下文。
//
// 桌面此前把 maybeAutoSummarize 做成 no-op，而且没有手动入口 —— 结果是共享层
// 里整套记忆系统在桌面上**空转**：向量索引照建（若启用），但世界书里永远是空的。
// 手机版「⋯ → 总结」是显式动作，自动总结则由 useChatSend 的回调触发。
//
// 判定与落库全部复用共享层 memorySummary：
//   · selectManualSummarizable / selectSummarizable —— 该总结哪些消息；
//   · isSessionScopedMemory —— 写世界书还是写本会话（内置助手一律会话级）；
//   · resolveSummaryRequestConfig —— 用哪个接口（记忆设置里可单独指定）；
//   · applySummary —— 真正生成并落库（含修订号校验，会话被重置时拒绝写入）。
// 本 hook 只负责「桌面侧的状态与提示」，不重写任何一条判定。
import { useCallback, useRef, useState } from 'react';

import {
  applySummary,
  isBuiltinAssistant,
  isSessionScopedMemory,
  resolveSummaryRequestConfig,
  selectManualSummarizable,
  selectSummarizable,
  shouldSummarize,
} from '../../../src/memory/memorySummary.js';
import { getMemorySummarySettings } from '../../../src/storage/settings.js';
import { getVectorMemoryConfig } from '../../../src/storage/vector.js';
import { getApiConfigs, capabilitiesForModel, getActiveModel } from '../../../src/storage/apiConfigs.js';
import { computeContextUsage, resolveContextWindow } from '../../../src/chat/contextUsage.js';
import { getUserProfile } from '../../../src/storage/personas.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';

export default function useDesktopMemorySummary({
  charactersRef,
  sessionsRef,
  character,
  messagesRef,
  activeSessionId,
  updateCharacter,
  refreshSessions,
}) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  // 自动总结是异步回调（由共享层在回复落盘后触发），它需要「此刻的会话 id」，
  // 而闭包里的 activeSessionId 可能是触发那一刻的旧值。
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const [summarizing, setSummarizing] = useState(false);
  const summarizingRef = useRef(false);

  const summarize = useCallback(async ({ session, list, manual = true } = {}) => {
    if (summarizingRef.current) return { ok: false, reason: 'busy' };
    const currentSession = session
      || (Array.isArray(sessionsRef.current) ? sessionsRef.current : [])
        .find(item => item && item.id === activeSessionId);
    if (!currentSession) {
      if (manual) Alert.alert(tRef.current('chat.summary.unavailable.title'), tRef.current('chat.summary.noSession'));
      return { ok: false, reason: 'no-session' };
    }
    if (currentSession.type === 'group') {
      // 与手机同口径：群聊的上下文是多人拼起来的，总结进单角色世界书会写错归属。
      Alert.alert(tRef.current('chat.summary.groupUnsupported.title'), tRef.current('chat.summary.groupUnsupported.body'));
      return { ok: false, reason: 'group' };
    }
    const source = Array.isArray(list) ? list : (messagesRef.current || []);
    const picked = selectManualSummarizable(source, currentSession.summarizedUpTo);
    if (picked.length === 0) {
      if (manual) Alert.alert(tRef.current('chat.summary.unavailable.title'), tRef.current('chat.summary.unavailable.none'));
      return { ok: false, reason: 'empty' };
    }

    summarizingRef.current = true;
    setSummarizing(true);
    try {
      const userProfile = await getUserProfile().catch(() => ({ userName: '' }));
      const sessionCharacterId = String(currentSession.characterId || (character && character.id) || '');
      const latestCharacters = Array.isArray(charactersRef.current) ? charactersRef.current : [];
      const sessionCharacter = latestCharacters.find(item => item.id === sessionCharacterId)
        || (character && character.id === sessionCharacterId ? character : null)
        || { id: sessionCharacterId };
      const characterExists = latestCharacters.some(item => item.id === sessionCharacterId);
      // 自动总结在启用向量记忆后降级为会话级（跨会话召回交给向量）；
      // 手动总结是用户显式操作，按原有作用域判定，允许写入世界书。
      let vectorEnabled = false;
      try {
        const vectorConfig = await getVectorMemoryConfig();
        vectorEnabled = vectorConfig && vectorConfig.enabled === true;
      } catch (error) {}
      const scopeOverride = !manual && vectorEnabled;
      // 内置助手一律会话级：它的卡没有「角色记忆」语义，且可能已被兜底归属污染。
      const resolveScoped = (list2, latestCharacter, exists) => (
        isBuiltinAssistant(latestCharacter)
        || !exists
        || isSessionScopedMemory(list2, sessionCharacterId, scopeOverride, currentSession.id)
      );
      const scoped = resolveScoped(sessionsRef.current, sessionCharacter, characterExists);
      const memorySettings = await getMemorySummarySettings().catch(() => null);
      const summaryConfig = await resolveSummaryRequestConfig(memorySettings && memorySettings.configId);
      const result = await applySummary({
        session: currentSession,
        character: sessionCharacter,
        messages: picked,
        updateCharacter,
        userName: String((userProfile && userProfile.userName) || ''),
        scoped,
        focus: '',
        maxEntries: memorySettings && memorySettings.maxEntries,
        expectedConfigId: summaryConfig.id,
        expectedConfigFingerprint: summaryConfig.fingerprint,
        // 写库前复核：用户可能在生成期间切了会话/改了角色归属。
        getCurrentCharacter: () => (
          (Array.isArray(charactersRef.current) ? charactersRef.current : [])
            .find(item => item.id === sessionCharacterId) || sessionCharacter
        ),
        getCurrentScope: () => {
          const latest = Array.isArray(charactersRef.current) ? charactersRef.current : [];
          const latestCharacter = latest.find(item => item.id === sessionCharacterId) || sessionCharacter;
          return resolveScoped(sessionsRef.current, latestCharacter, latest.some(item => item.id === sessionCharacterId));
        },
      });
      await Promise.resolve(refreshSessions()).catch(() => {});
      if (result.skipped) {
        if (manual) Alert.alert(tRef.current('chat.summary.done.title'), tRef.current('chat.summary.done.empty'));
        return { ok: true, skipped: true };
      }
      if (manual) {
        Alert.alert(
          tRef.current('chat.summary.saved.title'),
          result.scoped
            ? tRef.current('chat.summary.saved.scoped')
            : tRef.current('chat.summary.saved.worldbook')
        );
      }
      return { ok: true, scoped: result.scoped };
    } catch (error) {
      // 静默放弃（作用域改变等）不是故障，不该弹错误。
      if (!error || error.canceled !== true) {
        if (manual) Alert.alert(tRef.current('chat.summary.fail.title'), tRef.current('common.error.retryLater'));
      }
      return { ok: false, reason: 'failed' };
    } finally {
      summarizingRef.current = false;
      setSummarizing(false);
    }
  }, [activeSessionId, character, charactersRef, messagesRef, refreshSessions, sessionsRef, updateCharacter]);

  // 自动总结：与手机 maybeAutoSummarize 同一条判定链（shouldSummarize 看开关+阈值+
  // 上下文占用；selectSummarizable 决定该总结到哪一条）。共享层 useChatSend 在回复
  // 落盘后会调用它，桌面此前传的是 no-op —— 于是记忆系统在桌面上永远不触发。
  //
  // attemptRef 的用途：同一条会话、同一组候选只尝试一次，否则每次发送都会重试
  // 同一次注定失败的总结（例如接口没配好），把 API 额度白烧掉。
  const attemptRef = useRef({ sessionId: '', signature: '' });
  const autoSummarize = useCallback(async list => {
    if (summarizingRef.current) return;
    const session = (Array.isArray(sessionsRef.current) ? sessionsRef.current : [])
      .find(item => item && item.id === activeSessionIdRef.current);
    if (!session || session.type === 'group') return;
    let settings = null;
    try {
      settings = await getMemorySummarySettings();
    } catch (error) {
      return;
    }
    const source = Array.isArray(list) ? list : (messagesRef.current || []);
    if (!shouldSummarize({ session, messages: source, settings })) return;
    // 上下文占用（估算）：到比例线后 shouldSummarize 才会返回 true（见 memorySummary）。
    let contextUsage = null;
    try {
      const { configs, activeId } = await getApiConfigs();
      const current = configs.find(item => item.id === activeId) || configs[0];
      const model = current ? getActiveModel(current) : '';
      const caps = capabilitiesForModel(current, model);
      contextUsage = computeContextUsage(source, resolveContextWindow({
        declared: caps.contextWindow,
        localContextSize: 0, // 桌面无本地模型
        model,
      }));
    } catch (error) {}
    if (!shouldSummarize({ session, messages: source, settings, contextUsage })) return;
    const candidates = selectSummarizable(source, session.summarizedUpTo);
    const signature = `${session.id}:${settings.enabled}:${settings.threshold}:${candidates.map(item => item.id).join('|')}`;
    if (attemptRef.current.sessionId === session.id && attemptRef.current.signature === signature) return;
    attemptRef.current = { sessionId: session.id, signature };
    await summarize({ session, list: source, manual: false });
  }, [messagesRef, sessionsRef, summarize]);

  return { summarize, autoSummarize, summarizing };
}