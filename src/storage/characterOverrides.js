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
//
// **读/写两条路径的读函数必须分开**（P0-2）：读路径遇到损坏要「另存副本 + 按空处理」
// （界面不能因为一个坏键就整页报错），而写路径是整表覆盖写，损坏时必须抛错中止
// （否则一次「改一项」会把该角色其余专属配置连同其他角色的一起清掉）。
// 详见 readAllCharacterOverridesStatus / readAllCharacterOverridesForMutation 的注释。

import { onCharacterDeleted } from './characterLifecycle.js';
import { backupCorruptValue, createMutationQueue, readJsonStatus, setJsonRaw } from './io.js';
import { tActive } from '../i18n/index.js';

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

// 读整表 + 状态（**唯一读实现**）：ok / missing / corrupt。
// corrupt 时先另存原始值再按「没有配置」处理——直接用空表覆盖是不可逆的，
// 留一份副本至少给用户（或后续版本）留下人工恢复的机会。
async function readAllCharacterOverridesStatus() {
  const stored = await readJsonStatus(CHARACTER_OVERRIDES_KEY);
  if (stored.status === 'corrupt') {
    await backupCorruptValue(CHARACTER_OVERRIDES_KEY);
    return { status: 'corrupt', all: {} };
  }
  if (stored.status === 'missing') return { status: 'missing', all: {} };
  return { status: 'ok', all: normalizeMap(stored.value) };
}

// 读整表（**写路径专用**）：corrupt 时**抛错**，绝不按「空」处理。
//
// 为什么必须与读路径分开：三个写函数都是「整表覆盖写」（setJsonRaw 写的是 next
// 全量），复用一个「损坏按空处理」的读函数就等于「用只含当前这一条的表覆盖整表」——
// 该角色其余专属配置被静默清掉，而上面的注释明确承诺过「避免不可逆覆盖」。
// 先例：storage/moments.js:224-230 的 readMomentsForMutation（同形，同样抛错）；
// storage/schedule.js 的 corrupt 分支之所以无害，恰恰因为它的读函数不被写路径复用
// ——正确边界就是「读函数不供写路径复用」。
// 对照 storage/sessionLibrary.js:140-156 的既有纪律：任何「解析结果与盘上不同」的
// 判断都建立在「盘上真的没设过」这个**未被证明**的前提上，所以 corrupt 一律不写。
// 这里也不调 backupCorruptValue：备份是读路径的既有行为，写路径的职责是一个字都不写。
async function readAllCharacterOverridesForMutation() {
  const stored = await readJsonStatus(CHARACTER_OVERRIDES_KEY);
  if (stored.status === 'corrupt') {
    throw new Error(tActive('character.overrides.readFailed'));
  }
  return normalizeMap(stored.status === 'ok' ? stored.value : null);
}

export async function getAllCharacterOverrides() {
  const { all } = await readAllCharacterOverridesStatus();
  return all;
}

// 读单个角色的覆盖；没有则返回「全跟随全局」的空覆盖（调用方不必判 null）。
export async function getCharacterOverrides(characterId) {
  const id = String(characterId || '');
  if (!id) return normalizeCharacterOverrides(null);
  const { all } = await readAllCharacterOverridesStatus();
  return all[id] || normalizeCharacterOverrides(null);
}

// 界面用的**三态**读（先例：storage/worldMap.js:19-27 的 getWorldMapStatus）：
// - 'ok'      ：该角色确实配过（overrides 是它那一条）；
// - 'missing' ：没配过（可以放心写回）；
// - 'corrupt' ：整表读不出来。**绝不能当成「没配过」**：界面若照空表渲染成
//   「配过 0 项」，用户接着改任一项就会把该角色其余专属配置覆盖掉（P1-4）。
export async function getCharacterOverridesStatus(characterId) {
  const id = String(characterId || '');
  if (!id) return { status: 'missing', overrides: normalizeCharacterOverrides(null) };
  const { status, all } = await readAllCharacterOverridesStatus();
  if (status === 'corrupt') return { status: 'corrupt', overrides: normalizeCharacterOverrides(null) };
  if (!all[id]) return { status: 'missing', overrides: normalizeCharacterOverrides(null) };
  return { status: 'ok', overrides: all[id] };
}

// 保存（整条覆盖写，幂等）：归一化后全空则删条目。
// 读整表走 ForMutation：损坏时抛错中止，不用「只含这一条」的表覆盖整表（P0-2）。
export function saveCharacterOverrides(characterId, overrides) {
  const id = String(characterId || '');
  if (!id) return Promise.resolve(null);
  const normalized = normalizeCharacterOverrides(overrides);
  return overridesMutation.enqueue(async () => {
    const all = await readAllCharacterOverridesForMutation();
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
    const all = await readAllCharacterOverridesForMutation();
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
  const all = await readAllCharacterOverridesForMutation();
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
