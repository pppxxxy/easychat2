// 阅读器设置：翻页方式（点击 / 卡片滑动 / 仿真翻书）。
// 全局一份（不分书），与「一起听歌」的片段设置同构；读取失败回退默认，不阻断阅读。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { readJson } from '../storage/io.js';

export const BOOK_READER_SETTINGS_KEY = '@easychat2_book_reader';

// tap   = 点左/右三分之一翻页（原行为）
// slide = 左右滑动翻页，页面作卡片平移
// curl  = 左右滑动翻页，页面 3D 翻转（旋转翻页）
// fade  = 左右滑动翻页，旧页淡出、新页淡入（不位移）
// 数组顺序即工具栏按钮的轮换顺序；旧值不在表内时归一化会回落默认，不丢设置。
export const PAGE_TURN_MODES = ['tap', 'slide', 'curl', 'fade'];

export const DEFAULT_BOOK_READER_SETTINGS = { pageTurn: 'tap' };

export function normalizeBookReaderSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = String(source.pageTurn || '');
  return {
    pageTurn: PAGE_TURN_MODES.includes(mode) ? mode : DEFAULT_BOOK_READER_SETTINGS.pageTurn,
  };
}

export async function getBookReaderSettings() {
  const stored = await readJson(BOOK_READER_SETTINGS_KEY, DEFAULT_BOOK_READER_SETTINGS);
  return normalizeBookReaderSettings(stored);
}

export async function saveBookReaderSettings(patch) {
  const current = await getBookReaderSettings().catch(() => DEFAULT_BOOK_READER_SETTINGS);
  const next = normalizeBookReaderSettings({ ...current, ...(patch || {}) });
  await AsyncStorage.setItem(BOOK_READER_SETTINGS_KEY, JSON.stringify(next));
  return next;
}
