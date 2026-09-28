// 语音播报（TTS）设置与播报回调。2026-09-27 从 ChatScreen 抽出（无行为变化）。
//
// 完全自包含：只依赖 storage / tts / speechText 与自身 state/ref，不触碰会话竞态守卫。
// 手动播报不受「自动播报」开关限制；关闭自动播报只停「自动」触发的那次。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { maskSecrets } from '../secrets';
import { toSpeechText } from '../speechText';
import { saveTtsSettings } from '../storage';
import { speak as ttsSpeak, stop as ttsStop } from '../tts';
import { getTtsProvider } from '../tts/providers';

export default function useChatTts() {
  const [ttsSettings, setTtsSettings] = useState({ autoBroadcast: false, activeProvider: 'system', providers: {} });
  const ttsRef = useRef({ autoBroadcast: false, activeProvider: 'system', providers: {} });
  // 当前播报是「自动」还是「手动」触发：关闭自动播报只停自动那次，不打断手动播报。
  const playbackSourceRef = useRef(null);

  useEffect(() => {
    ttsRef.current = ttsSettings;
  }, [ttsSettings]);

  const toggleBroadcast = useCallback(async () => {
    const previous = ttsRef.current;
    const next = { ...previous, autoBroadcast: previous.autoBroadcast !== true };
    setTtsSettings(next);
    ttsRef.current = next;
    // 关闭自动播报：只停掉「自动触发」的那次播报，不打断用户手动点的播报。
    if (!next.autoBroadcast && playbackSourceRef.current === 'auto') {
      ttsStop().catch(() => {});
    }
    try {
      await saveTtsSettings(next);
    } catch (error) {
      if (ttsRef.current === next) {
        ttsRef.current = previous;
        setTtsSettings(previous);
      }
      Alert.alert('保存失败', '请检查存储空间或权限。');
    }
  }, []);

  // 手动播报：点消息下方的「播报」始终可用，不受顶部自动播报开关限制。
  const broadcastMessage = useCallback(async (text, source = 'manual') => {
    const settings = ttsRef.current || {};
    const content = toSpeechText(text);
    if (!content) return;
    const provider = getTtsProvider(settings.activeProvider);
    const config = (settings.providers && settings.providers[provider.id]) || {};
    playbackSourceRef.current = source;
    try {
      await ttsSpeak({ provider, config, text: content });
    } catch (error) {
      Alert.alert('播报失败', maskSecrets((error && error.message) || '请稍后重试。'));
    }
  }, []);

  // 自动播报：仅当自动播报开关开启时才在回复完成后朗读。
  const autoBroadcastMessage = useCallback(async text => {
    const settings = ttsRef.current;
    if (!settings || settings.autoBroadcast !== true) return;
    return broadcastMessage(text, 'auto');
  }, [broadcastMessage]);

  return {
    ttsSettings,
    setTtsSettings,
    toggleBroadcast,
    broadcastMessage,
    autoBroadcastMessage,
  };
}
