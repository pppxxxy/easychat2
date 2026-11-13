// 本地媒体 URL（design.md「适配层契约 5」）：file:// 路径 -> easychat2-media:// 协议 URL。
//
// 数据库中仍保存原有 file:// URI（不做格式变更）；只在渲染前转换。
// 目录清单与 src/storage/dataBackup.js 的 BACKUP_MEDIA_DIRECTORIES **同源**：
// 这里手抄一份是因为 dataBackup 的依赖图会拖进整个存储域（桌面端按需分模块加载）；
// 一致性由 desktop/tests/platform/mediaUri.test.mjs 解析源文件后逐项比对钉住
// （顺序也钉：两边都按 dataBackup 的声明顺序排列）。
export const MEDIA_DIRECTORIES = Object.freeze([
  'avatars',
  'stickers',
  'chat-images',
  'voice',
  'characters',
  'card-forge',
  'music',
  'books',
  'chat-videos',
]);

const MEDIA_SCHEME = 'easychat2-media';

function decodePath(fileUrl) {
  let raw = String(fileUrl || '');
  if (raw.startsWith('file://')) {
    try {
      raw = decodeURIComponent(new URL(raw).pathname);
    } catch (error) {
      return null;
    }
  }
  // Windows file URL 形如 /C:/Users/...：去掉盘符前的斜杠。
  if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1);
  return raw.replace(/\\/g, '/');
}

// 返回协议 URL；不在已知媒体目录下时返回 null（调用方保留原 URI 并标记媒体缺失）。
export function mediaUrl(uri) {
  const filePath = decodePath(uri);
  if (!filePath) return null;
  for (const directory of MEDIA_DIRECTORIES) {
    let relative = null;
    // 绝对路径（Android / Windows）与相对片段都只认「<dir>/<file>」这一段。
    const marker = `/${directory}/`;
    const index = filePath.lastIndexOf(marker);
    if (index !== -1) relative = filePath.slice(index + marker.length);
    else if (filePath.startsWith(`${directory}/`)) relative = filePath.slice(directory.length + 1);
    if (!relative) continue;
    const encoded = relative.split('/').map(segment => encodeURIComponent(segment)).join('/');
    return `${MEDIA_SCHEME}://media/${directory}/${encoded}`;
  }
  return null;
}

export default mediaUrl;
