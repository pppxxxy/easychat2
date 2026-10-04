// 一起听歌面板：本地曲库 + 播放器 + 时间轴打点 + 角色陪伴评论。
// 评论只在面板内呈现、不进聊天会话（2026-10-03 用户裁决）；「接话」按钮把该角色
// 会话切到前台并把评论作为引用带入（ensureCharacterSession + pendingQuote）。
// 入口在「扩展 → 世界」分组（独立面板页，动态同款跳转模式）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Card, Chip, EmptyState, GhostButton, IconButton } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import { useApp } from '../context/AppContext.js';
import {
  DEFAULT_MUSIC_CLIP,
  MUSIC_CLIP_SAMPLE_RATES,
  MUSIC_CLIP_SECONDS,
  getMusicClipSettings,
  saveMusicClipSettings,
} from '../storage.js';
import * as FileSystem from 'expo-file-system/legacy';

import { useTranslation } from '../i18n/I18nContext.js';

import { deleteMusicCommentsForSongs } from './comments.js';
import { deleteMusicItems, getMusicItems, saveMusicDuration, saveMusicTriggers } from './library.js';
import { importMusicFromPicker } from './importMusic.js';
import { canAttachSongAudio, formatPlaybackPosition, MUSIC_DECODE_MAX_BYTES } from './commentPrompts.js';
import {
  collectTriggersToCross,
  isSeekJump,
  makeTriggerId,
  resolveFiredIdsAtPosition,
} from './triggers.js';
import { useMusicComments } from './useMusicComments.js';
import { useMusicPlayer } from './useMusicPlayer.js';
import AudioClipWebView from './AudioClipWebView.js';

