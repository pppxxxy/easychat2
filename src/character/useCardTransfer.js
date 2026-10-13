// 角色卡的导入/导出/分享关注点：PNG/JSON 文件导入、分享码（剪贴板）导入、
// 导出（PNG/JSON）、分享面板（二维码/分享码）。从 CharacterDetailScreen 外提，
// 把「卡片 I/O」从表单生命周期里分离出来。状态与副作用自持，宿主注入上下文依赖。
import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import { Buffer } from 'buffer';

import { parseCardFromJson, parseCardFromPng } from './cardParser.js';
import { exportCardFile } from './cardExporter.js';
import { decodeCardShareCode, isCardShareCode } from '../share/cardShare.js';
import { listGreetingCandidates } from './cardGreetings.js';
import { maskSecrets } from '../storage/secrets.js';
import { markMediaWrite } from '../storage/mediaProtection.js';
import { getUserProfile } from '../storage/personas.js';
import {
  MAX_IMPORT_BYTES,
  NO_CARD_DATA_MESSAGE_KEY,
  assetLooksLike,
  buildCharacterPatch,
  formatImportSize,
  getPickedAsset,
  hasCardContent,
  isLargeImport,
  isPngBuffer,
} from './cardHelpers.js';

export default function useCardTransfer({
  loaded,
  t,
  editedCharacter,
  formDirty,
  screenSessionRef,
  fileSystem,
  addCharacter,
  ensureCharacterSession,
  updateCharacter,
  setAvatarPreview,
  setBgPreview,
  setSegment,
}) {
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState(null);
  const [pendingImport, setPendingImport] = useState(null);
  const [exporting, setExporting] = useState(false);
  const exportBusyRef = useRef(false);
  // 分享：二维码 / 分享码 / 带数据的 PNG。
  const [shareOpen, setShareOpen] = useState(false);
  const [shareAvatarBytes, setShareAvatarBytes] = useState(null);

  const importCard = async () => {
    if (importing || !loaded) return;
    setImporting(true);
    setImportStatus({ phase: 'reading', large: false, size: 0 });

    try {
      let result;
      try {
        result = await DocumentPicker.getDocumentAsync({
          type: ['image/png', 'application/json'],
          copyToCacheDirectory: true,
          multiple: false,
        });
      } catch (error) {
        Alert.alert(t('character.detail.importReadError'));
        return;
      }

      const asset = getPickedAsset(result);
      if (!asset?.uri) return;
      let assetSize = Number(asset.size) > 0 ? Number(asset.size) : 0;
      if (assetSize <= 0) {
        const info = await fileSystem.getInfoAsync(asset.uri).catch(() => null);
        assetSize = Number(info && info.size) > 0 ? Number(info.size) : 0;
      }
      if (assetSize > MAX_IMPORT_BYTES) {
        Alert.alert(t('character.detail.importTooLarge.title'), t('character.detail.importTooLarge.body', { size: formatImportSize(MAX_IMPORT_BYTES) }));
        return;
      }
      setImportStatus({
        phase: 'reading',
        large: isLargeImport(assetSize),
        size: assetSize,
      });

      let buffer;
      try {
        const base64 = await fileSystem.readAsStringAsync(asset.uri, {
          encoding: fileSystem.EncodingType.Base64,
        });
        buffer = Buffer.from(base64, 'base64');
        if (buffer.length > MAX_IMPORT_BYTES) {
          Alert.alert(t('character.detail.importTooLarge.title'), t('character.detail.importTooLarge.body', { size: formatImportSize(MAX_IMPORT_BYTES) }));
          return;
        }
        const importSize = assetSize || buffer.length;
        setImportStatus({
          phase: 'reading',
          large: isLargeImport(importSize),
          size: importSize,
        });
      } catch (error) {
        Alert.alert(t('character.detail.importReadError'));
        return;
      }

      const isPng = assetLooksLike(asset, '.png', ['image/png', 'image/x-png']);
      const isJson = assetLooksLike(asset, '.json', ['application/json', 'text/json']);
      const treatAsPng = isPngBuffer(buffer) || (isPng && !isJson);

      let parsed;
      try {
        parsed = treatAsPng
          ? parseCardFromPng(buffer)
          : parseCardFromJson(buffer.toString('utf8'));
      } catch (error) {
        const detail = maskSecrets(error?.message || String(error));


        console.warn('[角色卡导入] 解析失败：', detail);
        Alert.alert(t('character.detail.importParseFail.title'), detail || t('character.detail.importParseFail.fallback'));
        return;
      }

      if (treatAsPng && parsed === null) {
        Alert.alert(t('character.detail.importEmpty.title'), t(NO_CARD_DATA_MESSAGE_KEY));
        return;
      }

      if (!hasCardContent(parsed)) {
        Alert.alert(t('character.detail.importEmpty.title'), t('character.detail.importEmpty.body'));
        return;
      }

      const patch = buildCharacterPatch(parsed);
      // 先让用户选择 / 修改 / 新增开场白，再真正落库
      setPendingImport({
        patch,
        treatAsPng,
        assetUri: (asset && asset.uri) || '',
        large: isLargeImport(assetSize || buffer.length),
        size: assetSize || buffer.length,
        candidates: listGreetingCandidates(parsed.fields || {}),
      });
    } finally {
      setImporting(false);
      setImportStatus(null);
    }
  };

  const confirmImport = async result => {
    const pending = pendingImport;
    if (!pending) return;
    const next = {
      ...pending.patch,
      firstMes: result.firstMes,
      alternateGreetings: result.alternateGreetings,
    };
    setImporting(true);
     setImportStatus({
       phase: 'saving',
       large: !!pending.large,
       size: Number(pending.size) || 0,
     });
     let importedImageUri = '';
     try {

      const created = await addCharacter(next);
      setPendingImport(null);
      const profile = await getUserProfile().catch(() => ({}));
      const openingTemplate = String(result.firstMes || '');
      const openingText = openingTemplate.replace(/\{\{user\}\}/g, () => String(profile.userName || '用户'));
      await ensureCharacterSession(created.id, {
        text: openingText,
        template: openingTemplate,
      }).catch(() => {});

     const session = screenSessionRef.current;
     let imageFailed = false;
     if (pending.treatAsPng && pending.assetUri) {

        try {
          const avatarDir = `${fileSystem.documentDirectory}avatars/`;
          await fileSystem.makeDirectoryAsync(avatarDir, { intermediates: true });
           const dest = `${avatarDir}${created.id}.png`;
           markMediaWrite(dest);
           await fileSystem.copyAsync({ from: pending.assetUri, to: dest });
           importedImageUri = dest;
           await updateCharacter({ id: created.id, avatarUri: dest, bgUri: dest });

          if (screenSessionRef.current === session && session.activeId === created.id) {
            setAvatarPreview(dest);
            setBgPreview(dest);
          }
        } catch (error) {
          if (importedImageUri) {
            fileSystem.deleteAsync(importedImageUri, { idempotent: true }).catch(() => {});
            importedImageUri = '';
          }
          imageFailed = true;
        }
      }

      if (screenSessionRef.current === session && session.activeId === created.id) {
        // 导入新卡后回到人设段（原逻辑是收起世界书/正则折叠区）。
        setSegment('persona');
      }
      const summary = t('character.detail.importSummary.body', {
        name: next.name,
        world: next.worldInfo.length,
        regex: next.regexScripts.length,
        presets: next.presets.length,
        greeting: next.firstMes ? t('character.detail.importSummary.withGreeting') : t('character.detail.importSummary.noGreeting'),
      });
       Alert.alert(
         imageFailed ? t('character.detail.importOk.imageFailTitle') : t('character.detail.importOk.title'),
         imageFailed ? t('character.detail.importOk.imageFailBody', { summary }) : summary
       );
     } catch (error) {
       if (importedImageUri) {
         fileSystem.deleteAsync(importedImageUri, { idempotent: true }).catch(() => {});
       }
       const detail = maskSecrets(error?.message || String(error));

      const message = /角色库仍在恢复中/.test(detail)
        ? t('character.detail.importFail.keepGreeting', { detail })
        : /full|disk|空间|容量/i.test(detail)
          ? t('character.detail.importFail.diskFull')
          : t('character.detail.importFail.storage');
      Alert.alert(t('character.detail.importFail.title'), message);
    } finally {
      setImporting(false);
      setImportStatus(null);
    }
  };

  const readAvatarBytes = async uri => {
    if (!uri) return null;
    try {
      const base64 = await fileSystem.readAsStringAsync(uri, {
        encoding: fileSystem.EncodingType.Base64,
      });
      return Buffer.from(base64, 'base64');
    } catch (error) {
      return null;
    }
  };

  const runExport = async format => {
    if (exportBusyRef.current) return;
    exportBusyRef.current = true;
    setExporting(true);
    try {
      const avatarBytes = format === 'png' ? await readAvatarBytes(editedCharacter.avatarUri) : null;
      const uri = await exportCardFile(editedCharacter, format, avatarBytes);
      const available = await Sharing.isAvailableAsync().catch(() => false);
      if (available) {
        await Sharing.shareAsync(uri, {
          mimeType: format === 'png' ? 'image/png' : 'application/json',
          dialogTitle: t('character.detail.export.dialogTitle'),
        });
      } else {
        Alert.alert(t('character.detail.export.doneTitle'), t('character.detail.export.doneBody', { uri }));
      }
    } catch (error) {
      Alert.alert(t('character.detail.export.failTitle'), maskSecrets((error && error.message) || t('common.error.retryLater')));
    } finally {
      exportBusyRef.current = false;
      setExporting(false);
    }
  };

  const onExport = () => {
    if (exportBusyRef.current || !loaded) return;
    Alert.alert(
      t('character.detail.export.dialogTitle'),
      formDirty
        ? t('character.detail.export.bodyDirty')
        : t('character.detail.export.body'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('character.detail.export.png'), onPress: () => runExport('png') },
        { text: t('character.detail.export.json'), onPress: () => runExport('json') },
      ]
    );
  };

  // 分享面板：打开前先把头像字节读出来（分享 PNG 时要用），读不到就退化为占位图，
  // 与导出 PNG 的行为一致——不能因为头像读不出就让整个分享不可用。
  const onShare = useCallback(async () => {
    if (!loaded || exporting) return;
    setShareAvatarBytes(null);
    setShareOpen(true);
    const bytes = await readAvatarBytes(editedCharacter && editedCharacter.avatarUri);
    if (bytes) setShareAvatarBytes(bytes);
  }, [editedCharacter, exporting, loaded]);

  // 从剪贴板导入分享码：本应用没有内置扫码器，对方用任意扫码工具读出文本后
  // 回到这里粘贴，等价于「扫码导入」。走与文件导入完全相同的一条落库路径。
  const importFromClipboard = useCallback(async () => {
    if (importing || !loaded) return;
    let text = '';
    try {
      text = String(await Clipboard.getStringAsync() || '').trim();
    } catch (error) {
      Alert.alert(t('character.share.pasteFail.title'), t('character.share.pasteFail.body'));
      return;
    }
    if (!text) {
      Alert.alert(t('character.share.pasteEmpty.title'), t('character.share.pasteEmpty.body'));
      return;
    }
    if (!isCardShareCode(text)) {
      Alert.alert(t('character.share.pasteInvalid.title'), t('character.share.pasteInvalid.body'));
      return;
    }
    setImporting(true);
    setImportStatus({ phase: 'reading', large: false, size: text.length });
    try {
      let parsed;
      try {
        parsed = parseCardFromJson(decodeCardShareCode(text));
      } catch (error) {
        Alert.alert(t('character.detail.importParseFail.title'), maskSecrets((error && error.message) || t('character.detail.importParseFail.fallback')));
        return;
      }
      if (!hasCardContent(parsed)) {
        Alert.alert(t('character.detail.importEmpty.title'), t('character.detail.importEmpty.body'));
        return;
      }
      const patch = buildCharacterPatch(parsed);
      setPendingImport({
        patch,
        treatAsPng: false,
        assetUri: '',
        large: false,
        size: text.length,
        candidates: listGreetingCandidates(parsed.fields || {}),
      });
    } finally {
      setImporting(false);
      setImportStatus(null);
    }
  }, [importing, loaded, t]);

  return {
    importing,
    importStatus,
    pendingImport,
    setPendingImport,
    exporting,
    shareOpen,
    setShareOpen,
    shareAvatarBytes,
    importCard,
    confirmImport,
    importFromClipboard,
    onExport,
    onShare,
  };
}
