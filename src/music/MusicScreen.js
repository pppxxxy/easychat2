// 一起听歌面板：本地曲库 + 播放器 + 时间轴打点 + 角色陪伴评论。
// 评论只在面板内呈现、不进聊天会话（2026-10-03 用户裁决）；「接话」按钮把该角色
// 会话切到前台并把评论作为引用带入（ensureCharacterSession + pendingQuote）。
// 入口在「扩展 → 世界」分组（独立面板页，动态同款跳转模式）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROUTE_NAMES } from '../navigation/routeNames.js';
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

import {
  Card,
  Chip,
  CollectionNameModal,
  CollectionPickerModal,
  CollapsibleSection,
  CollapsibleSelect,
  EmptyState,
  GhostButton,
  IconButton,
} from '../ui/index.js';
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
import {
  PLAYLIST_NAME_MAX,
  createMusicPlaylist,
  deleteMusicPlaylist,
  getMusicPlaylists,
  purgeSongsFromPlaylists,
  renameMusicPlaylist,
  setSongInPlaylist,
} from './playlists.js';
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
import {
  formatMusicRate,
  getMusicPlayerSettings,
  nextMusicPlayMode,
  nextMusicRate,
  nextSequentialIndex,
  pickShuffleIndex,
  saveMusicPlayerSettings,
} from './playerSettings.js';

// 播放方式的图标与文案键（静态表：动态拼接的 key 无法被文案扫描静态提取）。
const PLAY_MODE_META = {
  stop: { icon: 'stop-circle-outline', labelKey: 'music.mode.stop' },
  repeatOne: { icon: 'repeat', labelKey: 'music.mode.repeatOne' },
  sequential: { icon: 'list-outline', labelKey: 'music.mode.sequential' },
  shuffle: { icon: 'shuffle', labelKey: 'music.mode.shuffle' },
};

// 跳跃步长（秒）：左右三角改成上一首 / 下一首之后，跳时间交给这两个按钮。
const SEEK_STEP_SECONDS = 15;
import AudioClipWebView from './AudioClipWebView.js';