function formatFileSize(size) {
  const bytes = Math.max(0, Math.floor(Number(size)) || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return bytes > 0 ? `${bytes}B` : '';
}

function MusicRow({ item, isCurrent, playing, onPress, onDelete, styles, theme, t }) {
  return (
    <View style={styles.row}>
      <TouchableOpacity style={styles.rowMain} onPress={onPress} activeOpacity={0.8}>
        <View style={[styles.rowIcon, isCurrent && styles.rowIconActive]}>
          <Ionicons
            name={isCurrent && playing ? 'pause' : 'play'}
            size={16}
            color={theme.colors.primaryContrast}
          />
        </View>
        <View style={styles.rowBody}>
          <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {[
              item.durationMs > 0 ? formatPlaybackPosition(item.durationMs) : '',
              formatFileSize(item.size),
              item.triggers.length > 0 ? t('music.list.meta.triggers', { count: item.triggers.length }) : '',
            ].filter(Boolean).join(' · ') || t('music.list.meta.audio')}
          </Text>
        </View>
      </TouchableOpacity>
      <IconButton
        name="trash-outline"
        accessibilityLabel={t('music.a11y.deleteSong', { name: item.name })}
        onPress={onDelete}
        style={styles.rowDelete}
      />
    </View>
  );
}

export default function MusicScreen() {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);
  const { t } = useTranslation();
  const navigation = useNavigation();
  const { characters, activeId, ensureCharacterSession, setPendingQuote } = useApp();

  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [currentId, setCurrentId] = useState('');
  const [clipSettings, setClipSettings] = useState(DEFAULT_MUSIC_CLIP);
  const { status, load, toggle, seekToSeconds, stop } = useMusicPlayer();

  // 隐藏 WebView 裁剪器：把歌曲裁成短片段再送模型。
  const clipRef = useRef(null);
  const clipAudio = useCallback(args => (
    clipRef.current && clipRef.current.clip
      ? clipRef.current.clip(args)
      : Promise.reject(new Error('clip-unavailable'))
  ), []);

  // 读取「音频片段」设置（时长/采样率）；改动即时保存。
  useEffect(() => {
    let cancelled = false;
    getMusicClipSettings()
      .then(settings => {
        if (!cancelled) setClipSettings(settings);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const updateClipSettings = useCallback(patch => {
    setClipSettings(previous => {
      const next = { ...previous, ...patch };
      saveMusicClipSettings(next).catch(() => {});
      return next;
    });
  }, []);

  const current = useMemo(
    () => items.find(item => item.id === currentId) || null,
    [items, currentId]
  );
  const {
    comments,
    generating,
    error: commentError,
    characterId,
    setCharacterId,
    generate,
    retry,
    audioSupported,
  } = useMusicComments({ song: current, characters, defaultCharacterId: activeId, clipAudio, clipSettings });

  const reload = useCallback(async () => {
    try {
      const list = await getMusicItems();
      setItems(list);
      setLoaded(true);
      setLoadFailed(false);
    } catch (error) {
      setLoaded(true);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // 时长回填：首播拿到真实时长后写回存储，曲库行从此显示长度。
  const durationDoneRef = useRef('');
  useEffect(() => {
    if (!current || status.durationMs <= 0 || durationDoneRef.current === current.id) return;
    durationDoneRef.current = current.id;
    if (current.durationMs > 0) return;
    saveMusicDuration(current.id, status.durationMs)
      .then(updated => {
        if (!updated) return;
        setItems(list => list.map(item => (item.id === updated.id ? updated : item)));
      })
      .catch(() => {});
  }, [current, status.durationMs]);

  // 开场评论：切到一首新歌时点一次（生成失败不影响播放）。
  const openingDoneRef = useRef('');
  const handlePlay = useCallback(item => {
    if (!item) return;
    if (item.id === currentId) {
      toggle();
      return;
    }
    setCurrentId(item.id);
    durationDoneRef.current = '';
    load(item);
    if (openingDoneRef.current !== item.id) {
      openingDoneRef.current = item.id;
      generate({ kind: 'opening' });
    }
  }, [currentId, generate, load, toggle]);

  // 时间轴触发：正常推进时越过打点即请求评论；seek（>2.5s 跳变）落定后按新位置
  // 重算已触发集合——回跳重播自动重新武装，已放过的历史不回放补触发。
  const firedRef = useRef(new Set());
  const firedSongRef = useRef('');
  const lastPositionRef = useRef(0);
  useEffect(() => {
    if (!current) {
      firedSongRef.current = '';
      lastPositionRef.current = 0;
      return;
    }
    if (firedSongRef.current !== current.id) {
      firedSongRef.current = current.id;
      firedRef.current = new Set();
      lastPositionRef.current = status.positionMs;
      return;
    }
    const previousMs = lastPositionRef.current;
    const positionMs = status.positionMs;
    if (positionMs === previousMs) return;
    lastPositionRef.current = positionMs;
    if (isSeekJump(previousMs, positionMs)) {
      firedRef.current = resolveFiredIdsAtPosition(current.triggers, positionMs);
      return;
    }
    collectTriggersToCross(current.triggers, previousMs, positionMs).forEach(trigger => {
      if (firedRef.current.has(trigger.id)) return;
      firedRef.current.add(trigger.id);
      generate({ kind: 'trigger', atMs: trigger.atMs, note: trigger.note });
    });
  }, [current, status.positionMs, generate]);

  const handleImport = useCallback(async () => {
    if (importing) return;
    setImporting(true);
    try {
      const { item } = await importMusicFromPicker();
      if (!item) return;
      setItems(list => [item, ...list.filter(entry => entry.id !== item.id)]);
      setCurrentId(item.id);
      durationDoneRef.current = '';
      load(item);
    } catch (error) {
      if (error && error.code === 'UNSUPPORTED_FORMAT') {
        Alert.alert(t('music.import.unsupported.title'), t('music.import.unsupported.body'));
      } else {
        Alert.alert(t('music.import.failed.title'), t('music.import.failed.body'));
      }
    } finally {
      setImporting(false);
    }
  }, [importing, load]);

  const seekBySeconds = useCallback(delta => {
    if (!current) return;
    const baseMs = status.durationMs > 0 ? Math.min(status.positionMs, status.durationMs) : status.positionMs;
    seekToSeconds((baseMs + delta * 1000) / 1000);
  }, [current, seekToSeconds, status.durationMs, status.positionMs]);

  const seekFraction = useCallback(fraction => {
    if (!current || status.durationMs <= 0) return;
    const bounded = Math.min(1, Math.max(0, Number(fraction) || 0));
    seekToSeconds((status.durationMs * bounded) / 1000);
  }, [current, seekToSeconds, status.durationMs]);

  const persistTriggers = useCallback(async (songId, triggers) => {
    try {
      const updated = await saveMusicTriggers(songId, triggers);
      setItems(list => list.map(item => (item.id === updated.id ? updated : item)));
      // 打点列表变了：按当前进度重算已触发集合，避免沿用旧的 fired 集合漏触发。
      firedRef.current = resolveFiredIdsAtPosition(updated.triggers, status.positionMs);
      return updated;
    } catch (error) {
      Alert.alert(t('music.save.failed.title'), t('music.save.failed.body'));
      return null;
    }
  }, [status.positionMs]);

  const addTriggerHere = useCallback(() => {
    if (!current) return;
    const atMs = status.positionMs;
    const next = [
      ...current.triggers.filter(item => item.atMs !== atMs),
      { id: makeTriggerId(), atMs, note: '' },
    ];
    persistTriggers(current.id, next);
  }, [current, persistTriggers, status.positionMs]);

  const removeTrigger = useCallback(triggerId => {
    if (!current) return;
    persistTriggers(current.id, current.triggers.filter(item => item.id !== triggerId));
  }, [current, persistTriggers]);

  const handleDelete = useCallback(item => {
    if (!item) return;
    Alert.alert(
      t('music.delete.title'),
      t('music.delete.body', { name: item.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            if (item.id === currentId) {
              stop();
              setCurrentId('');
            }
            setItems(list => list.filter(entry => entry.id !== item.id));
            deleteMusicItems([item.id]).catch(() => {});
            deleteMusicCommentsForSongs([item.id]).catch(() => {});
            FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => {});
          },
        },
      ]
    );
  }, [currentId, stop]);

  // 接话：切到该角色当前会话并把评论作为引用带入输入区（不落库、不进会话存储）。
  const handleQuoteComment = useCallback(async comment => {
    if (!comment || !comment.characterId) return;
    try {
      const session = await ensureCharacterSession(comment.characterId);
      if (!session || !session.id) throw new Error('no-session');
      setPendingQuote({
        sessionId: session.id,
        payload: {
          id: '',
          name: comment.characterName || t('common.characterFallback'),
          role: 'assistant',
          text: comment.text,
        },
      });
      navigation.navigate('聊天');
    } catch (error) {
      Alert.alert(t('music.comments.quoteFailed.title'), t('music.comments.quoteFailed.body'));
    }
  }, [ensureCharacterSession, navigation, setPendingQuote]);

  const progress = status.durationMs > 0 ? Math.min(1, status.positionMs / status.durationMs) : 0;
  const trackWidthRef = useRef(0);
  const selectedCharacter = useMemo(
    () => characters.find(item => item.id === characterId) || null,
    [characterId, characters]
  );

  if (!loaded) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  if (loadFailed) {
    return (
      <EmptyState
        icon="alert-circle-outline"
        title={t('music.load.failed.title')}
        description={t('music.load.failed.body')}
        action={<GhostButton title={t('common.retry')} onPress={reload} />}
      />
    );
  }

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={styles.listContent}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{t('music.title')}</Text>
        <TouchableOpacity
          style={styles.importButton}
          onPress={handleImport}
          disabled={importing}
          activeOpacity={0.85}
        >
          {importing
            ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
            : <Ionicons name="add" size={16} color={theme.colors.primaryContrast} />}
          <Text style={styles.importText}>{t('music.import')}</Text>
        </TouchableOpacity>
      </View>

      {current ? (
        <Card style={styles.playerCard}>
          <Text style={styles.playerTitle} numberOfLines={1}>{current.name}</Text>
          <Text style={styles.playerTime}>
            {formatPlaybackPosition(status.positionMs)} / {status.durationMs > 0 ? formatPlaybackPosition(status.durationMs) : '--:--'}
          </Text>
          <View
            style={styles.progressTrack}
            onLayout={event => { trackWidthRef.current = event.nativeEvent.layout.width; }}
          >
            <TouchableOpacity
              style={StyleSheet.absoluteFill}
              onPress={event => {
                const width = trackWidthRef.current;
                if (width > 0) seekFraction(event.nativeEvent.locationX / width);
              }}
              accessibilityLabel={t('music.a11y.progressBar')}
            >
              <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
            </TouchableOpacity>
          </View>
          <View style={styles.controlsRow}>
            <TouchableOpacity style={styles.controlButton} onPress={() => seekBySeconds(-15)} accessibilityLabel={t('music.a11y.back15')}>
              <Ionicons name="play-back" size={20} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.controlButton, styles.playButton]}
              onPress={toggle}
              accessibilityLabel={status.playing ? t('music.a11y.pause') : t('music.a11y.play')}
            >
              <Ionicons name={status.playing ? 'pause' : 'play'} size={22} color={theme.colors.primaryContrast} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.controlButton} onPress={() => seekBySeconds(15)} accessibilityLabel={t('music.a11y.forward15')}>
              <Ionicons name="play-forward" size={20} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.markButton} onPress={addTriggerHere} accessibilityLabel={t('music.a11y.markHere')}>
              <Ionicons name="bookmark" size={14} color={theme.colors.primaryContrast} />
              <Text style={styles.markText}>{t('music.player.mark')}</Text>
            </TouchableOpacity>
          </View>
          {current.triggers.length > 0 ? (
            <View style={styles.triggerBlock}>
              <Text style={styles.triggerTitle}>{t('music.triggers.hint')}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.triggerScroll}>
                {current.triggers.map(trigger => (
                  <View key={trigger.id} style={styles.triggerChip}>
                    <TouchableOpacity
                      onPress={() => seekToSeconds(trigger.atMs / 1000)}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.triggerTime}>{formatPlaybackPosition(trigger.atMs)}</Text>
                      {trigger.note ? <Text style={styles.triggerNote} numberOfLines={1}>{trigger.note}</Text> : null}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.triggerRemove}
                      onPress={() => removeTrigger(trigger.id)}
                      accessibilityLabel={t('music.a11y.deleteTrigger', { time: formatPlaybackPosition(trigger.atMs) })}
                    >
                      <Ionicons name="close" size={12} color={theme.colors.textFaint} />
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            </View>
          ) : null}
        </Card>
      ) : null}

      {current ? (
        <Card style={styles.commentsCard}>
          <View style={styles.commentsHeader}>
            <Text style={styles.commentsTitle}>{t('music.comments.title')}</Text>
            {generating ? <ActivityIndicator size="small" color={theme.colors.primary} /> : null}
          </View>
          {audioSupported === false ? (
            <View style={styles.noAudioHint}>
              <Ionicons name="volume-mute-outline" size={14} color={theme.colors.textFaint} />
              <Text style={styles.noAudioHintText}>{t('music.comments.noAudio')}</Text>
            </View>
          ) : (audioSupported === true && current && !canAttachSongAudio(current, MUSIC_DECODE_MAX_BYTES)) ? (
            <View style={styles.noAudioHint}>
              <Ionicons name="volume-mute-outline" size={14} color={theme.colors.textFaint} />
              <Text style={styles.noAudioHintText}>{t('music.comments.audioTooLarge')}</Text>
            </View>
          ) : null}
          {audioSupported === true ? (
            <View style={styles.clipSettings}>
              <Text style={styles.clipSettingsLabel}>{t('music.clip.duration')}</Text>
              <View style={styles.clipChips}>
                {MUSIC_CLIP_SECONDS.map(item => (
                  <Chip
                    key={item}
                    label={t('music.clip.seconds', { count: item })}
                    active={clipSettings.clipSeconds === item}
                    onPress={() => updateClipSettings({ clipSeconds: item })}
                  />
                ))}
              </View>
              <Text style={styles.clipSettingsLabel}>{t('music.clip.sampleRate')}</Text>
              <View style={styles.clipChips}>
                {MUSIC_CLIP_SAMPLE_RATES.map(item => (
                  <Chip
                    key={item}
                    label={t('music.clip.khz', { rate: item / 1000 })}
                    active={clipSettings.sampleRate === item}
                    onPress={() => updateClipSettings({ sampleRate: item })}
                  />
                ))}
              </View>
            </View>
          ) : null}
          <Text style={styles.triggerTitle}>{t('music.comments.characterLabel')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.triggerScroll}>
            {characters.map(item => {
              const selected = item.id === characterId;
              return (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.characterChip, selected && styles.characterChipActive]}
                  onPress={() => setCharacterId(item.id)}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[styles.characterChipText, selected && styles.characterChipTextActive]}
                    numberOfLines={1}
                  >
                    {String(item.name || '').trim() || t('common.characterFallback')}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          {commentError ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{commentError}</Text>
              <GhostButton title={t('common.retry')} small onPress={retry} />
            </View>
          ) : null}
          {!selectedCharacter ? (
            <Text style={styles.emptyComments}>{t('music.comments.empty.noCharacter')}</Text>
          ) : comments.length === 0 && !generating ? (
            <Text style={styles.emptyComments}>
              {t('music.comments.empty', {
                character: String(selectedCharacter.name || '').trim() || t('common.characterFallback'),
              })}
            </Text>
          ) : null}
          {comments.map(comment => (
            <View key={comment.id} style={styles.commentCard}>
              <View style={styles.commentHead}>
                <Text style={styles.commentName} numberOfLines={1}>
                  {comment.characterName || t('common.characterFallback')} · {formatPlaybackPosition(comment.atMs)}
                </Text>
                <TouchableOpacity
                  style={styles.quoteButton}
                  onPress={() => handleQuoteComment(comment)}
                  activeOpacity={0.85}
                >
                  <Text style={styles.quoteButtonText}>{t('music.comments.quote')}</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.commentText}>{comment.text}</Text>
            </View>
          ))}
        </Card>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          icon="musical-notes-outline"
          title={t('music.empty.title')}
          description={t('music.empty.body')}
        />
      ) : items.map(item => (
        <MusicRow
          key={item.id}
          item={item}
          isCurrent={item.id === currentId}
          playing={status.playing}
          onPress={() => handlePlay(item)}
          onDelete={() => handleDelete(item)}
          styles={styles}
          theme={theme}
          t={t}
        />
      ))}
    </ScrollView>
      <AudioClipWebView ref={clipRef} />
    </>
  );
}

