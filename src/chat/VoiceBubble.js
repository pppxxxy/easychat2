// 语音消息气泡：显示时长与播放/暂停控件，播放本机音频文件。
// 播放走 expo-audio 的 createAudioPlayer（与 TTS 播放同一依赖；不再用已弃用的 expo-av）。
// 文件缺失/损坏时给出「语音不可用」提示，不阻断聊天（需求 2.5、C4）。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { formatVoiceDuration } from './voiceMessages.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useTranslation } from '../i18n/I18nContext.js';
import { getAudioModule } from './audioModules.js';

export default function VoiceBubble({ message, isUser }) {
  const { theme, fonts, tokens } = useTheme();
  const { t } = useTranslation();
  const styles = React.useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const audio = (message && message.audio) || {};
  const uri = String(audio.uri || '');
  const [state, setState] = useState('idle'); // idle | loading | playing | error
  const playerRef = useRef(null);
  const subscriptionRef = useRef(null);

  const cleanup = useCallback(() => {
    if (subscriptionRef.current) {
      try {
        subscriptionRef.current.remove();
      } catch (error) {}
      subscriptionRef.current = null;
    }
    if (playerRef.current) {
      try {
        playerRef.current.pause();
      } catch (error) {}
      try {
        playerRef.current.remove();
      } catch (error) {}
      playerRef.current = null;
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const stop = useCallback(() => {
    cleanup();
    setState('idle');
  }, [cleanup]);

  const play = useCallback(() => {
    if (state === 'playing') {
      stop();
      return;
    }
    if (!uri) {
      setState('error');
      return;
    }
    const audioLib = getAudioModule();
    if (!audioLib || typeof audioLib.createAudioPlayer !== 'function') {
      setState('error');
      return;
    }
    cleanup();
    setState('loading');
    try {
      const player = audioLib.createAudioPlayer({ uri });
      playerRef.current = player;
      subscriptionRef.current = player.addListener('playbackStatusUpdate', status => {
        if (!status) return;
        if (status.didJustFinish) {
          stop();
        } else if (status.isLoaded === false && status.error) {
          // 加载失败也要释放播放器与状态订阅：气泡会一直挂在列表里，
          // 不清理会把失败的 player 长期占住，直到组件卸载。
          cleanup();
          setState('error');
        }
      });
      player.play();
      setState('playing');
    } catch (error) {
      cleanup();
      setState('error');
    }
  }, [uri, state, cleanup, stop]);

  if (state === 'error') {
    return (
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        <Ionicons name="alert-circle-outline" size={16} color={theme.colors.textFaint} />
        <Text style={[styles.errorText, { color: theme.colors.textFaint }]}>{t('chat.voice.unavailable')}</Text>
      </View>
    );
  }

  return (
    <TouchableOpacity
      style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}
      onPress={play}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={state === 'playing' ? t('chat.voice.stopA11y') : t('chat.voice.playA11y')}
    >
      {state === 'loading' ? (
        <ActivityIndicator size="small" color={isUser ? theme.colors.primaryContrast : theme.colors.primarySoft} />
      ) : (
        <Ionicons
          name={state === 'playing' ? 'pause' : 'play'}
          size={18}
          color={isUser ? theme.colors.primaryContrast : theme.colors.primarySoft}
        />
      )}
      <View style={[styles.wave, { backgroundColor: isUser ? theme.colors.primaryContrast : theme.colors.primarySoft }]} />
      <Text style={[styles.duration, { color: isUser ? theme.colors.primaryContrast : theme.colors.primarySoft }]}>
        {formatVoiceDuration(audio.durationMs)}
      </Text>
    </TouchableOpacity>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    borderRadius: tokens.radius.md,
    minWidth: 96,
  },
  bubbleUser: { backgroundColor: theme.colors.primary },
  bubbleAssistant: { backgroundColor: theme.colors.surface },
  wave: { flex: 1, height: 2, borderRadius: 1, marginHorizontal: tokens.spacing.sm, opacity: 0.6 },
  duration: { fontSize: fonts.scaled(12), fontWeight: '700' },
  errorText: { fontSize: fonts.scaled(12), marginLeft: 6 },
});
