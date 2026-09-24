import { Image } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { validateImageSize } from './attachments';

const STICKER_SCALE = 0.5;

function getImageSize(uri) {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

export async function deleteStickerImage(uri) {
  const value = String(uri || '');
  if (!value.includes('/stickers/')) return;
  try {
    await FileSystem.deleteAsync(value, { idempotent: true });
  } catch (error) {}
}

export async function createStickerImage(uri, sourceWidth = 0, sourceHeight = 0) {
  const sourceUri = String(uri || '');
  if (!sourceUri) throw new Error('图片路径无效');
  const fileInfo = await FileSystem.getInfoAsync(sourceUri);
  validateImageSize({ size: fileInfo && fileInfo.size });
  const size = sourceWidth > 0 && sourceHeight > 0
    ? { width: sourceWidth, height: sourceHeight }
    : await getImageSize(sourceUri);
  validateImageSize({ width: size.width, height: size.height });
  const width = Math.max(1, Math.round((Number(size.width) || 1) * STICKER_SCALE));
  const height = Math.max(1, Math.round((Number(size.height) || 1) * STICKER_SCALE));
  const directory = `${FileSystem.documentDirectory || ''}stickers/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const result = await ImageManipulator.manipulateAsync(
    sourceUri,
    [{ resize: { width, height } }],
    {
      compress: 0.78,
      format: ImageManipulator.SaveFormat.JPEG,
    }
  );
  const destination = `${directory}sticker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  try {
    await FileSystem.copyAsync({ from: result.uri, to: destination });
  } catch (error) {
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
    throw error;
  } finally {
    if (result.uri && result.uri !== destination) {
      await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => {});
    }
  }
  return {
    uri: destination,
    mime: 'image/jpeg',
    width,
    height,
  };
}
