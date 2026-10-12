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

// 转写配置的**三态读**：getTranscriptionSettings 与写路径守卫共用这一个判定函数
// （**唯一**判据来源，不许在别处再写一份）。
//
// 为什么必须共用：save 走 setJsonWithSecrets 做**整键覆盖**，而 getter 在读不出时抛错。
// 两处判据一旦不一致，就会出现「getter 说这份数据不可用、守卫说可以写」——保存把用户配好的
// 转写服务（含 API Key 引用）静默清空。判据的**两半后果同族**，所以都折进同一个 'corrupt'：
//   corrupt  —— 读不出/JSON 解析失败（readJsonStatus 的三态之一）；
//   形状异常 —— status=ok 但解析结果不是普通对象（null / 数组 / 字符串 / 数字）：
//               normalizeTranscriptionSettings 只会把它当空配置，等于用户的配置没了。
//
// 形态照 src/storage/settings/mcpServers.js:188-198（readMcpServersStatus）：把形状判据
// 折进 status，status 只交给写路径判定「这次能不能写回」；同型见 src/storage/worldMap.js:19-27。
// missing（键不存在 = 首次配置）与 ok+普通对象都不算不可用：照常读默认值 / 照常写。
async function readTranscriptionStatus() {
  const stored = await readJsonStatusWithSecrets(TRANSCRIPTION_KEY);
  if (
    stored.status === 'corrupt'
    || (stored.status === 'ok' && (stored.value === null || typeof stored.value !== 'object' || Array.isArray(stored.value)))
  ) {
    // 覆盖不可逆，先留原始字节的副本再交给调用方拒绝（读、写两条路径都经这里）。
    await backupCorruptValue(TRANSCRIPTION_KEY);
    return { status: 'corrupt' };
  }
  if (stored.status === 'missing') return { status: 'missing' };
  return { status: 'ok', value: stored.value };
}

export async function getTranscriptionSettings() {
  const status = await readTranscriptionStatus();
  if (status.status === 'corrupt') throw new Error(tActive('error.storage.transcriptionSettingsReadFailed'));
  if (status.status === 'missing') return normalizeTranscriptionSettings(null);
  return normalizeTranscriptionSettings(status.value);
}

// 写路径守卫（变体①：拒绝写回 / 抛错）。
// 参考 src/storage/settings/chatOptions.js:26-33（assertReadableForMutation）：
// 「读不出原值就不写」，与同目录其他整键覆盖的设置键保持同一判据。
//
// 为什么转写配置需要它：getter 在损坏时是 backupCorruptValue 后**抛错**，而 save 是整键覆盖。
// 于是只要有一次读失败，面板一旦保存就会把用户配好的转写服务（含 API Key 引用）静默清空——
// 面板侧的 `if (!loaded)` 守卫只挡得住「本次没读成功就保存」，挡不住别处触发的写。
// 存储层这道守卫是第二重，且与 getter 共用 readTranscriptionStatus：**判据一致**，
// 不会出现「读路径认为不可用、写路径认为可写」。备份也由它统一做，这里只负责中止。
async function assertReadableForMutation() {
  const status = await readTranscriptionStatus();
  if (status.status === 'corrupt') {
    throw new Error(tActive('error.storage.transcriptionSettingsReadFailed'));
  }
}

export async function saveTranscriptionSettings(settings) {
  await assertReadableForMutation();
  const normalized = normalizeTranscriptionSettings(settings);
  await setJsonWithSecrets(TRANSCRIPTION_KEY, normalized);
  return normalized;
}
