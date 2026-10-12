import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from 'react-native';

import {
  createMusicPlaylist,
  deleteMusicPlaylist,
  getMusicPlaylists,
  renameMusicPlaylist,
  setSongInPlaylist,
} from './playlists.js';

// 歌单域：列表加载、当前筛选、命名弹窗草稿、创建/重命名/删除、加入/移出歌单。
// 从 MusicScreen 原样搬出（行为不变），依赖 items（曲库）与 t 由面板注入。
export default function useMusicPlaylists({ items, t }) {
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

  return {
    playlists,
    playlistFilter,
    setPlaylistFilter,
    playlistPrompt,
    setPlaylistPrompt,
    playlistSaving,
    playlistPickerSongId,
    setPlaylistPickerSongId,
    activePlaylist,
    visibleItems,
    playlistPickerSong,
    reloadPlaylists,
    openCreatePlaylist,
    openRenamePlaylist,
    closePlaylistPrompt,
    confirmPlaylistName,
    confirmDeletePlaylist,
    toggleSongInPlaylist,
  };
}
