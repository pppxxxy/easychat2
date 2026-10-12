// 阅读器设置：翻页方式（点击 / 卡片滑动 / 仿真翻书）。
// 全局一份（不分书），与「一起听歌」的片段设置同构；读取失败回退默认，不阻断阅读。

import AsyncStorage from '@react-native-async-storage/async-storage';

import { readJsonStatus } from '../storage/io.js';

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

// 读设置 → { status, settings }，把「没有这个键」与「读不到/结构非法」分开。
// 以前这里用 readJson(key, DEFAULT)：读失败也返回默认值，面板一保存就把默认值
// 写回，用户的翻页方式被静默抹掉（不可逆）。
// 口径同 src/storage/worldMap.js:34-40「读失败就抛错中止：绝不用空列表覆盖已有地图」，
// 但**读路径行为保持不变**：读失败仍回退默认给 UI，不阻断阅读。
// 默认值一律经 normalize(null) 现造（不把 DEFAULT_BOOK_READER_SETTINGS 这个模块级
// 常量按引用交出去，调用方改了它就等于改了全局默认）。
// 损坏值的备份不在这里重复做：本模块的写路径已改为直接拒绝，损坏原值原地保留，
// 不存在被默认值覆盖的风险（备份只在「即将覆盖」时才有意义）。
async function readBookReaderSettingsStatus() {
  const stored = await readJsonStatus(BOOK_READER_SETTINGS_KEY);
  const fallback = normalizeBookReaderSettings(null);
  if (
    stored.status === 'corrupt'
    || (stored.status === 'ok'
      && (stored.value === null || typeof stored.value !== 'object' || Array.isArray(stored.value)))
  ) {
    return { status: 'corrupt', settings: fallback };
  }
  if (stored.status === 'missing') return { status: 'ok', settings: fallback };
  return { status: 'ok', settings: normalizeBookReaderSettings(stored.value) };
}

export async function getBookReaderSettings() {
  const result = await readBookReaderSettingsStatus();
  return result.settings;
}

export async function saveBookReaderSettings(patch) {
  const result = await readBookReaderSettingsStatus();
  // 读失败**拒绝写回**：此时拿到的只能是默认值，写回等于把用户存的设置抹成默认。
  // 错误码写法同 src/screenWatch/threads.js:99（调用方目前 catch 后静默，不面向用户）。
  if (result.status === 'corrupt') throw new Error('book-reader-settings-read-failed');
  const next = normalizeBookReaderSettings({ ...result.settings, ...(patch || {}) });
  await AsyncStorage.setItem(BOOK_READER_SETTINGS_KEY, JSON.stringify(next));
  return next;
}
