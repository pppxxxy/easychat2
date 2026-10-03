// 一起听歌面板：本地曲库 + 播放器 + 时间轴打点。陪伴评论流由 useMusicComments
// 驱动（评论只在面板内呈现、不进聊天会话——2026-10-03 用户裁决）。
// 入口在「扩展 → 世界」分组（ExtensionScreen 独立面板页，动态同款跳转模式）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Card, EmptyState, GhostButton, IconButton } from '../ui/index.js';
import { useTheme } from '../theme/ThemeContext.js';
import * as FileSystem from 'expo-file-system/legacy';

import { deleteMusicCommentsForSongs } from './comments.js';
import { deleteMusicItems, getMusicItems, saveMusicDuration, saveMusicTriggers } from './library.js';
import { importMusicFromPicker } from './importMusic.js';
import { formatPlaybackPosition } from './commentPrompts.js';
import { makeTriggerId } from './triggers.js';
import { useMusicPlayer } from './useMusicPlayer.js';

function formatFileSize(size) {
  const bytes = Math.max(0, Math.floor(Number(size)) || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return bytes > 0 ? `${bytes}B` : '';
}

function MusicRow({ item, isCurrent, playing, onPress, onDelete, styles, theme }) {
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
              item.triggers.length > 0 ? `${item.triggers.length} 个打点` : '',
            ].filter(Boolean).join(' · ') || '音频'}
          </Text>
        </View>
      </TouchableOpacity>
      <IconButton
        name="trash-outline"
        accessibilityLabel={`删除 ${item.name}`}
        onPress={onDelete}
        style={styles.rowDelete}
      />
    </View>
  );
}

export default function MusicScreen() {
  const { theme, fonts, tokens } = useTheme();
  const styles = useMemo(() => createStyles(theme, fonts, tokens), [theme, fonts, tokens]);

  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [currentId, setCurrentId] = useState('');
  const { status, load, toggle, seekToSeconds, stop } = useMusicPlayer();

  const current = useMemo(
    () => items.find(item => item.id === currentId) || null,
    [items, currentId]
  );

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
      Alert.alert('导入失败', '无法读取所选音频文件，请重试。');
    } finally {
      setImporting(false);
    }
  }, [importing, load]);

  const handlePlay = useCallback(item => {
    if (!item) return;
    if (item.id === currentId) {
      toggle();
      return;
    }
    setCurrentId(item.id);
    durationDoneRef.current = '';
    load(item);
  }, [currentId, load, toggle]);

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
      return updated;
    } catch (error) {
      Alert.alert('保存失败', '打点没能保存，请重试。');
      return null;
    }
  }, []);

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
      '删除歌曲',
      `确定从曲库删除「${item.name}」吗？音频文件与它的打点、评论会一并删除。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
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

  const progress = status.durationMs > 0 ? Math.min(1, status.positionMs / status.durationMs) : 0;
  const trackWidthRef = useRef(0);

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
        title="曲库读取失败"
        description="音乐库记录读取失败，请稍后重试。"
        action={<GhostButton title="重试" onPress={reload} />}
      />
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>一起听歌</Text>
        <TouchableOpacity
          style={styles.importButton}
          onPress={handleImport}
          disabled={importing}
          activeOpacity={0.85}
        >
          {importing
            ? <ActivityIndicator size="small" color={theme.colors.primaryContrast} />
            : <Ionicons name="add" size={16} color={theme.colors.primaryContrast} />}
          <Text style={styles.importText}>导入本地音乐</Text>
        </TouchableOpacity>
      </View>

      {current ? (
        <Card style={styles.playerCard}>
          <Text style={styles.playerTitle} numberOfLines={1}>{current.name}</Text>
          <Text style={styles.playerTime}>
            {formatPlaybackPosition(status.positionMs)} / {status.durationMs > 0 ? formatPlaybackPosition(status.durationMs) : '--:--'}
          </Text>
          <Pressable
            style={styles.progressTrack}
            onPress={event => {
              const width = trackWidthRef.current;
              if (width > 0) seekFraction(event.nativeEvent.locationX / width);
            }}
            onLayout={event => { trackWidthRef.current = event.nativeEvent.layout.width; }}
            accessibilityLabel="播放进度条，点按跳转"
          >
            <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
          </Pressable>
          <View style={styles.controlsRow}>
            <TouchableOpacity style={styles.controlButton} onPress={() => seekBySeconds(-15)} accessibilityLabel="后退 15 秒">
              <Ionicons name="play-back" size={20} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.controlButton, styles.playButton]}
              onPress={toggle}
              accessibilityLabel={status.playing ? '暂停' : '播放'}
            >
              <Ionicons name={status.playing ? 'pause' : 'play'} size={22} color={theme.colors.primaryContrast} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.controlButton} onPress={() => seekBySeconds(15)} accessibilityLabel="前进 15 秒">
              <Ionicons name="play-forward" size={20} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.markButton} onPress={addTriggerHere} accessibilityLabel="在当前进度打点">
              <Ionicons name="bookmark" size={14} color={theme.colors.primaryContrast} />
              <Text style={styles.markText}>在此打点</Text>
            </TouchableOpacity>
          </View>
          {current.triggers.length > 0 ? (
            <View style={styles.triggerBlock}>
              <Text style={styles.triggerTitle}>时间轴打点（点按跳转，陪伴评论会在这里出现）</Text>
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
                      accessibilityLabel={`删除 ${formatPlaybackPosition(trigger.atMs)} 的打点`}
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

      <FlatList
        data={items}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <EmptyState
            icon="musical-notes-outline"
            title="曲库还是空的"
            description="导入手机里的本地音频，和角色一起听。"
          />
        }
        renderItem={({ item }) => (
          <MusicRow
            item={item}
            isCurrent={item.id === currentId}
            playing={status.playing}
            onPress={() => handlePlay(item)}
            onDelete={() => handleDelete(item)}
            styles={styles}
            theme={theme}
          />
        )}
      />
    </View>
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
  playerCard: { marginHorizontal: 20, marginBottom: tokens.metrics.cardGap, padding: tokens.metrics.cardPadding },
  playerTitle: { color: theme.colors.text, fontSize: fonts.scaled(16), fontWeight: '700' },
  playerTime: { color: theme.colors.textMuted, fontSize: fonts.scaled(12), marginTop: 4 },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.surfaceBorder,
    marginTop: 12,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: theme.colors.primary },
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
  triggerTitle: { color: theme.colors.textFaint, fontSize: fonts.scaled(11), marginBottom: 6 },
  triggerScroll: { flexGrow: 0 },
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
