// 角色专属配置存储：每个角色一份「本角色专用的聊天 API / OCR 模型 API / TTS API+音声 /
// 语音转文字 API」。
//
// 为什么独立成键，不塞进角色大对象：角色对象已有 payload 分文件机制
// （storage/characters.js 把长人设拆到独立文件），把运行期配置搅进去会让「编辑角色」
// 与「切模型/换音色」两条写路径互相覆盖（整表覆盖写），而且角色删除时还得记得多清
// 一处。独立键 + onCharacterDeleted 钩子（见文件末尾）把这件事收在同一个模块里。
//
// **密钥纪律**：本模块**不存任何密钥**——只存既有配置的 **id**（apiConfigs 的 id、
// TTS provider 的 id、转写配置的 id）。真正的 key 仍在各自既有保险箱里由 secretStore
// 保护（见 storage/secrets.js 的 SECRET_FIELDS）。上一批刚修过「MCP headers 明文落盘」
// 与「导出备份带明文 token」两条泄漏，不引入第三条的唯一可靠办法就是不自己存密钥：
// 字段名里没有 apiKey/secret/token，脱敏表与保险箱都不需要为本域加例外。
//
// schema 版本：v1。读路径统一过 `normalizeCharacterOverrides`（缺版本按 v1 读、未知
// 字段丢弃、非字符串一律字符串化去空白），因此历史数据读到即等价可用；下一次保存写回
// 同一形状（幂等）。归一化后「全空」= 这个角色没有任何专属配置，保存时直接删条目，
// 不给盘上留空壳。
//
// 语义约定（消费方必须一致，见 character/runtimeConfig.js 的解析层）：
// - 每个 id 字段为 '' = **跟随全局**；
// - `chatModel` / `ocrModel` 只在同组的 `*ApiConfigId` 非空时才有意义（模型属于某条
//   配置）；孤立出现的模型名在归一化时被丢弃，避免「选了模型但没选配置」这种半截状态。

import { onCharacterDeleted } from './characterLifecycle.js';
import { backupCorruptValue, createMutationQueue, readJsonStatus, setJsonRaw } from './io.js';

export const CHARACTER_OVERRIDES_KEY = '@easychat2_character_runtime_overrides';
export const CHARACTER_OVERRIDES_SCHEMA_VERSION = 1;

// 与 schedule.js 同款：整表覆盖写用队列串行化，避免两次并发保存互相覆盖。
const overridesMutation = createMutationQueue();

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

// 归一化（纯函数，Node 可直测）：只保留认识的四组字段，一律字符串化去空白。
export function normalizeCharacterOverrides(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const chatApiConfigId = text(source.chatApiConfigId);
  const ocrApiConfigId = text(source.ocrApiConfigId);
  return {
    version: CHARACTER_OVERRIDES_SCHEMA_VERSION,
    chatApiConfigId,
    // 模型只在选了配置时才有意义：孤立模型名丢弃（见文件头语义约定）。
    chatModel: chatApiConfigId ? text(source.chatModel) : '',
    ocrApiConfigId,
    ocrModel: ocrApiConfigId ? text(source.ocrModel) : '',
    ttsProviderId: text(source.ttsProviderId),
    ttsVoice: text(source.ttsVoice),
    transcriptionConfigId: text(source.transcriptionConfigId),
  };
}

// 是否「全部跟随全局」。用它决定要不要在盘上留条目（不留空壳）。
export function isEmptyCharacterOverrides(overrides) {
  const o = normalizeCharacterOverrides(overrides);
  return !o.chatApiConfigId && !o.ocrApiConfigId && !o.ttsProviderId
    && !o.ttsVoice && !o.transcriptionConfigId;
}

// 被单独配过的项数（0-4）：界面折叠摘要用它做「这个角色被单独配过」的一眼判据。
// 音色与 provider 属同一项（第 3 项），故 ttsVoice 单独出现也只算一项。
export function countCharacterOverrides(overrides) {
  const o = normalizeCharacterOverrides(overrides);
  return [
    o.chatApiConfigId,
    o.ocrApiConfigId,
    o.ttsProviderId || o.ttsVoice,
    o.transcriptionConfigId,
  ].filter(Boolean).length;
}

function normalizeMap(raw) {
  if (raw === null || raw === undefined) return {};
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const result = {};
  Object.keys(source).forEach(key => {
    const id = String(key || '');
    if (!id) return;
    const value = source[key];
    if (!value || typeof value !== 'object') return;
    result[id] = normalizeCharacterOverrides(value);
  });
  return result;
}

export async function getAllCharacterOverrides() {
  const stored = await readJsonStatus(CHARACTER_OVERRIDES_KEY);
  if (stored.status === 'corrupt') {
    // 与 schedule.js 同款：损坏先另存原始值再按「没有配置」处理，避免下次保存
    // 把损坏内容不可逆覆盖（用户逐条选过的配置 id 会丢）。
    await backupCorruptValue(CHARACTER_OVERRIDES_KEY);
    return {};
  }
  return normalizeMap(stored.status === 'ok' ? stored.value : null);
}

// 读单个角色的覆盖；没有则返回「全跟随全局」的空覆盖（调用方不必判 null）。
export async function getCharacterOverrides(characterId) {
  const id = String(characterId || '');
  if (!id) return normalizeCharacterOverrides(null);
  const all = await getAllCharacterOverrides();
  return all[id] || normalizeCharacterOverrides(null);
}

// 保存（整条覆盖写，幂等）：归一化后全空则删条目。
export function saveCharacterOverrides(characterId, overrides) {
  const id = String(characterId || '');
  if (!id) return Promise.resolve(null);
  const normalized = normalizeCharacterOverrides(overrides);
  return overridesMutation.enqueue(async () => {
    const all = await getAllCharacterOverrides();
    const next = { ...all };
    if (isEmptyCharacterOverrides(normalized)) delete next[id];
    else next[id] = normalized;
    await setJsonRaw(CHARACTER_OVERRIDES_KEY, next);
    return normalized;
  });
}

export function deleteCharacterOverrides(characterId) {
  const id = String(characterId || '');
  if (!id) return Promise.resolve(false);
  return overridesMutation.enqueue(async () => {
    const all = await getAllCharacterOverrides();
    if (!all[id]) return false;
    const next = { ...all };
    delete next[id];
    await setJsonRaw(CHARACTER_OVERRIDES_KEY, next);
    return true;
  });
}

async function deleteCharacterOverridesInternal(characterIds) {
  const ids = (Array.isArray(characterIds) ? characterIds : []).map(id => String(id || '')).filter(Boolean);
  if (ids.length === 0) return;
  const all = await getAllCharacterOverrides();
  const next = { ...all };
  let changed = false;
  ids.forEach(id => {
    if (next[id]) {
      delete next[id];
      changed = true;
    }
  });
  if (!changed) return;
  await setJsonRaw(CHARACTER_OVERRIDES_KEY, next);
}

// 角色删除时清理其专属配置（谁的数据谁负责，见 storage/characterLifecycle.js）。
onCharacterDeleted('characterRuntimeOverrides', deleteCharacterOverridesInternal);
