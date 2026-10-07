// 语音播报（TTS）与语音转写（STT）配置存储：多配置 + 密钥保险箱。
// 从 src/storage/settings.js 原样外提（无行为变化）。

import {
  backupCorruptValue,
  readJsonStatusWithSecrets,
  setJsonWithSecrets,
} from '../io.js';
import { tActive } from '../../i18n/index.js';

const TTS_KEY = '@easychat2_tts';
const TRANSCRIPTION_KEY = '@easychat2_transcription';

const DEFAULT_TTS = { autoBroadcast: false, activeProvider: 'system', providers: {} };

function normalizeTtsProvider(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  Object.entries(source).forEach(([key, value]) => {
    result[String(key)] = value === undefined || value === null ? '' : String(value);
  });
  return result;
}

function normalizeTts(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const providers = {};
  const list = source.providers && typeof source.providers === 'object' && !Array.isArray(source.providers)
    ? source.providers
    : {};
  Object.entries(list).forEach(([id, value]) => {
    providers[String(id)] = normalizeTtsProvider(value);
  });
  // 历史字段 enabled 语义是「自动播报开关」，迁移到 autoBroadcast；
  // 手动播报不再受该开关限制，因此这里只保留自动播报这一个开关。
  const autoBroadcast = source.autoBroadcast !== undefined
    ? source.autoBroadcast === true
    : source.enabled === true;
  return {
    autoBroadcast,
    activeProvider: String(source.activeProvider || DEFAULT_TTS.activeProvider),
    providers,
  };
}

export async function getTtsSettings() {
  // 损坏保护与同仓其他模块一致：先备份原始值再抛错。
  // 直接回落默认值会让面板保存时用默认覆盖损坏数据，属不可逆丢失。
  const stored = await readJsonStatusWithSecrets(TTS_KEY);
  if (
    stored.status === 'corrupt'
    || (stored.status === 'ok' && (stored.value === null || typeof stored.value !== 'object' || Array.isArray(stored.value)))
  ) {
    await backupCorruptValue(TTS_KEY);
    throw new Error(tActive('error.storage.ttsSettingsReadFailed'));
  }
  if (stored.status === 'missing') return normalizeTts(null);
  return normalizeTts(stored.value);
}

export async function saveTtsSettings(settings) {
  const normalized = normalizeTts(settings);
  await setJsonWithSecrets(TTS_KEY, normalized);
  return normalized;
}

// 语音转文字（STT）配置：与 vector / imageGen 同构的多配置 + 密钥保险箱。
// activeId 为 '' 表示「不使用独立配置，仅复用当前聊天来源」（默认，需求 4.5）。
export function normalizeTranscriptionSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(source.configs) ? source.configs : [];
  const configs = list
    .map(item => ({
      id: String((item && item.id) || ''),
      name: String((item && item.name) || '').trim(),
      baseUrl: String((item && item.baseUrl) || '').trim(),
      apiKey: String((item && item.apiKey) || ''),
      model: String((item && item.model) || '').trim() || 'whisper-1',
      // 保留厂商来源：TranscriptionPanel 用它命中预设、显示「获取密钥」链接；
      // 丢掉后只剩 baseUrl 相等兜底，用户改过地址就再也找不到密钥链接。
      vendorId: String((item && item.vendorId) || ''),
    }))
    .filter(item => item.id);
  const activeId = configs.some(item => item.id === source.activeId)
    ? String(source.activeId)
    : '';
  return { activeId, configs };
}

export async function getTranscriptionSettings() {
  const stored = await readJsonStatusWithSecrets(TRANSCRIPTION_KEY);
  if (
    stored.status === 'corrupt'
    || (stored.status === 'ok' && (stored.value === null || typeof stored.value !== 'object' || Array.isArray(stored.value)))
  ) {
    await backupCorruptValue(TRANSCRIPTION_KEY);
    throw new Error(tActive('error.storage.transcriptionSettingsReadFailed'));
  }
  if (stored.status === 'missing') return normalizeTranscriptionSettings(null);
  return normalizeTranscriptionSettings(stored.value);
}

export async function saveTranscriptionSettings(settings) {
  const normalized = normalizeTranscriptionSettings(settings);
  await setJsonWithSecrets(TRANSCRIPTION_KEY, normalized);
  return normalized;
}
