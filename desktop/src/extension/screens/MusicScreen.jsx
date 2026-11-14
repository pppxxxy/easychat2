// 音乐库（桌面）：查看 / 播放 / 删除已导入的本地音乐。
//
// 数据与判定全部复用共享层：
//   · music/library.js —— getMusicItems / deleteMusicItems（含分键损坏保护与陈键清扫）；
//   · music/importMusic.js —— 手机侧的导入编排；桌面用自己的文件选择对话框
//     （media:pick），因此这里只复用「落盘到 documents/music + 建索引」这条结果形状。
//
// 与手机的平台差异：手机上音乐靠 expo-audio 在原生侧播放；桌面用 <audio> 元素。
// 文件本身就在 documents/music/ 下（共享层的目录常量），媒体协议 mediaUrl() 能直接
// 喂给 <audio src>，不需要额外 IPC。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import { deleteMusicItems, getMusicItems, saveMusicItem, saveMusicDuration } from '../../../../src/music/library.js';
import { MUSIC_DIR_NAME, normalizeMusicItem } from '../../../../src/music/library.js';
import { markMediaWrite } from '../../../../src/storage/mediaProtection.js';
import { Alert } from '../../platform/alert.js';
import { getBridge } from '../../platform/bridge.js';
import { documentDirectory } from '../../platform/fileSystem.js';
import { mediaUrl } from '../../platform/mediaUrl.js';
import { Button, Card, Row } from '../../settings/ui.jsx';
import MusicPlaylistPanel from './MusicPlaylistPanel.jsx';
import RoleCommentPanel from './RoleCommentPanel.jsx';

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '--:--';
  const total = Math.round(value / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export default function MusicScreen({ palette, fonts }) {
  const { t } = useTranslation();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [playingId, setPlayingId] = useState('');
  // 歌单筛选后的可见曲目（空数组 = 未启用歌单，显示全部）。
  const [visibleItems, setVisibleItems] = useState([]);
  const audioRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getMusicItems();
      setItems(list);
    } catch (error) {
      // 读失败（损坏）不伪装成空库：保留当前列表并告知，避免用户以为音乐被删了。
      Alert.alert(t('music.load.failed.title'), t('music.load.failed.body'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  // 导入：桌面走 media.pick（多选），把文件复制进 documents/music/ 后建索引。
  const importFiles = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await getBridge().media.pick('audio');
      const picked = result && !result.canceled && Array.isArray(result.items) ? result.items : [];
      for (const item of picked) {
        const ext = (String(item.uri || '').split('.').pop() || 'mp3').slice(0, 5);
        const id = `music-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const destination = `${documentDirectory}${MUSIC_DIR_NAME}/${id}.${ext}`;
        await getBridge().fs.copy(item.uri, destination);
        // 登记媒体写入：备份导出时不会把这些文件当孤儿清掉。
        markMediaWrite(destination);
        await saveMusicItem(normalizeMusicItem({
          id,
          name: String(item.name || '').replace(/\.[^.]+$/, '') || id,
          uri: destination,
          size: Number(item.size) || 0,
          mime: String(item.mime || ''),
          addedAt: Date.now(),
        }));
        getBridge().fs.delete(item.uri, true).catch(() => {});
      }
      await load();
    } catch (error) {
      Alert.alert(t('settings.api.saved.title'), t('common.error.storageOrPermission'));
    } finally {
      setBusy(false);
    }
  };

  const removeItem = item => {
    if (!item || busy) return;
    Alert.alert(t('common.delete'), item.name, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            if (playingId === item.id && audioRef.current) {
              audioRef.current.pause();
              setPlayingId('');
            }
            await deleteMusicItems([item.id]);
            await load();
          } catch (error) {
            Alert.alert(t('settings.api.saved.title'), t('common.error.storageOrPermission'));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const play = item => {
    const node = audioRef.current;
    if (!node || !item) return;
    const src = mediaUrl(item.uri);
    if (!src) {
      Alert.alert(t('chat.bubble.mediaMissing'), t('chat.bubble.mediaMissingHint'));
      return;
    }
    if (playingId === item.id) {
      node.pause();
      setPlayingId('');
      return;
    }
    node.src = src;
    node.play()
      .then(() => setPlayingId(item.id))
      .catch(() => Alert.alert(t('chat.bubble.mediaMissing'), t('chat.bubble.mediaMissingHint')));
  };

  // 首次播放成功后回填时长（共享层靠它算进度；未知时长记 0）。
  const onLoadedMetadata = () => {
    const node = audioRef.current;
    if (!node || !playingId) return;
    const duration = Math.round(Number(node.duration) * 1000);
    if (Number.isFinite(duration) && duration > 0) {
      saveMusicDuration(playingId, duration).catch(() => {});
      setItems(current => current.map(item => (item.id === playingId ? { ...item, durationMs: duration } : item)));
    }
  };

  const total = useMemo(() => items.length, [items]);
  // 歌单筛选生效时只显示选中歌单里的歌；未选歌单（visibleItems 为空）显示全部。
  const shownItems = useMemo(
    () => (Array.isArray(visibleItems) && visibleItems.length > 0 ? visibleItems : items),
    [visibleItems, items]
  );

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, minWidth: 0 }}>
      <Card
        title={t('music.title')}
        hint={t('music.empty.body')}
        palette={palette}
        fonts={fonts}
      >
        <Row>
          <Button
            label={busy ? t('backup.progress.ratio') : t('music.import')}
            onClick={importFiles}
            palette={palette}
            fonts={fonts}
            primary
            disabled={busy}
          />
          <Button
            label={loading ? t('backup.progress.ratio') : t('ext.home.music.summary', { count: total })}
            onClick={load}
            palette={palette}
            fonts={fonts}
            disabled={loading}
          />
        </Row>
        {/* 歌单（复用共享 useMusicPlaylists）：筛选回给本页控制列表显示。 */}
        <MusicPlaylistPanel
          items={items}
          palette={palette}
          fonts={fonts}
          onFilteredChange={setVisibleItems}
        />
        <audio
          ref={audioRef}
          onLoadedMetadata={onLoadedMetadata}
          onEnded={() => setPlayingId('')}
          controls
          style={{ width: '100%', marginTop: 4 }}
        />
      </Card>

      {shownItems.length === 0 && !loading ? (
        <Card palette={palette} fonts={fonts} title={t('music.empty.title')}>
          <div style={{ fontSize: fonts.scaled(12), color: palette.textMuted, lineHeight: 1.7 }}>
            {t('music.empty.body')}
          </div>
        </Card>
      ) : null}

      {shownItems.map(item => (
        <Card key={item.id} palette={palette} fonts={fonts} title={item.name || t('common.unnamedCharacter')}>
          <Row>
            <Button
              label={playingId === item.id ? t('music.a11y.pause') : t('music.a11y.play')}
              onClick={() => play(item)}
              palette={palette}
              fonts={fonts}
              primary={playingId === item.id}
              disabled={busy}
            />
            <span style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
              {formatDuration(item.durationMs)}
            </span>
            <Button
              label={t('common.delete')}
              onClick={() => removeItem(item)}
              palette={palette}
              fonts={fonts}
              tone={palette.danger || '#ff5a5f'}
              disabled={busy}
            />
          </Row>
          {/* 和角色一起听：让选中的角色就这首歌说一句短评。 */}
          {playingId === item.id || items.length === 1 ? (
            <RoleCommentPanel kind="music" target={item} palette={palette} fonts={fonts} />
          ) : null}
        </Card>
      ))}
    </div>
  );
}