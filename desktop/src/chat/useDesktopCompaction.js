// 手动压缩当前会话（桌面）：走共享层的四档管线，与 Android 的「压缩当前会话」同一实现。
//
// 与 Android 的差别只有一处：桌面没有工作区，压缩前钩子（hooks.json）与工具结果落盘
// 没有后端可接——resolveCompactionFocus 读不到 store 时自行降级为「无钩子、无落盘」，
// 管线里的 L1/L2/L3 相应空转，不会出现「假装修剪了」。
// 失败一律保持会话原样（压缩是增值操作，不能成为会话损坏的来源）。
import { useCallback, useRef, useState } from 'react';

import { COMPACTION_MIN_MESSAGES } from '../../../src/chat/compaction.js';
import {
  countCompactionMessages,
  resolveCompactionFocus,
  runSessionCompaction,
} from '../../../src/chat/sessionCompaction.js';
import { getCharacterApiConfigs } from '../../../src/character/runtimeConfig.js';
import { EMPTY_REPLY_TEXT, getConfigFingerprint, sendChatMessage } from '../../../src/network/api.js';
import { maskSecrets } from '../../../src/storage/secrets.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { Alert } from '../platform/alert.js';

export default function useDesktopCompaction({ setMessages, messagesRef, characterId, usage }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const usageRef = useRef(usage);
  usageRef.current = usage;

  const compact = useCallback(async ({ focus = '' } = {}) => {
    // 防重入：检查 + 占位在任何 await 之前成对完成（与 Android 同一条纪律）。
    if (busyRef.current) {
      Alert.alert(tRef.current('chat.compact.busy.title'), tRef.current('chat.compact.busy.body'));
      return { ok: false, reason: 'busy' };
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const list = Array.isArray(messagesRef.current) ? messagesRef.current : [];
      const meaningful = countCompactionMessages(list);
      if (meaningful < COMPACTION_MIN_MESSAGES) {
        Alert.alert(tRef.current('chat.settings.compactTitle'), tRef.current('chat.settings.compactTooShort'));
        return { ok: false, reason: 'too-short' };
      }
      const resolved = await resolveCompactionFocus({ characterId, focus });
      if (resolved.blocked.length > 0) {
        Alert.alert(tRef.current('chat.hooks.blocked.title'), resolved.blocked.join('\n'));
        return { ok: false, reason: 'hook-blocked' };
      }
      const { configs, activeId } = await getCharacterApiConfigs(characterId);
      const config = configs.find(item => item.id === activeId) || configs[0];
      if (!config) {
        Alert.alert(tRef.current('chat.settings.compactTitle'), tRef.current('chat.settings.compactFail'));
        return { ok: false, reason: 'no-config' };
      }
      const compacted = await runSessionCompaction({
        list,
        focus: resolved.focus,
        windowSize: Number(usageRef.current && usageRef.current.window) || 0,
        store: resolved.store || null,
        characterId,
        emptyReplyText: EMPTY_REPLY_TEXT,
        summarize: request => sendChatMessage(request, {
          stream: false,
          expectedConfigId: String(config.id || ''),
          expectedConfigFingerprint: getConfigFingerprint(config),
        }),
      });
      if (!compacted.ok) {
        Alert.alert(tRef.current('chat.settings.compactTitle'), tRef.current('chat.settings.compactFail'));
        return { ok: false, reason: compacted.reason };
      }
      // useSessionMessages 会把替换后的数组串行落盘。
      setMessages(compacted.messages);
      Alert.alert(tRef.current('chat.settings.compactTitle'), tRef.current('chat.settings.compactDone', {
        before: meaningful,
        after: compacted.messages.length,
        kept: Math.max(0, compacted.messages.length - 1),
      }));
      return { ok: true, before: meaningful, after: compacted.messages.length };
    } catch (error) {
      // 错误详情里可能带请求头：只写进控制台前先脱敏，界面只给通用文案。
      const detail = maskSecrets(String((error && error.message) || error));
      if (typeof console !== 'undefined' && console.warn) console.warn('[compact] failed', detail);
      Alert.alert(tRef.current('chat.settings.compactTitle'), tRef.current('chat.settings.compactFail'));
      return { ok: false, reason: 'failed' };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [characterId, messagesRef, setMessages]);

  return { compact, compactBusy: busy };
}