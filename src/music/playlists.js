// 音乐歌单存储领域：委托通用集合存储工厂（见 ../storage/collectionStore.js）。
// 歌单只保存歌曲 id 引用、不复制音频文件；歌曲被删除时由调用方调
// purgeSongsFromPlaylists 清理引用（界面渲染也会按曲库过滤，双保险不留幽灵条目）。

import { createCollectionStore } from '../storage/collectionStore.js';

export const MUSIC_PLAYLISTS_KEY = '@easychat2_music_playlists';
export const PLAYLIST_NAME_MAX = 40;

const store = createCollectionStore({
  key: MUSIC_PLAYLISTS_KEY,
  idPrefix: 'playlist',
  nameMax: PLAYLIST_NAME_MAX,
  itemField: 'songIds',
  errorCodePrefix: 'playlist',
});

// 错误码而非文案：存储层不持有用户可见文本（i18n 防复发规则），界面按 code 决策并给本地化提示。
export const PLAYLIST_ERROR = store.ERROR;
export const normalizePlaylist = store.normalize;
export const getMusicPlaylists = store.getAll;
export const createMusicPlaylist = store.create;
export const renameMusicPlaylist = store.rename;
export const deleteMusicPlaylist = store.remove;
export const setSongInPlaylist = store.setIncluded;
export const purgeSongsFromPlaylists = store.purgeItems;