function formatFileSize(size) {
  const bytes = Math.max(0, Math.floor(Number(size)) || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return bytes > 0 ? `${bytes}B` : '';
}

function MusicRow({ item, isCurrent, playing, onPress, onDelete, onMore, styles, theme, t }) {
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
        name="ellipsis-horizontal"
        accessibilityLabel={t('music.a11y.songMore', { name: item.name })}
        onPress={onMore}
        style={styles.rowMore}
      />
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
  // 歌单：列表 + 当前筛选（'' = 全部）+ 命名弹窗 + 「加入/移出歌单」选择器。
  const [playlists, setPlaylists] = useState([]);
  const [playlistFilter, setPlaylistFilter] = useState('');
  const [playlistPrompt, setPlaylistPrompt] = useState({
    visible: false,
    mode: 'create',
    playlistId: '',
    draft: '',
  });
  const [playlistSaving, setPlaylistSaving] = useState(false);
  const [playlistPickerSongId, setPlaylistPickerSongId] = useState('');
  const { status, load, toggle, seekToSeconds, setRate, stop } = useMusicPlayer();
  // 播放方式与倍速：全局持久化，打开时读一次、改动即写（失败不阻断播放）。
  const [playMode, setPlayMode] = useState('stop');
  const [rate, setRateState] = useState(1);

  useEffect(() => {
    let cancelled = false;
    getMusicPlayerSettings()
      .then(settings => {
        if (cancelled) return;
        setPlayMode(settings.playMode);
        setRateState(settings.rate);
        setRate(settings.rate);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [setRate]);

  const cyclePlayMode = useCallback(() => {
    setPlayMode(current => {
      const next = nextMusicPlayMode(current);
      saveMusicPlayerSettings({ playMode: next }).catch(() => {});
      return next;
    });
  }, []);

  const cycleRate = useCallback(() => {
    setRateState(current => {
      const next = nextMusicRate(current);
      setRate(next);
      saveMusicPlayerSettings({ rate: next }).catch(() => {});
      return next;
    });
  }, [setRate]);

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

  // ---- 歌单 ----

  const reloadPlaylists = useCallback(async () => {
    try {
      setPlaylists(await getMusicPlaylists());
    } catch (error) {
      // 歌单读取失败不阻断听歌：保持当前列表，避免把界面清空成「没有歌单」误导用户。
    }
  }, []);

  useEffect(() => {
    reloadPlaylists();
  }, [reloadPlaylists]);

  const activePlaylist = useMemo(
    () => playlists.find(item => item.id === playlistFilter) || null,
    [playlists, playlistFilter]
  );
  const visibleItems = useMemo(
    () => (activePlaylist
      ? items.filter(item => activePlaylist.songIds.includes(item.id))
      : items),
    [items, activePlaylist]
  );
  const playlistPickerSong = useMemo(
    () => items.find(item => item.id === playlistPickerSongId) || null,
    [items, playlistPickerSongId]
  );

  const openCreatePlaylist = useCallback(() => {
    setPlaylistPrompt({ visible: true, mode: 'create', playlistId: '', draft: '' });
  }, []);

  const openRenamePlaylist = useCallback(playlist => {
    if (!playlist) return;
    setPlaylistPrompt({
      visible: true,
      mode: 'rename',
      playlistId: playlist.id,
      draft: playlist.name,
    });
  }, []);

  const closePlaylistPrompt = useCallback(() => {
    if (playlistSaving) return;
    setPlaylistPrompt({ visible: false, mode: 'create', playlistId: '', draft: '' });
  }, [playlistSaving]);

  const confirmPlaylistName = useCallback(async () => {
    if (playlistSaving) return;
    const name = String(playlistPrompt.draft || '').trim();
    if (!name) {
      Alert.alert(t('music.playlists.title'), t('music.playlists.nameEmpty'));
      return;
    }
    const duplicated = playlists.some(item => (
      item.name === name
      && (playlistPrompt.mode === 'create' || item.id !== playlistPrompt.playlistId)
    ));
    if (duplicated) {
      Alert.alert(t('music.playlists.title'), t('music.playlists.duplicate'));
      return;
    }
    setPlaylistSaving(true);
    try {
      if (playlistPrompt.mode === 'rename') {
        await renameMusicPlaylist(playlistPrompt.playlistId, name);
      } else {
        await createMusicPlaylist(name);
      }
      await reloadPlaylists();
      setPlaylistPrompt({ visible: false, mode: 'create', playlistId: '', draft: '' });
    } catch (error) {
      Alert.alert(t('music.playlists.title'), t('music.playlists.saveFailed'));
    } finally {
      setPlaylistSaving(false);
    }
  }, [playlistPrompt, playlistSaving, playlists, reloadPlaylists, t]);

  const confirmDeletePlaylist = useCallback(playlist => {
    if (!playlist) return;
    Alert.alert(
      t('music.playlists.delete.title'),
      t('music.playlists.delete.body', { name: playlist.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            deleteMusicPlaylist(playlist.id)
              .then(() => {
                setPlaylistFilter(current => (current === playlist.id ? '' : current));
                return reloadPlaylists();
              })
              .catch(() => {
                Alert.alert(t('music.playlists.title'), t('music.playlists.saveFailed'));
              });
          },
        },
      ]
    );
  }, [reloadPlaylists, t]);

  // 在「加入/移出歌单」弹窗里勾选：只更新目标歌单，其余保持不动。
  const toggleSongInPlaylist = useCallback((playlist, included) => {
    const songId = playlistPickerSongId;
    if (!songId || !playlist) return;
    setSongInPlaylist(playlist.id, songId, included)
      .then(updated => {
        setPlaylists(list => list.map(item => (item.id === updated.id ? updated : item)));
      })
      .catch(() => {
        Alert.alert(t('music.playlists.title'), t('music.playlists.saveFailed'));
      });
  }, [playlistPickerSongId, t]);

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
  // 当前曲目在曲库里的下标（找不到时按 0：列表可能刚被删空又加回来）。
  const currentIndex = useMemo(() => {
    const list = Array.isArray(items) ? items : [];
    const index = list.findIndex(item => item.id === currentId);
    return index >= 0 ? index : 0;
  }, [currentId, items]);

  // 切歌统一入口：列表点播、上一首/下一首、播完自动续接都走它。
  // index 会环绕（-1 取末首，越界回到开头）。
  const playAt = useCallback(index => {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return;
    const bounded = ((Math.floor(Number(index)) || 0) % list.length + list.length) % list.length;
    const item = list[bounded];
    if (!item) return;
    setCurrentId(item.id);
    durationDoneRef.current = '';
    load(item);
    if (openingDoneRef.current !== item.id) {
      openingDoneRef.current = item.id;
      generate({ kind: 'opening' });
    }
  }, [generate, items, load]);

  const handleNextTrack = useCallback(() => {
    playAt(nextSequentialIndex(items.length, currentIndex));
  }, [currentIndex, items.length, playAt]);

  const handlePrevTrack = useCallback(() => {
    playAt(currentIndex - 1);
  }, [currentIndex, playAt]);

  const handlePlay = useCallback(item => {
    if (!item) return;
    if (item.id === currentId) {
      toggle();
      return;
    }
    const index = (Array.isArray(items) ? items : []).findIndex(entry => entry.id === item.id);
    playAt(index >= 0 ? index : 0);
  }, [currentId, items, playAt, toggle]);

  // 播完按播放方式处理。status.finished 只在结束那一帧为 true，用 ref 防重入
  // （同一轮结束会因多次状态推送重复触发）。
  const finishedHandledRef = useRef(false);
  useEffect(() => {
    if (!status.finished) {
      finishedHandledRef.current = false;
      return;
    }
    if (finishedHandledRef.current || !current) return;
    finishedHandledRef.current = true;
    if (playMode === 'repeatOne') {
      // 先回到开头再重播：播放位置停在末尾时直接 play 会立刻再次触发 finished。
      seekToSeconds(0).then(() => load(current)).catch(() => {});
      return;
    }
    if (playMode === 'sequential') {
      playAt(nextSequentialIndex(items.length, currentIndex));
      return;
    }
    if (playMode === 'shuffle') {
      playAt(pickShuffleIndex(items.length, currentIndex));
      return;
    }
    // stop：停住但保留当前曲目，用户可直接再点播放从头听。
    stop();
  }, [current, currentIndex, items.length, load, playAt, playMode, seekToSeconds, status.finished, stop]);

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
            // 歌单里的引用同步清掉（失败不阻断删除，渲染侧也会按曲库过滤）。
            purgeSongsFromPlaylists([item.id])
              .then(changed => {
                if (changed) reloadPlaylists().catch(() => {});
              })
              .catch(() => {});
            FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => {});
          },
        },
      ]
    );
  }, [currentId, reloadPlaylists, stop]);

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
      navigation.navigate(ROUTE_NAMES.chat);
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
            <TouchableOpacity
              style={styles.seekButton}
              onPress={() => seekBySeconds(-SEEK_STEP_SECONDS)}
              accessibilityLabel={t('music.a11y.back15')}
            >
              <Text style={styles.seekText}>{`-${SEEK_STEP_SECONDS}`}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.controlButton} onPress={handlePrevTrack} accessibilityLabel={t('music.a11y.prev')}>
              <Ionicons name="play-skip-back" size={20} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.controlButton, styles.playButton]}
              onPress={toggle}
              accessibilityLabel={status.playing ? t('music.a11y.pause') : t('music.a11y.play')}
            >
              <Ionicons name={status.playing ? 'pause' : 'play'} size={22} color={theme.colors.primaryContrast} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.controlButton} onPress={handleNextTrack} accessibilityLabel={t('music.a11y.next')}>
              <Ionicons name="play-skip-forward" size={20} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.seekButton}
              onPress={() => seekBySeconds(SEEK_STEP_SECONDS)}
              accessibilityLabel={t('music.a11y.forward15')}
            >
              <Text style={styles.seekText}>{`+${SEEK_STEP_SECONDS}`}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.secondaryRow}>
            <TouchableOpacity
              style={styles.modeChip}
              onPress={cyclePlayMode}
              accessibilityLabel={t('music.a11y.playMode')}
            >
              <Ionicons name={PLAY_MODE_META[playMode].icon} size={14} color={theme.colors.primarySoft} />
              <Text style={styles.modeChipText}>{t(PLAY_MODE_META[playMode].labelKey)}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.modeChip}
              onPress={cycleRate}
              accessibilityLabel={t('music.a11y.rate')}
            >
              <Ionicons name="speedometer-outline" size={14} color={theme.colors.primarySoft} />
              <Text style={styles.modeChipText}>{formatMusicRate(rate)}</Text>
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
          <CollapsibleSection
            title={t('music.settings.title')}
            icon="options-outline"
            right={(
              <Text style={styles.settingsSummary} numberOfLines={1}>
                {[
                  String(selectedCharacter?.name || '').trim() || t('music.settings.noCharacter'),
                  audioSupported === true
                    ? t('music.clip.seconds', { count: clipSettings.clipSeconds })
                    : '',
                ].filter(Boolean).join(' · ')}
              </Text>
            )}
          >
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
            <CollapsibleSelect
              label={t('music.comments.characterLabel')}
              value={characterId}
              options={characters.map(item => ({
                value: item.id,
                label: String(item.name || '').trim() || t('common.characterFallback'),
              }))}
              onSelect={setCharacterId}
              placeholder={t('music.settings.noCharacter')}
              emptyHint={t('music.settings.noCharacters')}
              style={styles.characterSelect}
            />
          </CollapsibleSection>
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

      <Card style={styles.playlistCard}>
        <View style={styles.playlistHeader}>
          <Text style={styles.playlistTitle}>{t('music.playlists.title')}</Text>
          <TouchableOpacity
            style={styles.playlistCreate}
            onPress={openCreatePlaylist}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={t('music.playlists.create')}
          >
            <Ionicons name="add" size={16} color={theme.colors.primary} />
            <Text style={styles.playlistCreateText}>{t('music.playlists.create')}</Text>
          </TouchableOpacity>
        </View>
        {playlists.length === 0 ? (
          <Text style={styles.playlistEmpty}>{t('music.playlists.empty')}</Text>
        ) : (
          <>
            <View style={styles.playlistChips}>
              <Chip
                label={t('music.playlists.all')}
                active={!activePlaylist}
                onPress={() => setPlaylistFilter('')}
              />
              {playlists.map(playlist => (
                <Chip
                  key={playlist.id}
                  label={t('music.playlists.chip', {
                    name: playlist.name,
                    count: playlist.songIds.length,
                  })}
                  active={activePlaylist?.id === playlist.id}
                  onPress={() => setPlaylistFilter(playlist.id)}
                />
              ))}
            </View>
            {activePlaylist ? (
              <View style={styles.playlistActions}>
                <TouchableOpacity
                  style={styles.playlistAction}
                  onPress={() => openRenamePlaylist(activePlaylist)}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel={t('music.playlists.rename')}
                >
                  <Ionicons name="create-outline" size={14} color={theme.colors.primary} />
                  <Text style={styles.playlistActionText}>{t('music.playlists.rename')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.playlistAction}
                  onPress={() => confirmDeletePlaylist(activePlaylist)}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel={t('music.playlists.delete')}
                >
                  <Ionicons
                    name="trash-outline"
                    size={14}
                    color={theme.colors.danger || theme.colors.text}
                  />
                  <Text style={[styles.playlistActionText, styles.playlistActionDanger]}>
                    {t('music.playlists.delete')}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </>
        )}
      </Card>

      {activePlaylist ? (
        <Text style={styles.playlistFilterHint}>
          {t('music.playlists.filterHint', {
            name: activePlaylist.name,
            count: visibleItems.length,
          })}
        </Text>
      ) : null}

      {visibleItems.length === 0 ? (
        <EmptyState
          icon="musical-notes-outline"
          title={activePlaylist ? t('music.playlists.filterEmpty.title') : t('music.empty.title')}
          description={activePlaylist
            ? t('music.playlists.filterEmpty.body')
            : t('music.empty.body')}
        />
      ) : visibleItems.map(item => (
        <MusicRow
          key={item.id}
          item={item}
          isCurrent={item.id === currentId}
          playing={status.playing}
          onPress={() => handlePlay(item)}
          onDelete={() => handleDelete(item)}
          onMore={() => setPlaylistPickerSongId(item.id)}
          styles={styles}
          theme={theme}
          t={t}
        />
      ))}
    </ScrollView>
      <CollectionNameModal
        visible={playlistPrompt.visible}
        title={playlistPrompt.mode === 'rename'
          ? t('music.playlists.rename.title')
          : t('music.playlists.create.title')}
        placeholder={t('music.playlists.namePlaceholder')}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.confirm')}
        savingLabel={t('music.playlists.saving')}
        maxLength={PLAYLIST_NAME_MAX}
        draft={playlistPrompt.draft}
        saving={playlistSaving}
        onChangeDraft={draft => setPlaylistPrompt(previous => ({ ...previous, draft }))}
        onClose={closePlaylistPrompt}
        onConfirm={confirmPlaylistName}
      />
      <CollectionPickerModal
        visible={!!playlistPickerSong}
        title={t('music.playlists.picker.title')}
        subtitle={playlistPickerSong ? playlistPickerSong.name : ''}
        hint={t('music.playlists.picker.hint')}
        emptyHint={t('music.playlists.picker.noPlaylists')}
        doneLabel={t('common.done')}
        items={playlists}
        itemKey={playlist => playlist.id}
        itemLabel={playlist => playlist.name}
        itemMeta={playlist => t('music.playlists.count', { count: playlist.songIds.length })}
        isIncluded={playlist => playlist.songIds.includes(playlistPickerSongId)}
        onToggle={toggleSongInPlaylist}
        onClose={() => setPlaylistPickerSongId('')}
      />
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
  // 跳时间按钮：用数字标步长（原来这两个位置被 play-back/play-forward 占着，
  // 图标看着像切歌、功能却是跳时间——现在归还给上一首/下一首）。
  seekButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceBorder,
    marginRight: 10,
  },
  seekText: { color: theme.colors.text, fontSize: fonts.scaled(12), fontWeight: '700' },
  secondaryRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: tokens.metrics.buttonRadius,
    borderWidth: tokens.border.thin,
    borderColor: theme.colors.surfaceBorder,
    paddingHorizontal: 9,
    paddingVertical: 5,
    marginRight: 8,
  },
  modeChipText: {
    color: theme.colors.primarySoft,
    fontSize: fonts.scaled(11),
    fontWeight: '600',
    marginLeft: 4,
  },
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
  settingsSummary: {
    color: theme.colors.textFaint,
    fontSize: fonts.scaled(11),
    maxWidth: 160,
    marginRight: 6,
  },
  characterSelect: { marginTop: 8 },
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
  rowMore: { marginRight: 4 },
  rowDelete: { marginRight: 10 },
  playlistCard: { marginBottom: tokens.metrics.cardGap },
  playlistHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  playlistTitle: { color: theme.colors.text, fontSize: fonts.scaled(15), fontWeight: '700' },
  playlistCreate: { flexDirection: 'row', alignItems: 'center' },
  playlistCreateText: { color: theme.colors.primary, fontSize: fonts.scaled(13), fontWeight: '600', marginLeft: 4 },
  playlistEmpty: { color: theme.colors.textFaint, fontSize: fonts.scaled(12), lineHeight: fonts.scaled(17) },
  playlistChips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  playlistActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  playlistAction: { flexDirection: 'row', alignItems: 'center', marginRight: 18 },
  playlistActionText: { color: theme.colors.primary, fontSize: fonts.scaled(12), fontWeight: '600', marginLeft: 4 },
  playlistActionDanger: { color: theme.colors.danger || theme.colors.text },
  playlistFilterHint: {
    color: theme.colors.textMuted,
    fontSize: fonts.scaled(12),
    marginBottom: 8,
    lineHeight: fonts.scaled(17),
  },
});
