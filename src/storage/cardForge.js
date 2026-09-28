// 制卡草稿（card forge）存储领域。从 src/storage.js 原样外提（无行为变化）。
// 草稿超过内联阈值时落文件，AsyncStorage 只存文件描述符；读取时再回读文件。

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';

import { FORGE_FIELDS, FORGE_QUESTIONS, MAX_PRESERVED_ITEMS, MAX_PRESERVED_TEXT } from '../cardForge/forge.js';
import { normalizeCharacterPresets } from '../characterPresets.js';
import { backupCorruptValue, readJsonStatus, utf8ByteLength } from './io.js';

const CARD_FORGE_KEY = '@easychat2_card_forge';
const CARD_FORGE_PAYLOAD_DIRECTORY = 'card-forge';
const CARD_FORGE_PAYLOAD_VERSION = 1;
const CARD_FORGE_INLINE_LIMIT_BYTES = 512 * 1024;

let cardForgeWriteQueue = Promise.resolve();

function cardForgePayloadDirectory() {
  return `${FileSystem.documentDirectory || FileSystem.cacheDirectory || ''}${CARD_FORGE_PAYLOAD_DIRECTORY}/`;
}

function cardForgePayloadPath(fileName) {
  return `${cardForgePayloadDirectory()}${String(fileName || '')}`;
}

function isCardForgePayloadDescriptor(value) {
  return !!(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.storage === 'file'
    && value.version === CARD_FORGE_PAYLOAD_VERSION
    && value.fileName
  );
}

async function writeCardForgePayload(state) {
  const serialized = JSON.stringify(state);
  if (utf8ByteLength(serialized) <= CARD_FORGE_INLINE_LIMIT_BYTES) {
    return { value: serialized, fileName: '' };
  }
  const fileName = `forge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`;
  await FileSystem.makeDirectoryAsync(cardForgePayloadDirectory(), { intermediates: true });
  const uri = cardForgePayloadPath(fileName);
  try {
    await FileSystem.writeAsStringAsync(uri, serialized, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch (error) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    throw error;
  }
  return {
    value: JSON.stringify({
      storage: 'file',
      version: CARD_FORGE_PAYLOAD_VERSION,
      fileName,
    }),
    fileName,
  };
}

async function readCardForgePayload(value) {
  if (!isCardForgePayloadDescriptor(value)) {
    return { status: 'ok', value };
  }
  try {
    const serialized = await FileSystem.readAsStringAsync(cardForgePayloadPath(value.fileName));
    return { status: 'ok', value: JSON.parse(serialized) };
  } catch (error) {
    return { status: 'corrupt', value: null };
  }
}

async function deleteCardForgePayload(fileName) {
  if (!fileName) return;
  await FileSystem.deleteAsync(cardForgePayloadPath(fileName), { idempotent: true }).catch(() => {});
}

function normalizeForgeDraft(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const draft = {};
  FORGE_FIELDS.forEach(key => {
    draft[key] = String(source[key] || '').slice(0, MAX_PRESERVED_TEXT);
  });
  draft.tags = Array.isArray(source.tags)
    ? source.tags.map(item => String(item || '').trim()).filter(Boolean).slice(0, MAX_PRESERVED_ITEMS)
    : [];
  // 这几个字段不参与 AI 改写，但要随草稿一起持久化，保证「角色 → 制卡 → 角色」往返不丢内容
  draft.systemPrompt = String(source.systemPrompt || '').slice(0, MAX_PRESERVED_TEXT);
  draft.alternateGreetings = Array.isArray(source.alternateGreetings)
    ? source.alternateGreetings.map(item => String(item || '')).filter(item => item.trim()).slice(0, MAX_PRESERVED_ITEMS)
    : [];
  draft.worldInfo = Array.isArray(source.worldInfo)
    ? source.worldInfo.filter(item => item && typeof item === 'object').slice(0, MAX_PRESERVED_ITEMS)
    : [];
  draft.regexScripts = Array.isArray(source.regexScripts)
    ? source.regexScripts.filter(item => item && typeof item === 'object').slice(0, MAX_PRESERVED_ITEMS)
    : [];
  draft.presets = normalizeCharacterPresets(source.presets).slice(0, MAX_PRESERVED_ITEMS);
  return draft;
}

function normalizeForgeTranscript(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter(item => item && typeof item === 'object')
    .map((item, index) => ({
      id: String(item.id || `forge-${index}`),
      role: item.role === 'ai' || item.role === 'user' ? item.role : 'note',
      text: String(item.text || '').slice(0, 4000),
      questionId: String(item.questionId || ''),
      createdAt: Number(item.createdAt) || 0,
    }))
    .filter(item => item.text)
    .slice(-200);
}

function normalizeCardForgeState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!source) return null;
  const sourceAnswers = source.answers && typeof source.answers === 'object' ? source.answers : {};
  const answers = {};
  FORGE_QUESTIONS.forEach(question => {
    const value = String(sourceAnswers[question.id] || '').slice(0, 600);
    if (value) answers[question.id] = value;
  });
  return {
    version: 1,
    step: Math.min(
      Math.max(0, Math.trunc(Number(source.step)) || 0),
      FORGE_QUESTIONS.length
    ),
    answers,
    draft: normalizeForgeDraft(source.draft),
    transcript: normalizeForgeTranscript(source.transcript),
    updatedAt: Number(source.updatedAt) || 0,
  };
}

