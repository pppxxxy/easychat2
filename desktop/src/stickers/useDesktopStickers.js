// 桌面表情包：列表加载、图片导入（缩放+命名）、点选发送。
//
// 存储复用 src/storage/stickers.js（索引 + 单条分键）与 saveSticker 的媒体保护；
// 图片处理用 canvas（见 stickers/stickerImage.js），落盘位置与 Android 同为
// documents/stickers/，因此桌面备份导出到手机后仍能显示。
import { useCallback, useEffect, useRef, useState } from 'react';

import { validateImageSize } from '../../../src/chat/attachments.js';
import { useTranslation } from '../../../src/i18n/I18nContext.js';
import { getStickers, saveSticker } from '../../../src/storage/stickers.js';
import { markMediaWrite } from '../../../src/storage/mediaProtection.js';
import { Alert } from '../platform/alert.js';
import { getBridge } from '../platform/bridge.js';
import { documentDirectory } from '../platform/fileSystem.js';
import { createStickerJpeg, defaultStickerName } from './stickerImage.js';

function stickerId() {
  return `sticker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function useDesktopStickers({
  ready,
  isSending,
  captureSessionGuard,
  isSessionGuardCurrent,
  sendMessage,
  getInput,
}) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [stickers, setStickers] = useState([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [pending, setPending] = useState(null);
  const [nameDraft, setNameDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    let active = true;
    getStickers()
      .then(list => { if (active) setStickers(list); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  // 处理「已经拿到的一张图」：缩放/压缩/落盘/登记保护，交给待保存队列。
  // 从文件选择器导入与「把消息里的图存为表情包」**共用这一段**——否则两条路径
  // 各自实现缩放与压缩，尺寸口径必然漂移（手机端 createStickerImage 是同一份）。
  const prepareFromUri = useCallback(async ({ uri: sourceUri, mime = 'image/jpeg', name = '', size = 0 } = {}) => {
    const target = String(sourceUri || '');
    if (!target) return false;
    if (busyRef.current || isSending || !ready) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      if (size) validateImageSize({ size });
      const base64 = await getBridge().fs.read(target, 'base64');
      const processed = await createStickerJpeg(base64, mime || 'image/jpeg');
      validateImageSize({ width: processed.sourceWidth, height: processed.sourceHeight });
      const uri = `${documentDirectory}stickers/sticker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      await getBridge().fs.write(uri, processed.base64, 'base64');
      markMediaWrite(uri);
      setPending({ uri, mime: 'image/jpeg', width: processed.width, height: processed.height });
      setNameDraft(defaultStickerName(name));
      return true;
    } catch (error) {
      const tooLarge = error && (
        error.code === 'ATTACH_IMAGE_TOO_LARGE'
        || error.code === 'ATTACH_IMAGE_RESOLUTION_TOO_LARGE'
      );
      Alert.alert(
        tRef.current('chat.sticker.saveFail.title'),
        tooLarge ? tRef.current('chat.attach.readFail.tooLarge') : String((error && error.message) || tRef.current('common.error.retryLater'))
      );
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [isSending, ready]);

  const importSticker = useCallback(async () => {
    if (busyRef.current || isSending || !ready) return;
    let temporaryUri = '';
    try {
      const result = await getBridge().media.pick('sticker-source');
      if (!result || result.canceled || !Array.isArray(result.items) || !result.items[0]) return;
      const item = result.items[0];
      temporaryUri = item.uri;
      // 错误提示与 busy 复位都在 prepareFromUri 里统一处理（两条路径只留一处）。
      await prepareFromUri({ uri: item.uri, mime: item.mime, name: item.name, size: item.size });
    } finally {
      // 选择器给的是临时文件：无论成败都释放。
      if (temporaryUri) getBridge().fs.delete(temporaryUri, true).catch(() => {});
    }
  }, [isSending, ready, prepareFromUri]);

  const cancelPending = useCallback(() => {
    if (pending && pending.uri) getBridge().fs.delete(pending.uri, true).catch(() => {});
    setPending(null);
    setNameDraft('');
  }, [pending]);

  const confirmSave = useCallback(async () => {
    if (!pending || busyRef.current) return;
    const name = String(nameDraft || '').trim();
    if (!name) {
      Alert.alert(tRef.current('chat.sticker.nameRequired.title'), tRef.current('chat.sticker.nameRequired.body'));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const saved = await saveSticker({
        id: stickerId(),
        name,
        uri: pending.uri,
        mime: pending.mime,
        width: pending.width,
        height: pending.height,
        createdAt: Date.now(),
      });
      setStickers(current => [saved, ...current.filter(item => item.id !== saved.id)]);
      setPending(null);
      setNameDraft('');
      setPanelOpen(true);
    } catch (error) {
      Alert.alert(
        tRef.current('chat.sticker.saveFail.title'),
        String((error && error.message) || tRef.current('common.error.retryLater'))
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [nameDraft, pending]);

  const sendSticker = useCallback(async sticker => {
    if (!sticker || isSending || !ready) return;
    const guard = captureSessionGuard();
    if (!isSessionGuardCurrent(guard)) return;
    try {
      const sent = await sendMessage(String(getInput() || ''), [{
        id: stickerId(),
        kind: 'sticker',
        name: sticker.name,
        stickerName: sticker.name,
        stickerId: sticker.id,
        uri: sticker.uri,
        mime: sticker.mime,
        width: sticker.width,
        height: sticker.height,
      }], guard);
      if (sent) setPanelOpen(false);
    } catch (error) {
      Alert.alert(
        tRef.current('chat.sticker.sendFail.title'),
        String((error && error.message) || tRef.current('common.error.retryLater'))
      );
    }
  }, [captureSessionGuard, getInput, isSending, isSessionGuardCurrent, ready, sendMessage]);

  const togglePanel = useCallback(() => setPanelOpen(value => !value), []);

  return {
    stickers,
    panelOpen,
    setPanelOpen,
    togglePanel,
    pending,
    nameDraft,
    setNameDraft,
    importSticker,
    prepareFromUri,
    cancelPending,
    confirmSave,
    sendSticker,
    busy,
  };
}
