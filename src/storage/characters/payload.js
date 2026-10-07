// 角色库存储领域：大角色正文的文件负载读写。
// 从 src/storage/characters.js 原样外提（无行为变化）。
// 角色按 id 拆键存储；大角色正文落到文件，AsyncStorage 只保留小型描述符。

import * as FileSystem from 'expo-file-system/legacy';

import { utf8ByteLength } from '../io.js';

const CHARACTER_PAYLOAD_DIRECTORY = 'characters';
export const CHARACTER_PAYLOAD_FILE_VERSION = 1;
const CHARACTER_INLINE_LIMIT_BYTES = 512 * 1024;

export const CHARACTER_ITEM_PREFIX = '@easychat2_character_item';

export function characterItemKey(id) {
  return `${CHARACTER_ITEM_PREFIX}::${String(id)}`;
}

export function characterPayloadDirectory() {
  return `${FileSystem.documentDirectory || FileSystem.cacheDirectory || ''}${CHARACTER_PAYLOAD_DIRECTORY}/`;
}

export function characterPayloadPath(fileName) {
  return `${characterPayloadDirectory()}${String(fileName || '')}`;
}

function characterIdHash(id) {
  const text = String(id || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function characterPayloadFileName(id) {
  return `${characterIdHash(id)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`;
}

function isCharacterPayloadDescriptor(value) {
  return !!(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.storage === 'file'
    && value.version === CHARACTER_PAYLOAD_FILE_VERSION
    && value.id != null
    && value.fileName
  );
}

export async function writeCharacterPayload(character) {
  const serialized = JSON.stringify(character);
  if (utf8ByteLength(serialized) <= CHARACTER_INLINE_LIMIT_BYTES) {
    return { value: serialized, fileName: '' };
  }
  const fileName = characterPayloadFileName(character.id);
  await FileSystem.makeDirectoryAsync(characterPayloadDirectory(), { intermediates: true });
  try {
    await FileSystem.writeAsStringAsync(characterPayloadPath(fileName), serialized, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch (error) {
    await FileSystem.deleteAsync(characterPayloadPath(fileName), { idempotent: true }).catch(() => {});
    throw error;
  }
  return {
    value: JSON.stringify({
      storage: 'file',
      version: CHARACTER_PAYLOAD_FILE_VERSION,
      id: String(character.id),
      fileName,
    }),
    fileName,
  };
}

export async function cleanupCharacterPayloadFiles(activeNames) {
  try {
    const names = await FileSystem.readDirectoryAsync(characterPayloadDirectory());
    await Promise.all((names || [])
      .filter(name => String(name).endsWith('.json') && !activeNames.has(String(name)))
      .map(name => FileSystem.deleteAsync(characterPayloadPath(name), { idempotent: true })));
  } catch (error) {}
}

export async function readCharacterPayload(value) {
  if (!isCharacterPayloadDescriptor(value)) {
    return { status: 'ok', value };
  }
  try {
    const serialized = await FileSystem.readAsStringAsync(characterPayloadPath(value.fileName), {
      encoding: FileSystem.EncodingType.UTF8,
    });
    return { status: 'ok', value: JSON.parse(serialized) };
  } catch (error) {
    return { status: 'unreadable', value: null };
  }
}
