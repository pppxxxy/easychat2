// 图片消息「另存为」（桌面）：手机是「保存到相册」（expo-media-library），
// 桌面没有相册概念，等价物是系统「另存为」对话框。
//
// 为什么需要把源先复制进 cache：主进程的 backup:saveAs 只接受 documents/cache 内的
// 源（见 electron/ipc/backupFiles.js 的安全注释），聊天图片在 documents/chat-images/
// 下，直接传会被拒。复制 → 另存 → 删临时副本，是既有导出面板（ConversationExportPanel）
// 用的同一套路径。
import { getBridge } from '../platform/bridge.js';
import { documentDirectory } from '../platform/fileSystem.js';
import { Alert } from '../platform/alert.js';
import { tActive } from '../../../src/i18n/index.js';

// 从 URI 猜扩展名：聊天图片可能是 png/jpg/webp，另存时保持原格式（不转码）。
function extensionOf(uri, mime) {
  const fromMime = String(mime || '').toLowerCase();
  if (fromMime.includes('png')) return 'png';
  if (fromMime.includes('webp')) return 'webp';
  if (fromMime.includes('gif')) return 'gif';
  if (fromMime.includes('jpeg') || fromMime.includes('jpg')) return 'jpg';
  const value = String(uri || '');
  const match = value.match(/\.([a-zA-Z0-9]{2,5})(?:\?|#|$)/);
  return match ? match[1].toLowerCase() : 'png';
}

function fileNameFor(extension, now = Date.now()) {
  // 时间戳命名：用户另存多张时不会互相覆盖，也不需要读原文件名（可能是随机 id）。
  return `chat-image-${now}.${extension}`;
}

export async function saveImageAs(image) {
  const uri = String((image && image.uri) || '');
  if (!uri) return false;
  const bridge = getBridge();
  const extension = extensionOf(uri, image && image.mime);
  const name = fileNameFor(extension);
  const tempUri = `${documentDirectory}cache/${name}`;
  try {
    await bridge.fs.mkdir(`${documentDirectory}cache/`, true).catch(() => {});
    await bridge.fs.copy(uri, tempUri);
    const result = await bridge.backup.saveAs(
      tempUri,
      name,
      [{ name: extension.toUpperCase(), extensions: [extension] }]
    );
    return !!(result && !result.canceled);
  } catch (error) {
    Alert.alert(tActive('chat.saveImage.fail.title'));
    return false;
  } finally {
    // 无论成功与否都删临时副本：留着会变成孤儿文件。
    bridge.fs.delete(tempUri, true).catch(() => {});
  }
}

export default saveImageAs;
