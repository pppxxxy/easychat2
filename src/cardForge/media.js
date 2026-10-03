// 制卡草稿的图片文件：头像 / 背景图的选择、清理，以及导入角色库时的目录提升。
//
// 目录与命名的纯规则在 ./mediaPaths.js（Node 可测）；这里只做带 FileSystem 的
// 副作用。草稿图放 card-forge/ 而非 avatars/ 的理由见 mediaPaths.js 的文件头注释。

import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

import { getPickedAsset } from '../character/cardHelpers.js';
import { markMediaWrite } from '../mediaProtection.js';

import {
  avatarDirectory,
  buildForgeImageName,
  buildPromotedAvatarName,
  forgeImageNamesToDelete,
  forgeImageExtension,
  forgeMediaDirectory,
  isForgeMediaUri,
} from './mediaPaths.js';

// 与角色编辑表单同一批可选类型（PNG/JPEG），换别的格式要同步改两处。
const PICKER_TYPES = ['image/png', 'image/jpeg'];

export { forgeMediaDirectory, isForgeMediaUri };

// 选择一张图片并复制进草稿目录；返回新 uri，用户取消时返回 ''。
export async function pickForgeImage({ key = 'avatarUri', now = Date.now() } = {}) {
  const result = await DocumentPicker.getDocumentAsync({
    type: PICKER_TYPES,
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = getPickedAsset(result);
  if (!asset || !asset.uri) return '';
  const directory = forgeMediaDirectory(FileSystem.documentDirectory);
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const destination = `${directory}${buildForgeImageName({
    key,
    now,
    extension: forgeImageExtension(asset.mimeType, asset.uri),
  })}`;
  markMediaWrite(destination);
  try {
    await FileSystem.copyAsync({ from: asset.uri, to: destination });
  } catch (error) {
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
    throw error;
  }
  return destination;
}

// 删除一张草稿图；只删草稿目录内的文件，绝不动 avatars/ 里已被角色引用的图。
export async function deleteForgeImage(uri) {
  if (!isForgeMediaUri(uri, FileSystem.documentDirectory)) return;
  try {
    await FileSystem.deleteAsync(String(uri), { idempotent: true });
  } catch (error) {}
}

// 导入角色库时把草稿图复制到 avatars/，返回新 uri。
// 刻意只复制、不删草稿副本：落库失败时草稿仍指向存在的文件（界面不会变成破图），
// 调用方在角色确实创建成功后调 deleteForgeImage 收尾；万一没走到那一步，
// 提升出来的副本没被任何角色引用，下次孤儿回收会清掉它。
// 不是草稿图（如「角色 → 制卡」带回的、已在 avatars/ 的图）原样返回，不做多余复制。
export async function promoteForgeImageToAvatar(uri, { now = Date.now() } = {}) {
  const source = String(uri || '');
  if (!isForgeMediaUri(source, FileSystem.documentDirectory)) return source;
  const extension = forgeImageExtension('', source);
  const directory = avatarDirectory(FileSystem.documentDirectory);
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const destination = `${directory}${buildPromotedAvatarName({ now, extension })}`;
  markMediaWrite(destination);
  try {
    await FileSystem.copyAsync({ from: source, to: destination });
  } catch (error) {
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
    throw error;
  }
  return destination;
}

// 清理草稿目录里的图片（不含 .json 草稿载荷）：重新开始时调用，避免长期占用空间。
export async function deleteForgeDraftImages() {
  const directory = forgeMediaDirectory(FileSystem.documentDirectory);
  let names = [];
  try {
    names = await FileSystem.readDirectoryAsync(directory);
  } catch (error) {
    return;
  }
  await Promise.all(forgeImageNamesToDelete(names)
    .map(name => FileSystem.deleteAsync(`${directory}${name}`, { idempotent: true }).catch(() => {})));
}
