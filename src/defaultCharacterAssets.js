// 内置默认角色（EasyChat2 助手）的头像与背景图。
//
// 图片随包发布（assets/easychat-assistant-*.jpg）。启动时若默认角色尚未自定义
// 头像/背景，就把这两张打包资源落盘到 documentDirectory/avatars/ 并写入默认角色，
// 使所有既有渲染点（聊天背景、顶栏头像、气泡头像、角色卡、切换器…）无需改动即可生效。
//
// 之所以落盘为普通文件而非直接把打包资源 uri 注入内存：用户自定义头像/背景同样存放于
// avatars/，落盘后与现有「文件清理、角色卡导出、引用保护」机制完全一致，避免出现
// 无法被 readAvatarBytes 读取的 http/asset 伪 uri。

import { Asset } from 'expo-asset';
// 必须走 /legacy 入口：SDK 54 的 expo-file-system 主入口不导出 documentDirectory，
// 且 getInfoAsync/copyAsync 等在主入口是会抛错的弃用桩，会导致内置头像/背景永远落盘失败。
import * as FileSystem from 'expo-file-system/legacy';

import { markMediaWrite } from './mediaProtection.js';

const AVATAR_MODULE = require('../assets/easychat-assistant-avatar.jpg');
const BG_MODULE = require('../assets/easychat-assistant-bg.jpg');

async function materialize(moduleRef, fileName) {
  const dir = `${FileSystem.documentDirectory || ''}avatars/`;
  const dest = `${dir}${fileName}`;
  try {
    const info = await FileSystem.getInfoAsync(dest);
    if (info && info.exists) return dest;
  } catch (error) {}
  try {
    const asset = Asset.fromModule(moduleRef);
    await asset.downloadAsync();
    const from = asset.localUri || asset.uri;
    if (!from) return '';
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    // 先登记保护再写盘，堵住写盘与登记之间被回收器误删的窗口。
    markMediaWrite(dest);
    await FileSystem.copyAsync({ from, to: dest });
    return dest;
  } catch (error) {
    return '';
  }
}

// 把内置头像/背景落盘，返回可写入默认角色的 uri（失败项为 ''）。
export async function materializeDefaultArtwork() {
  const [avatarUri, bgUri] = await Promise.all([
    materialize(AVATAR_MODULE, 'default-assistant-avatar.jpg'),
    materialize(BG_MODULE, 'default-assistant-bg.jpg'),
  ]);
  return { avatarUri, bgUri };
}

export const DEFAULT_ARTWORK_FILES = {
  avatar: 'default-assistant-avatar.jpg',
  bg: 'default-assistant-bg.jpg',
};
