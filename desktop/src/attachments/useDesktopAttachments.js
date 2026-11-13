// 桌面附件编排：文件对话框（主进程导入）、粘贴/拖入字节流、附件校验与移除。
//
// 三条入口最后都落到同一个 attachments 状态（useChatSend 的入参）：
//   1. pick*：主进程弹原生对话框并把文件复制进 documents/chat-images|chat-videos，
//      渲染层只拿到复制后的 file URL；
//   2. addFiles：粘贴/拖入时 File 就在渲染层，读 base64 后经 fs.write 落到同一目录；
//   3. removeAttachment：删文件 + 同步状态（发送中禁止移除，避免删掉正在读取的图）。
//
// 校验口径复用共享层：validateImageSize / validateImageBatch / MAX_* 常量与 Android
// 完全一致；图片尺寸用平台层的 Image.getSize（走 easychat2-media:// 探测）。
import { useCallback, useRef, useState } from 'react';

import {
  ATTACH_ERROR,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  MAX_VIDEO_ATTACHMENTS,
  MAX_VIDEO_BYTES,
  deleteLocalImage,
  deleteLocalVideo,
  getImageDimensions,
  getImageMime,
  getVideoMime,
  isImage,
  isVideo,
  validateImageSize,
  validateVideoSize,
} from '../../../src/chat/attachments.js';
import { decodeBytes } from '../../../src/books/decodeText.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { markMediaWrite } from '../../../src/storage/mediaProtection.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { documentDirectory } from '../platform/fileSystem.js';
import { attachmentFileName, readFileAsBase64 } from './mediaFile.js';

const TOO_LARGE_CODES = new Set([
  ATTACH_ERROR.IMAGE_TOO_LARGE,
  ATTACH_ERROR.IMAGE_RESOLUTION_TOO_LARGE,
  ATTACH_ERROR.IMAGE_TOTAL_TOO_LARGE,
  ATTACH_ERROR.FILE_TOO_LARGE,
  ATTACH_ERROR.VIDEO_TOO_LARGE,
]);