const createStyles = (theme, fonts, tokens) => StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 10,
  },
  headerTitle: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '700' },
  importButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.primary,
    borderRadius: tokens.metrics.buttonRadius,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  importText: { color: theme.colors.primaryContrast, fontSize: fonts.scaled(13), fontWeight: '600', marginLeft: 4 },
  playerCard: { marginBottom: tokens.metrics.cardGap },
  commentsCard: { marginBottom: tokens.metrics.cardGap },
  playerTitle: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '700' },
  playerTime: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginTop: 4 },
  progressTrack: {
    height: 24,
    borderRadius: 4,
    marginTop: 12,
    overflow: 'hidden',
  },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: theme.colors.primary, marginTop: 8 },
  controlsRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  controlButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceBorder,
    marginRight: 10,
  },
  playButton: { backgroundColor: theme.colors.primary },
  markButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
    borderRadius: tokens.metrics.buttonRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  markText: { color: theme.colors.primary, fontSize: fonts.scaled(12), fontWeight: '600', marginLeft: 4 },
  triggerBlock: { marginTop: 12 },
  commentsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
  commentsTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700' },
  triggerTitle: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginBottom: 6 },
  triggerScroll: { flexGrow: 0, marginBottom: 6 },
  triggerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceBorder,
    borderRadius: tokens.radius.sm,
    paddingLeft: 8,
    paddingRight: 4,
    paddingVertical: 5,
    marginRight: 8,
  },
  triggerTime: { color: theme.colors.text, fontSize: fonts.scaled(12), fontWeight: '600' },
  triggerNote: { color: theme.colors.textFaint, fontSize: fonts.scaled(10), maxWidth: 90 },
  triggerRemove: { paddingHorizontal: 4, paddingVertical: 2 },
  characterChip: {
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
  },
  characterChipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  characterChipText: { color: theme.colors.text, fontSize: fonts.scaled(12), maxWidth: 120 },
  characterChipTextActive: { color: theme.colors.primaryContrast, fontWeight: '600' },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: tokens.radius.sm,
    backgroundColor: theme.colors.surfaceBorder,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 8,
  },
  errorText: { color: theme.colors.danger || theme.colors.text, fontSize: fonts.scaled(12), flex: 1, marginRight: 8 },
  noAudioHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  noAudioHintText: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), flex: 1, lineHeight: fonts.scaled(17) },
  clipSettings: { marginTop: 8 },
  clipSettingsLabel: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginBottom: 4 },
  clipChips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  emptyComments: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), marginTop: 8, lineHeight: fonts.scaled(17) },
  commentCard: {
    borderRadius: tokens.radius.sm,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    padding: 10,
    marginTop: 8,
  },
  commentHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  commentName: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), flex: 1, marginRight: 8 },
  quoteButton: {
    borderRadius: tokens.metrics.buttonRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  quoteButtonText: { color: theme.colors.primary, fontSize: fonts.scaled(11), fontWeight: '600' },
  commentText: { color: theme.colors.text, fontSize: fonts.scaled(13), lineHeight: fonts.scaled(19) },
  listContent: { paddingHorizontal: 20, paddingBottom: 30 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    borderRadius: tokens.metrics.cardRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    marginBottom: tokens.metrics.cardGap,
    ...tokens.elevation(1, theme),
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', padding: tokens.metrics.cardPadding },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  rowIconActive: { backgroundColor: theme.colors.text },
  rowBody: { flex: 1, marginRight: 8 },
  rowName: { color: theme.colors.text, fontSize: fonts.scaled(14), fontWeight: '600' },
  rowMeta: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginTop: 3 },
  rowDelete: { marginRight: 10 },
});
