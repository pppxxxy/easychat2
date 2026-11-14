// 音乐歌单（桌面）：复用共享 hook useMusicPlaylists —— 手机 MusicScreen 用的是同一份。
//
// 为什么单独成组件：MusicScreen 已接近 800 行棘轮，歌单是一块自洽的功能
// （筛选 + 新建/重命名/删除 + 把歌加入歌单），抽出来才能不撑爆宿主。
//
// 与手机的差异只在呈现：手机把歌单做成横向 chip 条 + 底部弹层；桌面用下拉筛选 +
// 行内按钮。**判定与存储完全复用**（playlists.js 的 create/rename/delete/toggle）。
import { useEffect, useState } from 'react';

import { useTranslation } from '../../../../src/i18n/I18nContext.js';
import useMusicPlaylists from '../../../../src/music/useMusicPlaylists.js';
import { Button, Card, Field, Row, Select, TextInput } from '../../settings/ui.jsx';

export default function MusicPlaylistPanel({ items, palette, fonts, onFilteredChange }) {
  const { t } = useTranslation();
  const playlists = useMusicPlaylists({ items, t });
  const [nameDraft, setNameDraft] = useState('');
  const [editingId, setEditingId] = useState('');

  // 筛选结果回给宿主：宿主用它决定列表显示哪些曲目（与手机 visibleItems 同源）。
  // 必须放在 effect 里——渲染期间调 setState 会触发 React 的「render 中更新」
  // 警告，且在特定时序下会反复重渲染（本组件每次 render 都新建 visibleItems）。
  const visible = playlists.visibleItems;
  useEffect(() => {
    if (typeof onFilteredChange === 'function') onFilteredChange(visible);
  }, [onFilteredChange, visible]);

  const filterOptions = [
    { value: '', label: t('music.playlists.all') },
    ...(Array.isArray(playlists.playlists) ? playlists.playlists : []).map(item => ({
      value: String(item.id),
      label: t('music.playlists.chip', {
        name: item.name || t('music.playlists.namePlaceholder'),
        count: Array.isArray(item.songIds) ? item.songIds.length : 0,
      }),
    })),
  ];

  const submitName = async () => {
    const name = String(nameDraft || '').trim();
    if (!name) return;
    // 共享 hook 的确认逻辑读的是 playlistPrompt.draft。桌面没有弹层，所以这里
    // 只把「模式 + 草稿」设好再叫它确认——重名/空名判定与持久化全在 hook 里。
    playlists.setPlaylistPrompt({
      visible: true,
      mode: editingId ? 'rename' : 'create',
      playlistId: editingId ? String(editingId) : '',
      draft: name,
    });
    await playlists.confirmPlaylistName();
    setNameDraft('');
    setEditingId('');
  };

  const active = playlists.activePlaylist;

  return (
    <Card title={t('music.playlists.title')} palette={palette} fonts={fonts}>
      {playlists.playlists.length === 0 ? (
        <div style={{ fontSize: fonts.scaled(11), color: palette.textMuted }}>
          {t('music.playlists.empty')}
        </div>
      ) : (
        <>
          <Field label={t('music.playlists.title')} hint={t('music.playlists.filterHint')} palette={palette} fonts={fonts}>
            <Select
              value={String(playlists.playlistFilter || '')}
              options={filterOptions}
              onChange={value => playlists.setPlaylistFilter(value)}
              palette={palette}
              fonts={fonts}
            />
          </Field>
          {active ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Button
                label={t('music.playlists.rename')}
                onClick={() => {
                  setEditingId(String(active.id));
                  setNameDraft(String(active.name || ''));
                }}
                palette={palette}
                fonts={fonts}
                disabled={playlists.playlistSaving}
              />
              <Button
                label={t('music.playlists.delete')}
                onClick={() => playlists.confirmDeletePlaylist(String(active.id))}
                palette={palette}
                fonts={fonts}
                disabled={playlists.playlistSaving}
              />
            </div>
          ) : null}
        </>
      )}

      <Row>
        <div style={{ flex: 1, minWidth: 140 }}>
          <TextInput
            value={nameDraft}
            onChange={setNameDraft}
            placeholder={t('music.playlists.namePlaceholder')}
            palette={palette}
            fonts={fonts}
          />
        </div>
        <Button
          label={playlists.playlistSaving
            ? t('music.playlists.saving')
            : (editingId ? t('music.playlists.rename') : t('music.playlists.create'))}
          onClick={submitName}
          palette={palette}
          fonts={fonts}
          primary
          disabled={playlists.playlistSaving || !String(nameDraft || '').trim()}
        />
      </Row>

      {/* 把歌加入当前歌单：只在选中某个歌单时出现（「全部」不是一个可写入的歌单）。 */}
      {active ? (
        <Field label={t('music.playlists.picker.title')} hint={t('music.playlists.picker.hint')} palette={palette} fonts={fonts}>
          <Select
            value={String(playlists.playlistPickerSongId || '')}
            options={[
              { value: '', label: t('music.playlists.picker.title') },
              ...(Array.isArray(items) ? items : []).map(item => ({
                value: String(item.id),
                label: item.name || t('music.playlists.namePlaceholder'),
              })),
            ]}
            onChange={value => {
              playlists.setPlaylistPickerSongId(value);
              if (value) playlists.toggleSongInPlaylist(String(active.id), String(value));
            }}
            palette={palette}
            fonts={fonts}
          />
        </Field>
      ) : null}
    </Card>
  );
}