function randomId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function useDesktopAttachments({
  attachments,
  attachmentsRef,
  setAttachments,
  isSending,
  ready,
  captureSessionGuard,
  isSessionGuardCurrent,
}) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [loading, setLoading] = useState(false);
  const lockRef = useRef(false);

  const commit = useCallback(next => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, [attachmentsRef, setAttachments]);

  const append = useCallback(items => {
    const current = Array.isArray(attachmentsRef.current) ? attachmentsRef.current : [];
    commit([...current, ...items]);
  }, [attachmentsRef, commit]);

  const deleteFileQuietly = useCallback(uri => {
    const value = String(uri || '');
    if (!value) return;
    getBridge().fs.delete(value, true).catch(() => {});
  }, []);

  const reportAttachError = useCallback(error => {
    const tooLarge = TOO_LARGE_CODES.has(error && error.code);
    Alert.alert(
      tRef.current('chat.attach.readFail.title'),
      tooLarge ? tRef.current('chat.attach.readFail.tooLarge') : tRef.current('common.error.retry')
    );
  }, []);

  const reportPickError = useCallback(error => {
    if (!error) return;
    if (error.code === 'TOO_LARGE') {
      Alert.alert(tRef.current('chat.attach.readFail.title'), tRef.current('chat.attach.readFail.tooLarge'));
    } else if (error.code === 'UNSUPPORTED') {
      Alert.alert(tRef.current('chat.attach.unsupported.title'), tRef.current('chat.attach.unsupported.imageOnly'));
    } else {
      Alert.alert(tRef.current('chat.attach.readFail.title'), tRef.current('common.error.retry'));
    }
  }, []);

  const imageRoom = useCallback(() => {
    const current = Array.isArray(attachmentsRef.current) ? attachmentsRef.current : [];
    return MAX_IMAGE_ATTACHMENTS - current.filter(item => item.kind === 'image').length;
  }, [attachmentsRef]);

  const videoRoom = useCallback(() => {
    const current = Array.isArray(attachmentsRef.current) ? attachmentsRef.current : [];
    return MAX_VIDEO_ATTACHMENTS - current.filter(item => item.kind === 'video').length;
  }, [attachmentsRef]);

  const addImageFromUri = useCallback(async (item, guard) => {
    try {
      const dimensions = await getImageDimensions(item.uri);
      validateImageSize({ size: item.size, width: dimensions.width, height: dimensions.height });
      if (!isSessionGuardCurrent(guard)) {
        deleteFileQuietly(item.uri);
        return false;
      }
      markMediaWrite(item.uri);
      append([{
        id: randomId('image'),
        kind: 'image',
        name: item.name,
        uri: item.uri,
        mime: getImageMime(item.name),
        size: Number(item.size) || 0,
        width: dimensions.width,
        height: dimensions.height,
      }]);
      return true;
    } catch (error) {
      deleteFileQuietly(item.uri);
      reportAttachError(error);
      return false;
    }
  }, [append, deleteFileQuietly, isSessionGuardCurrent, reportAttachError]);

  const addVideoFromUri = useCallback(async (item, guard) => {
    try {
      validateVideoSize({ size: item.size });
      if (!isSessionGuardCurrent(guard)) {
        deleteFileQuietly(item.uri);
        return false;
      }
      markMediaWrite(item.uri);
      append([{
        id: randomId('video'),
        kind: 'video',
        name: item.name,
        uri: item.uri,
        mime: getVideoMime(item.name),
        size: Number(item.size) || 0,
        width: 0,
        height: 0,
      }]);
      return true;
    } catch (error) {
      deleteFileQuietly(item.uri);
      reportAttachError(error);
      return false;
    }
  }, [append, deleteFileQuietly, isSessionGuardCurrent, reportAttachError]);

  const pick = useCallback(async kind => {
    if (isSending || !ready || lockRef.current) return;
    const guard = captureSessionGuard();
    if (!isSessionGuardCurrent(guard)) return;
    lockRef.current = true;
    setLoading(true);
    try {
      const result = await getBridge().media.pick(kind);
      if (!isSessionGuardCurrent(guard)) {
        (result && result.items || []).forEach(item => deleteFileQuietly(item.uri));
        return;
      }
      if (!result || result.canceled) return;
      for (const error of result.errors || []) reportPickError(error);
      const items = Array.isArray(result.items) ? result.items : [];

      if (kind === 'image') {
        const room = imageRoom();
        if (room <= 0 || items.length > room) {
          Alert.alert(
            tRef.current('chat.attach.image.tooMany.title'),
            tRef.current('chat.attach.image.tooMany.body', { count: MAX_IMAGE_ATTACHMENTS })
          );
        }
        const accepted = items.slice(0, Math.max(0, room));
        items.slice(accepted.length).forEach(item => deleteFileQuietly(item.uri));
        for (const item of accepted) {
          await addImageFromUri(item, guard);
        }
        return;
      }

      if (kind === 'video') {
        const room = videoRoom();
        if (room <= 0) {
          items.forEach(item => deleteFileQuietly(item.uri));
          Alert.alert(
            tRef.current('chat.attach.video.tooMany.title'),
            tRef.current('chat.attach.video.tooMany.body', { count: MAX_VIDEO_ATTACHMENTS })
          );
          return;
        }
        for (const item of items.slice(0, room)) {
          await addVideoFromUri(item, guard);
        }
        items.slice(room).forEach(item => deleteFileQuietly(item.uri));
        return;
      }

      if (kind === 'text') {
        for (const item of items) {
          try {
            const bytes = Buffer.from(String(item.base64 || ''), 'base64');
            const { text } = decodeBytes(new Uint8Array(bytes));
            if (!isSessionGuardCurrent(guard)) return;
            append([{ id: randomId('text'), kind: 'text', name: item.name, text }]);
          } catch (error) {
            Alert.alert(tRef.current('chat.attach.encoding.title'), tRef.current('chat.attach.encoding.body'));
          }
        }
      }
    } catch (error) {
      Alert.alert(tRef.current('chat.attach.readFail.title'), tRef.current('common.error.retry'));
    } finally {
      lockRef.current = false;
      setLoading(false);
    }
  }, [
    addImageFromUri,
    addVideoFromUri,
    append,
    captureSessionGuard,
    deleteFileQuietly,
    imageRoom,
    isSending,
    isSessionGuardCurrent,
    ready,
    reportPickError,
    videoRoom,
  ]);

  const importDroppedFile = useCallback(async (file, kind, guard) => {
    const limit = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (Number(file.size) > limit) {
      Alert.alert(tRef.current('chat.attach.readFail.title'), tRef.current('chat.attach.readFail.tooLarge'));
      return false;
    }
    if (kind === 'image' && imageRoom() <= 0) {
      Alert.alert(
        tRef.current('chat.attach.image.tooMany.title'),
        tRef.current('chat.attach.image.tooMany.body', { count: MAX_IMAGE_ATTACHMENTS })
      );
      return false;
    }
    if (kind === 'video' && videoRoom() <= 0) {
      Alert.alert(
        tRef.current('chat.attach.video.tooMany.title'),
        tRef.current('chat.attach.video.tooMany.body', { count: MAX_VIDEO_ATTACHMENTS })
      );
      return false;
    }
    let base64 = '';
    try {
      base64 = await readFileAsBase64(file);
    } catch (error) {
      Alert.alert(tRef.current('chat.attach.readFail.title'), tRef.current('common.error.retry'));
      return false;
    }
    if (!isSessionGuardCurrent(guard)) return false;
    const fileName = attachmentFileName(kind, file.name, file.type);
    const directory = `${documentDirectory}${kind === 'video' ? 'chat-videos' : 'chat-images'}/`;
    const uri = `${directory}${fileName}`;
    try {
      await getBridge().fs.write(uri, base64, 'base64');
    } catch (error) {
      Alert.alert(tRef.current('chat.attach.readFail.title'), tRef.current('common.error.retry'));
      return false;
    }
    if (kind === 'video') {
      return addVideoFromUri({ name: file.name, uri, size: file.size }, guard);
    }
    return addImageFromUri({ name: file.name, uri, size: file.size }, guard);
  }, [addImageFromUri, addVideoFromUri, imageRoom, isSessionGuardCurrent, videoRoom]);

  const addFiles = useCallback(async fileList => {
    if (isSending || !ready) return;
    const guard = captureSessionGuard();
    if (!isSessionGuardCurrent(guard)) return;
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setLoading(true);
    try {
      for (const file of files) {
        if (isImage(file.name, file.type)) {
          await importDroppedFile(file, 'image', guard);
        } else if (isVideo(file.name, file.type)) {
          await importDroppedFile(file, 'video', guard);
        } else {
          Alert.alert(tRef.current('chat.attach.unsupported.title'), tRef.current('chat.attach.unsupported.imageOnly'));
        }
      }
    } finally {
      setLoading(false);
    }
  }, [captureSessionGuard, importDroppedFile, isSending, isSessionGuardCurrent, ready]);

  const removeAttachment = useCallback(id => {
    if (isSending) return;
    const current = Array.isArray(attachmentsRef.current) ? attachmentsRef.current : [];
    const target = current.find(item => item && item.id === id);
    if (target && target.uri) {
      if (target.kind === 'video') deleteLocalVideo(target.uri);
      else if (target.kind === 'image') deleteLocalImage(target.uri);
    }
    commit(current.filter(item => item && item.id !== id));
  }, [attachmentsRef, commit, isSending]);

  return {
    // attachments 以 hook 入参为准，调用方直接渲染同一份状态。
    attachments,
    loading,
    pickImages: () => pick('image'),
    pickVideos: () => pick('video'),
    pickText: () => pick('text'),
    addFiles,
    removeAttachment,
    maxImageAttachments: MAX_IMAGE_ATTACHMENTS,
    maxTextBytes: MAX_TEXT_BYTES,
  };
}
