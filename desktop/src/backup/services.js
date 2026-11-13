// 桌面导入导出的编排层：整库备份与角色卡，全部复用共享层实现。
//
// 文件进出口的分工（见 electron/ipc/backupFiles.js）：
//   · 导出：共享层写到 documents/cache 内的临时文件 -> 主进程「另存为」复制出去；
//   · 导入：主进程把用户选中的文件复制进 cache -> 共享层流式读取/解析。
// 渲染层拿不到对话框选中的外部路径，也不具备任意路径读写能力。
import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';
import * as FileSystemNext from 'expo-file-system';

import { exportBackup, importBackup } from '../../../src/storage/backup.js';
import { readBackupText } from '../../../src/storage/backupRead.js';
import { exportCardFile } from '../../../src/character/cardExporter.js';
import { parseCardFromJson, parseCardFromPng } from '../../../src/character/cardParser.js';
import {
  MAX_IMPORT_BYTES,
  buildCharacterPatch,
  hasCardContent,
  isPngBuffer,
} from '../../../src/character/cardHelpers.js';
import { getUserProfile } from '../../../src/storage/personas.js';
import { markMediaWrite } from '../../../src/storage/mediaProtection.js';
import { getBridge } from '../platform/bridge.js';
import { documentDirectory } from '../platform/fileSystem.js';

function codedError(code, messageKey) {
  const error = new Error(messageKey || code);
  error.code = code;
  return error;
}

export async function exportBackupToFile({ mode = 'full', includeSecrets = false, onProgress } = {}) {
  const info = await getBridge().app.info().catch(() => ({}));
  const exported = await exportBackup({
    appVersion: String(info.version || ''),
    mode,
    includeSecrets: includeSecrets === true,
    onProgress,
  });
  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `easychat2-backup-${stamp}.json`;
  let saved = { canceled: true, path: '' };
  try {
    saved = await getBridge().backup.saveAs(exported.uri, fileName, [{ name: 'JSON', extensions: ['json'] }]);
  } finally {
    getBridge().fs.delete(exported.uri, true).catch(() => {});
  }
  return { ...exported, canceled: !!saved.canceled, savedPath: saved.path || '' };
}

export async function importBackupFromFile({ mode = 'merge', onProgress } = {}) {
  const picked = await getBridge().backup.pick();
  if (!picked || picked.canceled) return { canceled: true };
  if (picked.error) throw codedError(picked.error);
  try {
    const read = await readBackupText({
      uri: picked.uri,
      legacyFs: FileSystem,
      nextFs: FileSystemNext,
      onProgress,
    });
    let payload = null;
    try {
      payload = JSON.parse(read.text);
    } catch (error) {
      throw codedError('PARSE');
    }
    const result = await importBackup(payload, mode);
    return { canceled: false, read, result };
  } finally {
    getBridge().fs.delete(picked.uri, true).catch(() => {});
  }
}

export async function pickCharacterCard() {
  const picked = await getBridge().backup.pickCard();
  if (!picked || picked.canceled) return { canceled: true };
  if (picked.error) throw codedError(picked.error);
  const buffer = Buffer.from(String(picked.base64 || ''), 'base64');
  if (buffer.length > MAX_IMPORT_BYTES) throw codedError('TOO_LARGE');
  const isPng = picked.extension === 'png' || isPngBuffer(buffer);
  let parsed = null;
  try {
    parsed = isPng ? parseCardFromPng(buffer) : parseCardFromJson(buffer.toString('utf8'));
  } catch (error) {
    const failure = codedError('PARSE');
    failure.detail = String((error && error.message) || error);
    throw failure;
  }
  if (isPng && parsed === null) return { canceled: false, empty: true };
  if (!hasCardContent(parsed)) return { canceled: false, empty: true };
  return {
    canceled: false,
    empty: false,
    isPng,
    patch: buildCharacterPatch(parsed),
    base64: String(picked.base64 || ''),
    fileName: picked.name || '',
  };
}

// 落库：addCharacter -> 开场白会话 -> PNG 头像。任何一步失败由调用方提示。
export async function applyCharacterCard(card, { addCharacter, ensureCharacterSession, updateCharacter }) {
  const created = await addCharacter(card.patch);
  const profile = await getUserProfile().catch(() => ({}));
  const template = String(card.patch.firstMes || '');
  const opening = template.replace(/\{\{user\}\}/g, () => String(profile.userName || '用户'));
  await ensureCharacterSession(created.id, { text: opening, template }).catch(() => {});
  let avatarUri = '';
  if (card.isPng && card.base64) {
    const destination = `${documentDirectory}avatars/${created.id}.png`;
    await getBridge().fs.write(destination, card.base64, 'base64');
    markMediaWrite(destination);
    avatarUri = destination;
    await updateCharacter({ id: created.id, avatarUri: destination, bgUri: destination });
  }
  return { created, avatarUri };
}

export async function exportCharacterCard(character, format) {
  let avatarBytes = null;
  if (format === 'png' && character && character.avatarUri) {
    try {
      const base64 = await getBridge().fs.read(character.avatarUri, 'base64');
      avatarBytes = Buffer.from(base64, 'base64');
    } catch (error) {
      // 头像读不出也要能导出：cardExporter 会退回占位 PNG（与 Android 同口径）。
      avatarBytes = null;
    }
  }
  const temporaryUri = await exportCardFile(character, format, avatarBytes);
  const fileName = String(temporaryUri).split('/').pop() || `character.${format}`;
  let saved = { canceled: true, path: '' };
  try {
    saved = await getBridge().backup.saveAs(temporaryUri, fileName, [{
      name: format === 'png' ? 'PNG' : 'JSON',
      extensions: [format],
    }]);
  } finally {
    getBridge().fs.delete(temporaryUri, true).catch(() => {});
  }
  return { canceled: !!saved.canceled, path: saved.path || '' };
}