async function getCardForgeStatusInternal() {
  const stored = await readJsonStatus(CARD_FORGE_KEY);
  if (stored.status === 'missing') return { status: 'missing', state: null };
  const payload = await readCardForgePayload(stored.value);
  if (payload.status === 'corrupt') {
    await backupCorruptValue(CARD_FORGE_KEY);
    return { status: 'corrupt', state: null };
  }
  const invalidShape = !payload.value
    || typeof payload.value !== 'object'
    || Array.isArray(payload.value);
  if (invalidShape) {
    await backupCorruptValue(CARD_FORGE_KEY);
    return { status: 'corrupt', state: null };
  }
  return { status: 'ok', state: normalizeCardForgeState(payload.value) };
}

export function getCardForgeStatus() {
  const task = cardForgeWriteQueue.then(() => getCardForgeStatusInternal());
  cardForgeWriteQueue = task.then(() => undefined, () => undefined);
  return task;
}

export async function getCardForge() {
  const { state } = await getCardForgeStatus();
  return state;
}

async function saveCardForgeInternal(state) {
  const status = await getCardForgeStatusInternal();
  if (status.status === 'corrupt') {
    throw new Error('制卡草稿读取失败，请先处理损坏数据');
  }
  const normalized = normalizeCardForgeState(state);
  if (!normalized) throw new Error('制卡状态无效');
  let previousFileName = '';
  try {
    const previousRaw = await AsyncStorage.getItem(CARD_FORGE_KEY);
    const previous = previousRaw ? JSON.parse(previousRaw) : null;
    if (isCardForgePayloadDescriptor(previous)) previousFileName = String(previous.fileName || '');
  } catch (error) {}
  const payload = await writeCardForgePayload(normalized);
  try {
    await AsyncStorage.setItem(CARD_FORGE_KEY, payload.value);
  } catch (error) {
    await deleteCardForgePayload(payload.fileName);
    throw error;
  }
  if (previousFileName && previousFileName !== payload.fileName) {
    await deleteCardForgePayload(previousFileName);
  }
  return normalized;
}

export function saveCardForge(state) {
  const task = cardForgeWriteQueue.then(() => saveCardForgeInternal(state));
  cardForgeWriteQueue = task.catch(() => {});
  return task;
}

async function clearCardForgeInternal() {
  await AsyncStorage.removeItem(CARD_FORGE_KEY);
  let names = [];
  try {
    names = await FileSystem.readDirectoryAsync(cardForgePayloadDirectory());
  } catch (error) {
    return;
  }
  await Promise.all((names || [])
    .filter(name => String(name).endsWith('.json'))
    .map(name => FileSystem.deleteAsync(cardForgePayloadPath(name), { idempotent: true }).catch(error => {
      if (__DEV__) console.warn('[cardForge] payload cleanup failed', error);
    })));
}

export function clearCardForge() {
  const task = cardForgeWriteQueue.then(() => clearCardForgeInternal());
  cardForgeWriteQueue = task.catch(() => {});
  return task;
}