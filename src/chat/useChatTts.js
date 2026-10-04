// 语音播报（TTS）设置与播报回调。2026-09-27 从 ChatScreen 抽出（无行为变化）。
//
// 完全自包含：只依赖 storage / tts / speechText 与自身 state/ref，不触碰会话竞态守卫。
// 手动播报不受「自动播报」开关限制；关闭自动播报只停「自动」触发的那次。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

import { markMediaWrite } from '../storage/mediaProtection.js';
import { maskSecrets } from '../storage/secrets.js';
import { toSpeechText } from './speechText.js';
import { saveTtsSettings } from '../storage.js';
import { synthesize, speak as ttsSpeak, stop as ttsStop, isSystemProvider } from '../tts/index.js';
import { getTtsProvider } from '../tts/providers.js';

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

  // 角色语音形态（需求 5）：合成回复文本为语音文件并落盘，返回 { uri, mime }。
  // 系统引擎（expo-speech 无法产文件）、未配置地址、合成失败时返回 null，
  // 调用方静默降级为仅文字，不弹窗打断（需求 5.5）。
  const synthesizeVoice = useCallback(async (messageId, text) => {
    if (!messageId || !String(text || '').trim()) return null;
    const settings = ttsRef.current || {};
    const provider = getTtsProvider(settings.activeProvider);
    if (!provider || isSystemProvider(provider)) return null;
    const config = (settings.providers && settings.providers[provider.id]) || {};
    try {
      const result = await synthesize({ provider, config, text });
      if (!result || result.mode !== 'audio' || !result.base64) return null;
      const ext = String(result.mime || 'audio/mp3').includes('wav') ? 'wav' : 'mp3';
      const dir = `${FileSystem.documentDirectory}voice/`;
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const uri = `${dir}role-${messageId}.${ext}`;
      // 先登记保护再写盘：否则写盘与登记之间若并发回收会误删这个新文件。
      markMediaWrite(uri);
      await FileSystem.writeAsStringAsync(uri, result.base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return { uri, mime: result.mime || 'audio/mp3' };
    } catch (error) {
      return null;
    }
  }, []);

  return {
    ttsSettings,
    setTtsSettings,
    toggleBroadcast,
    broadcastMessage,
    autoBroadcastMessage,
    synthesizeVoice,
  };
}
