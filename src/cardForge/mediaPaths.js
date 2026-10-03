// 制卡图片的路径与命名规则（纯函数，零 RN 依赖，可 Node 直测）。
//
// 目录取舍：草稿图放 `card-forge/`，不放 `avatars/`。孤儿回收器只扫
// avatars/、stickers/、chat-images/，并以「被角色/会话/动态引用」为准；
// 草稿图还没被任何角色引用，放 avatars/ 会在保护窗口（10 分钟）过后被当孤儿删掉。
// 导入角色库时再提升到 avatars/，此时新角色已引用它，回收器不会再动。

export const FORGE_MEDIA_DIRECTORY = 'card-forge';
export const AVATAR_DIRECTORY = 'avatars';
export const FORGE_IMAGE_KEYS = ['avatarUri', 'bgUri'];

// 文件名里的 key：avatarUri → avatar，bgUri → bg（只求可读，语义由调用方定）。
export function imageKeyLabel(key) {
  return key === 'bgUri' ? 'bg' : 'avatar';
}

export function forgeMediaDirectory(documentDirectory) {
  return `${documentDirectory || ''}${FORGE_MEDIA_DIRECTORY}/`;
}

export function avatarDirectory(documentDirectory) {
  return `${documentDirectory || ''}${AVATAR_DIRECTORY}/`;
}

// 是否落在草稿图片目录内。删除/提升都必须先过这一关：
// 「角色 → 制卡」带回来的图在 avatars/ 里，已被角色引用，绝不能当草稿图删掉。
export function isForgeMediaUri(uri, documentDirectory) {
  const value = String(uri || '');
  if (!value) return false;
  return value.startsWith(forgeMediaDirectory(documentDirectory));
}

// 与角色编辑表单同一套判定：mime 是 PNG 或 URI 以 .png 结尾就用 .png，其余按 .jpg。
export function forgeImageExtension(mime, uri) {
  const type = String(mime || '').toLowerCase();
  if (type === 'image/png' || /\.png(?:$|\?)/i.test(String(uri || ''))) return '.png';
  return '.jpg';
}

export function buildForgeImageName({ key = 'avatarUri', now = Date.now(), random = Math.random, extension = '.jpg' } = {}) {
  const token = Math.floor(random() * 0x7fffffff).toString(36).slice(0, 6) || '0';
  return `${imageKeyLabel(key)}-${now}-${token}${extension}`;
}

export function buildPromotedAvatarName({ now = Date.now(), random = Math.random, extension = '.jpg' } = {}) {
  const token = Math.floor(random() * 0x7fffffff).toString(36).slice(0, 6) || '0';
  return `forge-${now}-${token}${extension}`;
}

// 草稿目录里哪些文件属于「草稿载荷」而非「草稿图片」：清理图片时必须跳过它们。
export function isForgePayloadFileName(name) {
  return String(name || '').endsWith('.json');
}

// 目录条目 → 待删除的图片名（跳过载荷）。
export function forgeImageNamesToDelete(names) {
  return (Array.isArray(names) ? names : [])
    .map(name => String(name || ''))
    .filter(name => name && !isForgePayloadFileName(name));
}
